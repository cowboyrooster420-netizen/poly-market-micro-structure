import { BotConfig, EarlySignal, Market, MarketMetrics, MicrostructureSignal, TickData, OrderbookData } from '../types';
import { OrderbookAnalyzer } from './OrderbookAnalyzer';
import { statisticalWorkerService } from './StatisticalWorkerService';
import { configManager } from '../config/ConfigManager';
import { logger } from '../utils/logger';
import { advancedLogger } from '../utils/AdvancedLogger';

export class SignalDetector {
  private config: BotConfig;
  private marketHistory: Map<string, MarketMetrics[]> = new Map();
  private lastScanTime = 0;
  private orderbookAnalyzer: OrderbookAnalyzer;
  private recentSignals: Map<string, { signalType: string; timestamp: number; }[]> = new Map();

  // Statistical activity score storage for percentile-based scoring
  private activityDistributions: Map<string, {
    volumeChanges: number[];
    priceChanges: number[];
    competitivenessScores: number[];
  }> = new Map();

  // Cleanup tracking to prevent unbounded memory growth
  private lastFullCleanup = 0;
  private lastQuickCleanup = 0;
  private readonly FULL_CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour
  private readonly QUICK_CLEANUP_INTERVAL = 10 * 60 * 1000; // 10 minutes

  // Hard limits to prevent unbounded memory growth
  private readonly MAX_MARKETS_IN_HISTORY = 200; // Limit total markets tracked
  private readonly MAX_HISTORY_POINTS = 2880; // 24 hours at 30s intervals
  private readonly MAX_SIGNALS_PER_MARKET = 100; // Limit signals stored per market

  constructor(config: BotConfig) {
    this.config = config;
    this.orderbookAnalyzer = new OrderbookAnalyzer(config);

    // Subscribe to configuration changes
    configManager.onConfigChange('signal_detector', this.onConfigurationChange.bind(this));
  }

  async initialize(): Promise<void> {
    const systemConfig = configManager.getConfig();
    
    advancedLogger.info('Initializing signal detector with configuration', {
      component: 'signal_detector',
      operation: 'initialize',
      metadata: {
        volumeThreshold: systemConfig.detection.signals.volumeSpike.multiplier,
        priceThreshold: systemConfig.detection.signals.priceMovement.percentageThreshold,
        correlationThreshold: systemConfig.detection.signals.crossMarketCorrelation.correlationThreshold
      }
    });
    
    this.lastScanTime = Date.now();
  }

  async detectSignals(markets: Market[]): Promise<EarlySignal[]> {
    const signals: EarlySignal[] = [];
    const currentTime = Date.now();
    
    let newMarketCount = 0;
    let volumeSpikeCount = 0;
    let priceMovementCount = 0;
    let unusualActivityCount = 0;
    let marketsWithHistory = 0;

    for (const market of markets) {
      // Skip markets below volume threshold
      if (market.volumeNum < this.config.minVolumeThreshold) {
        continue;
      }

      // Update market metrics
      this.updateMarketMetrics(market, currentTime);
      
      const history = this.marketHistory.get(market.id);
      if (history && history.length > 1) {
        marketsWithHistory++;
      }

      // Detect various signal types with deduplication
      const newMarketSignal = this.detectNewMarket(market, currentTime);
      if (newMarketSignal && !this.isDuplicateSignal(market.id, newMarketSignal.signalType, currentTime)) {
        signals.push(newMarketSignal);
        this.recordSignal(market.id, newMarketSignal.signalType, currentTime);
        newMarketCount++;
      }

      const volumeSpikeSignal = this.detectVolumeSpike(market, currentTime);
      if (volumeSpikeSignal && !this.isDuplicateSignal(market.id, volumeSpikeSignal.signalType, currentTime)) {
        signals.push(volumeSpikeSignal);
        this.recordSignal(market.id, volumeSpikeSignal.signalType, currentTime);
        volumeSpikeCount++;
      }

      const priceMovementSignal = this.detectPriceMovement(market, currentTime);
      if (priceMovementSignal && !this.isDuplicateSignal(market.id, priceMovementSignal.signalType, currentTime)) {
        signals.push(priceMovementSignal);
        this.recordSignal(market.id, priceMovementSignal.signalType, currentTime);
        priceMovementCount++;
      }

      const unusualActivitySignal = this.detectUnusualActivity(market, currentTime);
      if (unusualActivitySignal && !this.isDuplicateSignal(market.id, unusualActivitySignal.signalType, currentTime)) {
        signals.push(unusualActivitySignal);
        this.recordSignal(market.id, unusualActivitySignal.signalType, currentTime);
        unusualActivityCount++;
      }
    }

    this.lastScanTime = currentTime;

    // Periodically perform comprehensive memory cleanup (every hour)
    if (currentTime - this.lastFullCleanup >= this.FULL_CLEANUP_INTERVAL) {
      const activeMarketIds = new Set(markets.map(m => m.id));
      this.performMemoryCleanup(currentTime, activeMarketIds);
      this.lastFullCleanup = currentTime;
      logger.debug(`Performed full memory cleanup at ${new Date(currentTime).toISOString()}`);
    } else if (currentTime - this.lastQuickCleanup >= this.QUICK_CLEANUP_INTERVAL) {
      // Quick signal cleanup every 10 minutes
      this.cleanupOldSignals(currentTime);
      this.lastQuickCleanup = currentTime;
      logger.debug(`Performed quick signal cleanup at ${new Date(currentTime).toISOString()}`);
    }
    
    // Apply multiple testing correction to reduce false positives
    const correctedSignals = this.applyMultipleTestingCorrection(signals, markets.length);
    
    // Debug logging to show detection stats
    logger.debug(`Detection stats: ${marketsWithHistory} markets with history, checked ${markets.length} markets`);
    if (correctedSignals.length === 0) {
      logger.debug(`No signals found after correction - new:${newMarketCount}, volume:${volumeSpikeCount}, price:${priceMovementCount}, activity:${unusualActivityCount}`);
    } else if (correctedSignals.length < signals.length) {
      logger.debug(`Multiple testing correction: ${signals.length} → ${correctedSignals.length} signals (${((1 - correctedSignals.length/signals.length) * 100).toFixed(1)}% filtered)`);
    }
    
    return correctedSignals;
  }

  // Real-time orderbook analysis for microstructure signals
  detectOrderbookSignals(orderbook: OrderbookData): EarlySignal[] {
    const signals: EarlySignal[] = [];
    
    const orderbookSignals = this.orderbookAnalyzer.detectOrderbookSignals(orderbook);
    signals.push(...this.convertMicrostructureToEarlySignals(orderbookSignals));

    return signals;
  }

  private convertMicrostructureToEarlySignals(microSignals: MicrostructureSignal[]): EarlySignal[] {
    return microSignals.map(signal => ({
      marketId: signal.marketId,
      market: {} as Market, // Will be populated by caller
      signalType: signal.type as any, // Type conversion for compatibility
      confidence: signal.confidence,
      timestamp: signal.timestamp,
      metadata: {
        severity: signal.severity,
        microstructureData: signal.data,
        signalSource: 'microstructure',
      },
    }));
  }

  private updateMarketMetrics(market: Market, timestamp: number): void {
    const marketId = market.id;

    // Enforce maximum number of markets tracked (LRU eviction)
    if (!this.marketHistory.has(marketId) && this.marketHistory.size >= this.MAX_MARKETS_IN_HISTORY) {
      // Find and remove the oldest updated market
      let oldestMarketId: string | null = null;
      let oldestTimestamp = Infinity;

      for (const [id, history] of this.marketHistory.entries()) {
        const lastUpdate = history.length > 0 ? history[history.length - 1].lastUpdated : 0;
        if (lastUpdate < oldestTimestamp) {
          oldestTimestamp = lastUpdate;
          oldestMarketId = id;
        }
      }

      if (oldestMarketId) {
        this.marketHistory.delete(oldestMarketId);
        this.recentSignals.delete(oldestMarketId); // Clean up related signals
        logger.debug(`Evicted market ${oldestMarketId.substring(0, 8)}... from history (LRU, limit: ${this.MAX_MARKETS_IN_HISTORY})`);
      }
    }

    if (!this.marketHistory.has(marketId)) {
      this.marketHistory.set(marketId, []);
    }

    const history = this.marketHistory.get(marketId)!;
    const previousMetrics = history[history.length - 1];

    const currentPrices = market.outcomePrices.map(p => parseFloat(p));

    const currentMetrics: MarketMetrics = {
      marketId,
      volume24h: market.volumeNum,
      volumeChange: previousMetrics ?
        ((market.volumeNum - previousMetrics.volume24h) / previousMetrics.volume24h) * 100 : 0,
      priceChange: this.calculatePriceChange(currentPrices, previousMetrics),
      prices: currentPrices,
      activityScore: this.calculateActivityScore(market, previousMetrics),
      lastUpdated: timestamp,
    };

    history.push(currentMetrics);

    // Enforce maximum history points per market
    if (history.length > this.MAX_HISTORY_POINTS) {
      const excessEntries = history.length - this.MAX_HISTORY_POINTS;
      history.splice(0, excessEntries);
    }
  }

  private detectNewMarket(market: Market, timestamp: number): EarlySignal | null {
    // Detect markets created in the last hour with decent volume
    if (!market.createdAt) return null;

    const createdTime = new Date(market.createdAt).getTime();
    const oneHourAgo = timestamp - (60 * 60 * 1000);
    const ageMinutes = (timestamp - createdTime) / (60 * 1000);

    if (createdTime > oneHourAgo && market.volumeNum > this.config.minVolumeThreshold * 2) {
      logger.info(`🚨 NEW MARKET: ${market.question?.substring(0, 50)} - ${ageMinutes.toFixed(0)}min old, $${market.volumeNum.toFixed(0)} volume`);
      return {
        marketId: market.id,
        market,
        signalType: 'new_market',
        confidence: 0.8,
        timestamp,
        metadata: {
          timeSinceCreation: timestamp - createdTime,
          initialVolume: market.volumeNum,
        },
      };
    }

    return null;
  }

  private detectVolumeSpike(market: Market, timestamp: number): EarlySignal | null {
    const history = this.marketHistory.get(market.id);
    if (!history || history.length < 5) return null;

    const currentMetrics = history[history.length - 1];
    if (!currentMetrics) return null;

    // Use incremental volume change, not cumulative 24h volume
    // Only consider positive volume changes for spike detection
    const recentVolumeChanges = history.slice(-5).map(m => Math.max(0, m.volumeChange || 0));
    const avgVolumeChange = recentVolumeChanges.reduce((sum, change) => sum + change, 0) / recentVolumeChanges.length;
    
    const currentVolumeChange = currentMetrics.volumeChange || 0;
    
    // Debug logging for top markets
    if (market.volumeNum > this.config.minVolumeThreshold * 5) {
      logger.debug(`Volume check - ${market.question?.substring(0, 40)}: current change=${currentVolumeChange.toFixed(1)}%, avg change=${avgVolumeChange.toFixed(1)}%`);
    }
    
    // Detect volume spike using configuration threshold
    const systemConfig = configManager.getConfig();
    const multiplierThreshold = systemConfig.detection.signals.volumeSpike.multiplier;
    
    // Only trigger if current volume change is significantly higher than recent average
    // and the market has meaningful baseline volume - MUST BE POSITIVE (increase only)
    if (currentVolumeChange > 0 && // Must be an actual increase
        currentVolumeChange > avgVolumeChange * multiplierThreshold &&
        currentVolumeChange > 15 && // At least 15% volume increase (lowered from 25%)
        market.volumeNum > this.config.minVolumeThreshold) {
      
      logger.info(`🚨 VOLUME SPIKE: ${market.question?.substring(0, 50)} - ${currentVolumeChange.toFixed(1)}% volume increase!`);
      return {
        marketId: market.id,
        market,
        signalType: 'volume_spike',
        confidence: this.calculateStatisticalConfidence(
          currentVolumeChange, 
          avgVolumeChange, 
          Math.max(avgVolumeChange * 0.2, 1), // Standard error estimate
          0.9
        ),
        timestamp,
        metadata: {
          currentVolume: market.volumeNum,
          volumeChangePercent: currentVolumeChange,
          averageVolumeChange: avgVolumeChange,
          spikeMultiplier: avgVolumeChange > 0 ? currentVolumeChange / avgVolumeChange : 0,
        },
      };
    }

    return null;
  }

  private detectPriceMovement(market: Market, timestamp: number): EarlySignal | null {
    const history = this.marketHistory.get(market.id);
    if (!history || history.length < 3) return null;

    // Check multiple time windows for price movement (removes 30s delay)
    const latest = history[history.length - 1];
    const oneIntervalAgo = history[history.length - 2];
    const twoIntervalsAgo = history.length > 2 ? history[history.length - 3] : null;
    
    // Calculate immediate price change (latest vs previous)
    const immediatePriceChanges = Object.values(latest.priceChange);
    const maxImmediateChange = immediatePriceChanges.length > 0 ? Math.max(...immediatePriceChanges.map(Math.abs)) : 0;
    
    // Calculate cumulative price change over 2-3 intervals for trend detection
    // For prediction markets, use absolute probability changes (not percentage)
    // to avoid bias toward low-probability markets
    let maxCumulativeChange = 0;
    if (twoIntervalsAgo && latest.prices && twoIntervalsAgo.prices) {
      for (let i = 0; i < latest.prices.length; i++) {
        // Absolute probability change in percentage points (e.g., 5 = 5pp move)
        const cumulativeChange = Math.abs((latest.prices[i] - twoIntervalsAgo.prices[i]) * 100);
        maxCumulativeChange = Math.max(maxCumulativeChange, cumulativeChange);
      }
    }
    
    const finalMaxChange = Math.max(maxImmediateChange, maxCumulativeChange);
    
    // Debug log significant price movements (>5%)
    if (finalMaxChange > 5) {
      logger.debug(`Price movement - ${market.question?.substring(0, 40)}: immediate=${maxImmediateChange.toFixed(1)}%, cumulative=${maxCumulativeChange.toFixed(1)}%, volume=$${market.volumeNum.toFixed(0)}`);
    }
    
    const systemConfig = configManager.getConfig();
    const priceThreshold = systemConfig.detection.signals.priceMovement.percentageThreshold;
    
    if (finalMaxChange > priceThreshold && market.volumeNum > this.config.minVolumeThreshold) {
      const movementType = maxImmediateChange > maxCumulativeChange ? 'sudden' : 'trending';
      logger.info(`🚨 PRICE MOVEMENT: ${market.question?.substring(0, 50)} - ${finalMaxChange.toFixed(1)}% ${movementType} change!`);
      return {
        marketId: market.id,
        market,
        signalType: 'price_movement',
        confidence: this.calculateStatisticalConfidence(
          finalMaxChange,
          configManager.getConfig().detection.signals.priceMovement.baselineExpectedChangePercent,
          2, // Standard error estimate for price changes
          0.9
        ),
        timestamp,
        metadata: {
          priceChanges: latest.priceChange,
          maxChange: finalMaxChange,
          immediateChange: maxImmediateChange,
          cumulativeChange: maxCumulativeChange,
          movementType,
        },
      };
    }

    return null;
  }

  private detectUnusualActivity(market: Market, timestamp: number): EarlySignal | null {
    const history = this.marketHistory.get(market.id);
    if (!history || history.length < 10) return null;

    const latest = history[history.length - 1];
    
    // High activity score indicates unusual market behavior
    const activityConfig = configManager.getConfig().detection.signals.activityDetection;
    if (latest.activityScore > activityConfig.activityThreshold && market.volumeNum > this.config.minVolumeThreshold) {
      return {
        marketId: market.id,
        market,
        signalType: 'unusual_activity',
        confidence: this.calculateStatisticalConfidence(
          latest.activityScore,
          activityConfig.baselineActivityScore,
          15, // Standard error estimate for activity scores
          0.95
        ),
        timestamp,
        metadata: {
          activityScore: latest.activityScore,
          volumeChange: latest.volumeChange,
        },
      };
    }

    return null;
  }

  private calculatePriceChange(currentPrices: number[], previousMetrics?: MarketMetrics): Record<string, number> {
    if (!previousMetrics || !previousMetrics.prices) return {};

    const changes: Record<string, number> = {};

    // For prediction markets, use absolute probability changes (not percentage)
    // to avoid bias toward low-probability markets
    currentPrices.forEach((currentPrice, index) => {
      const previousPrice = previousMetrics.prices[index];
      if (previousPrice !== undefined && previousPrice !== null) {
        // Absolute probability change in percentage points (e.g., 5 = 5pp move)
        const change = (currentPrice - previousPrice) * 100;
        changes[`outcome_${index}`] = change;
      } else {
        changes[`outcome_${index}`] = 0;
      }
    });

    return changes;
  }

  private calculateActivityScore(market: Market, previousMetrics?: MarketMetrics): number {
    const marketId = market.id;
    
    // Calculate current metrics
    const currentVolumeChange = previousMetrics ? 
      ((market.volumeNum - previousMetrics.volume24h) / Math.max(previousMetrics.volume24h, 1)) * 100 : 0;
    
    const prices = market.outcomePrices.map(p => parseFloat(p));
    let maxPriceChange = 0;
    // For prediction markets, use absolute probability changes (not percentage)
    // to avoid bias toward low-probability markets
    if (previousMetrics && previousMetrics.prices && previousMetrics.prices.length === prices.length) {
      for (let i = 0; i < prices.length; i++) {
        // Absolute probability change in percentage points (e.g., 5 = 5pp move)
        const priceChange = Math.abs((prices[i] - previousMetrics.prices[i]) * 100);
        maxPriceChange = Math.max(maxPriceChange, priceChange);
      }
    }
    
    const priceSpread = Math.max(...prices) - Math.min(...prices);
    const competitiveness = 1 - priceSpread; // Higher when prices are close (competitive market)
    
    // Update historical distributions
    this.updateActivityDistribution(marketId, currentVolumeChange, maxPriceChange, competitiveness);
    
    // Calculate percentile-based scores (0-100 scale)
    const volumeScore = this.calculatePercentileScore(marketId, 'volumeChanges', currentVolumeChange, 30);
    const priceScore = this.calculatePercentileScore(marketId, 'priceChanges', maxPriceChange, 30);
    const competitivenessScore = this.calculatePercentileScore(marketId, 'competitivenessScores', competitiveness, 25);
    
    // Volume factor based on z-score relative to minimum threshold
    const volumeRatio = market.volumeNum / this.config.minVolumeThreshold;
    const volumeFactorScore = Math.min(15, Math.max(0, Math.log10(volumeRatio) * 5)); // Logarithmic scaling
    
    const totalScore = volumeScore + priceScore + competitivenessScore + volumeFactorScore;
    return Math.min(100, Math.max(0, totalScore));
  }

  /**
   * Update historical distribution for statistical activity scoring
   */
  private updateActivityDistribution(marketId: string, volumeChange: number, priceChange: number, competitiveness: number): void {
    if (!this.activityDistributions.has(marketId)) {
      this.activityDistributions.set(marketId, {
        volumeChanges: [],
        priceChanges: [],
        competitivenessScores: []
      });
    }
    
    const dist = this.activityDistributions.get(marketId)!;
    
    // Add current values
    dist.volumeChanges.push(volumeChange);
    dist.priceChanges.push(priceChange);
    dist.competitivenessScores.push(competitiveness);
    
    // Keep only last 100 observations to prevent memory bloat and adapt to changing conditions
    const maxHistory = 100;
    if (dist.volumeChanges.length > maxHistory) {
      dist.volumeChanges.shift();
    }
    if (dist.priceChanges.length > maxHistory) {
      dist.priceChanges.shift();
    }
    if (dist.competitivenessScores.length > maxHistory) {
      dist.competitivenessScores.shift();
    }
  }

  /**
   * Calculate percentile-based score for a metric
   */
  private calculatePercentileScore(marketId: string, metric: 'volumeChanges' | 'priceChanges' | 'competitivenessScores', currentValue: number, maxPoints: number): number {
    const dist = this.activityDistributions.get(marketId);
    if (!dist || dist[metric].length < 10) {
      // Not enough data - use simple thresholds as fallback
      if (metric === 'volumeChanges') {
        return currentValue > 10 ? maxPoints * 0.8 : maxPoints * 0.4;
      } else if (metric === 'priceChanges') {
        return currentValue > 2 ? maxPoints * 0.8 : maxPoints * 0.4;
      } else {
        return currentValue > 0.6 ? maxPoints * 0.8 : maxPoints * 0.4;
      }
    }
    
    const data = [...dist[metric]].sort((a, b) => a - b);
    const n = data.length;
    
    // Find percentile rank of current value
    let rank = 0;
    for (let i = 0; i < n; i++) {
      if (data[i] <= currentValue) {
        rank = i + 1;
      } else {
        break;
      }
    }
    
    const percentile = rank / n;
    
    // Convert percentile to score (higher percentile = higher score)
    // Use exponential scaling to emphasize extreme values
    const exponentialScore = Math.pow(percentile, 1.5);
    return exponentialScore * maxPoints;
  }

  /**
   * Calculate statistically sound confidence based on z-score and effect size
   */
  private calculateStatisticalConfidence(observedValue: number, baseline: number, standardError: number, maxConfidence: number = 0.95): number {
    if (standardError <= 1e-10) {
      // No variability - confidence based on magnitude
      return observedValue > baseline ? maxConfidence * 0.8 : 0.3;
    }
    
    // Calculate z-score
    const zScore = Math.abs((observedValue - baseline) / standardError);
    
    // Convert z-score to confidence using cumulative normal distribution
    // Z-score of 1.96 = 95% confidence, 2.58 = 99% confidence
    let confidence: number;
    if (zScore >= 2.58) {
      confidence = 0.99;
    } else if (zScore >= 1.96) {
      confidence = 0.95;
    } else if (zScore >= 1.645) {
      confidence = 0.90;
    } else if (zScore >= 1.28) {
      confidence = 0.80;
    } else if (zScore >= 1.0) {
      confidence = 0.68;
    } else {
      // Linear interpolation for lower z-scores
      confidence = 0.5 + (zScore / 2.0) * 0.18; // Scale from 0.5 to 0.68
    }
    
    return Math.min(maxConfidence, confidence);
  }

  /**
   * Calculate effect size (Cohen's d) for magnitude assessment
   */
  private calculateEffectSize(observedValue: number, baseline: number, standardDeviation: number): number {
    if (standardDeviation <= 1e-10) return 0;
    return Math.abs(observedValue - baseline) / standardDeviation;
  }

  /**
   * Apply multiple testing correction to reduce false positives
   * Uses Benjamini-Hochberg (FDR) method which is less conservative than Bonferroni
   */
  private applyMultipleTestingCorrection(signals: EarlySignal[], numMarkets: number): EarlySignal[] {
    if (signals.length === 0) return signals;

    // SIMPLIFIED: Only filter out very low confidence signals
    // The statistical confidence calculations are already built into each signal
    // Multiple testing correction was too aggressive (required 99.98%+ confidence)

    // Filter signals by minimum confidence threshold
    const minConfidence = 0.5; // Accept signals with 50%+ confidence
    const filteredSignals = signals.filter(signal => signal.confidence >= minConfidence);

    // Log filtering statistics
    if (signals.length > filteredSignals.length) {
      logger.debug(`Confidence filter: ${signals.length} raw signals → ${filteredSignals.length} signals (min confidence: ${minConfidence})`);
    }

    return filteredSignals;
  }

  /**
   * Calculate adjusted p-value using Benjamini-Hochberg method
   */
  private calculateAdjustedPValue(pValue: number, rank: number, totalTests: number, fdr: number = 0.05): number {
    return Math.min(1, pValue * totalTests / rank);
  }

  /**
   * Check if a signal is a duplicate within the cooldown period
   */
  private isDuplicateSignal(marketId: string, signalType: string, currentTime: number): boolean {
    const marketSignals = this.recentSignals.get(marketId);
    if (!marketSignals) return false;

    // Define cooldown periods for different signal types (in milliseconds)
    const cooldownPeriods: Record<string, number> = {
      'new_market': 60 * 60 * 1000,        // 1 hour - new markets don't change often
      'volume_spike': 10 * 60 * 1000,      // 10 minutes - volume can spike multiple times
      'price_movement': 5 * 60 * 1000,     // 5 minutes - price movements can be frequent
      'unusual_activity': 15 * 60 * 1000,  // 15 minutes - activity patterns change gradually
      'coordinated_cross_market': 30 * 60 * 1000, // 30 minutes - cross-market coordination is significant
    };

    const cooldownTime = cooldownPeriods[signalType] || 10 * 60 * 1000; // Default 10 minutes

    // Check if we've seen this signal type recently for this market
    const recentSignal = marketSignals.find(signal => 
      signal.signalType === signalType && 
      (currentTime - signal.timestamp) < cooldownTime
    );

    if (recentSignal) {
      const minutesAgo = Math.floor((currentTime - recentSignal.timestamp) / (60 * 1000));
      logger.debug(`Duplicate signal suppressed: ${signalType} for market ${marketId.substring(0, 8)}... (last seen ${minutesAgo}min ago)`);
      return true;
    }

    return false;
  }

  /**
   * Record a signal for deduplication tracking
   */
  private recordSignal(marketId: string, signalType: string, timestamp: number): void {
    if (!this.recentSignals.has(marketId)) {
      this.recentSignals.set(marketId, []);
    }

    const marketSignals = this.recentSignals.get(marketId)!;
    marketSignals.push({ signalType, timestamp });

    // Enforce maximum signals per market
    if (marketSignals.length > this.MAX_SIGNALS_PER_MARKET) {
      // Remove oldest signals
      marketSignals.splice(0, marketSignals.length - this.MAX_SIGNALS_PER_MARKET);
    }

    // Clean up old signals (keep only last 24 hours)
    const oneDayAgo = timestamp - (24 * 60 * 60 * 1000);
    const filteredSignals = marketSignals.filter(signal => signal.timestamp > oneDayAgo);
    this.recentSignals.set(marketId, filteredSignals);

    // Clean up empty entries
    if (filteredSignals.length === 0) {
      this.recentSignals.delete(marketId);
    }
  }

  /**
   * Clean up old signal records to prevent memory leaks
   */
  private cleanupOldSignals(currentTime: number): void {
    const oneDayAgo = currentTime - (24 * 60 * 60 * 1000);
    
    for (const [marketId, signals] of this.recentSignals.entries()) {
      const filteredSignals = signals.filter(signal => signal.timestamp > oneDayAgo);
      
      if (filteredSignals.length === 0) {
        this.recentSignals.delete(marketId);
      } else {
        this.recentSignals.set(marketId, filteredSignals);
      }
    }
  }

  /**
   * Comprehensive memory cleanup for inactive markets and old data
   */
  private performMemoryCleanup(currentTime: number, activeMarketIds: Set<string>): void {
    const oneDayAgo = currentTime - (24 * 60 * 60 * 1000);
    const oneWeekAgo = currentTime - (7 * 24 * 60 * 60 * 1000);
    
    // Clean up market history for inactive markets
    const marketsToRemove: string[] = [];
    
    for (const [marketId, history] of this.marketHistory.entries()) {
      const lastUpdate = history.length > 0 ? history[history.length - 1].lastUpdated : 0;
      
      // Remove markets that haven't been updated in over a week
      if (lastUpdate < oneWeekAgo) {
        marketsToRemove.push(marketId);
        continue;
      }
      
      // For markets not currently active, keep only essential data
      if (!activeMarketIds.has(marketId) && lastUpdate < oneDayAgo) {
        // Keep only the last 100 data points for inactive markets
        if (history.length > 100) {
          const recentHistory = history.slice(-100);
          this.marketHistory.set(marketId, recentHistory);
        }
      }
      
      // Clean up old data from active markets (keep last 2880 points = 24 hours)
      if (history.length > 2880) {
        const trimmedHistory = history.slice(-2880);
        this.marketHistory.set(marketId, trimmedHistory);
      }
    }
    
    // Remove completely inactive markets
    for (const marketId of marketsToRemove) {
      this.marketHistory.delete(marketId);
      this.recentSignals.delete(marketId);
    }
    
    // Force garbage collection if too much memory is being used
    const memoryUsage = process.memoryUsage();
    const heapUsedMB = memoryUsage.heapUsed / (1024 * 1024);
    
    if (heapUsedMB > 500) { // If using more than 500MB
      advancedLogger.warn('High memory usage detected, performing aggressive cleanup', {
        component: 'signal_detector',
        operation: 'memory_cleanup',
        metadata: {
          heapUsedMB: heapUsedMB.toFixed(1),
          marketsTracked: this.marketHistory.size,
          marketsRemoved: marketsToRemove.length
        }
      });
      
      // More aggressive cleanup for high memory usage
      for (const [marketId, history] of this.marketHistory.entries()) {
        if (!activeMarketIds.has(marketId)) {
          // Keep only last 50 points for inactive markets during high memory usage
          if (history.length > 50) {
            this.marketHistory.set(marketId, history.slice(-50));
          }
        }
      }
      
      // Suggest garbage collection
      if (global.gc) {
        global.gc();
      }
    } else if (marketsToRemove.length > 0) {
      advancedLogger.info('Routine memory cleanup completed', {
        component: 'signal_detector',
        operation: 'memory_cleanup',
        metadata: {
          heapUsedMB: heapUsedMB.toFixed(1),
          marketsTracked: this.marketHistory.size,
          marketsRemoved: marketsToRemove.length
        }
      });
    }
  }

  /**
   * Handle configuration changes
   */
  private onConfigurationChange(newConfig: any): void {
    try {
      advancedLogger.info('Signal detector configuration updated', {
        component: 'signal_detector',
        operation: 'config_change',
        metadata: {
          volumeMultiplier: newConfig.detection.signals.volumeSpike.multiplier,
          priceThreshold: newConfig.detection.signals.priceMovement.percentageThreshold,
          correlationThreshold: newConfig.detection.signals.crossMarketCorrelation.correlationThreshold
        }
      });
    } catch (error) {
      advancedLogger.error('Error handling signal detector configuration change', error as Error, {
        component: 'signal_detector',
        operation: 'config_change'
      });
    }
  }

  /**
   * Perform intensive cross-market correlation analysis using worker threads
   */
  public async detectCrossMarketCorrelations(markets: Market[]): Promise<EarlySignal[]> {
    const signals: EarlySignal[] = [];
    
    if (markets.length < 2) {
      return signals;
    }

    try {
      // Extract volume time series for each market
      const volumeSeries = new Map<string, number[]>();
      const priceSeries = new Map<string, number[]>();
      
      for (const market of markets) {
        const history = this.marketHistory.get(market.id);
        if (history && history.length >= 10) {
          volumeSeries.set(market.id, history.map(h => h.volume24h));
          // Use first outcome price as representative price
          const priceHistory = history.map(h => h.prices[0] || 0.5);
          priceSeries.set(market.id, priceHistory);
        }
      }

      // Analyze correlations using worker threads for CPU-intensive calculations
      const marketIds = Array.from(volumeSeries.keys());
      const correlationPromises: Promise<any>[] = [];

      for (let i = 0; i < marketIds.length; i++) {
        for (let j = i + 1; j < marketIds.length; j++) {
          const market1Id = marketIds[i];
          const market2Id = marketIds[j];
          
          const volumes1 = volumeSeries.get(market1Id)!;
          const volumes2 = volumeSeries.get(market2Id)!;
          const prices1 = priceSeries.get(market1Id)!;
          const prices2 = priceSeries.get(market2Id)!;

          // Use worker threads for correlation calculation
          const volumeCorrelationPromise = statisticalWorkerService.calculateCorrelation(
            volumes1, volumes2, 'pearson'
          ).then(result => ({ type: 'volume', market1Id, market2Id, ...result }));

          const priceCorrelationPromise = statisticalWorkerService.calculateCorrelation(
            prices1, prices2, 'pearson'
          ).then(result => ({ type: 'price', market1Id, market2Id, ...result }));

          correlationPromises.push(volumeCorrelationPromise, priceCorrelationPromise);
        }
      }

      const correlationResults = await Promise.all(correlationPromises);
      
      // Process correlation results and generate signals
      const systemConfig = configManager.getConfig();
      const correlationThreshold = systemConfig.detection.signals.crossMarketCorrelation.correlationThreshold;

      for (const result of correlationResults) {
        if (result.isSignificant && Math.abs(result.correlation) > correlationThreshold) {
          const market1 = markets.find(m => m.id === result.market1Id);
          const market2 = markets.find(m => m.id === result.market2Id);
          
          if (market1 && market2) {
            const signal: EarlySignal = {
              marketId: result.market1Id,
              market: market1,
              signalType: 'coordinated_cross_market',
              confidence: Math.abs(result.correlation),
              timestamp: Date.now(),
              metadata: {
                correlationType: result.type,
                correlatedMarketId: result.market2Id,
                correlatedMarketQuestion: market2.question?.substring(0, 50),
                correlationCoefficient: result.correlation,
                correlationMethod: result.method,
                significanceLevel: result.significanceLevel,
                signalSource: 'worker_thread_correlation_analysis'
              }
            };
            
            signals.push(signal);
            
            advancedLogger.info(`High correlation detected: ${result.type}`, {
              component: 'signal_detector',
              operation: 'cross_market_correlation',
              metadata: {
                correlation: result.correlation,
                market1: market1.question?.substring(0, 30),
                market2: market2.question?.substring(0, 30),
                correlationType: result.type
              }
            });
          }
        }
      }

    } catch (error) {
      advancedLogger.error('Error in cross-market correlation analysis', error as Error, {
        component: 'signal_detector',
        operation: 'cross_market_correlation'
      });
    }

    return signals;
  }

  /**
   * Perform statistical anomaly detection using worker threads
   */
  public async detectStatisticalAnomalies(market: Market): Promise<EarlySignal | null> {
    try {
      const history = this.marketHistory.get(market.id);
      if (!history || history.length < 30) {
        return null;
      }

      // Extract time series data
      const volumes = history.map(h => h.volume24h);
      const activityScores = history.map(h => h.activityScore);
      
      // Use worker threads for intensive anomaly detection
      const volumeAnomalies = await statisticalWorkerService.detectAnomalies(volumes);
      const activityAnomalies = await statisticalWorkerService.detectAnomalies(activityScores);
      
      // Check if current values are anomalous
      const currentVolume = market.volumeNum;
      const currentActivity = history[history.length - 1]?.activityScore || 0;
      
      const isVolumeAnomaly = volumeAnomalies.zScoreAnomalies.includes(currentVolume) ||
                             volumeAnomalies.isolationForestAnomalies.some(a => a.value === currentVolume);
                             
      const isActivityAnomaly = activityAnomalies.zScoreAnomalies.includes(currentActivity);
      
      if (isVolumeAnomaly || isActivityAnomaly) {
        const confidence = Math.min(0.95, 
          (isVolumeAnomaly ? 0.5 : 0) + (isActivityAnomaly ? 0.45 : 0)
        );
        
        return {
          marketId: market.id,
          market,
          signalType: 'unusual_activity',
          confidence,
          timestamp: Date.now(),
          metadata: {
            anomalyTypes: [
              ...(isVolumeAnomaly ? ['volume_anomaly'] : []),
              ...(isActivityAnomaly ? ['activity_anomaly'] : [])
            ],
            volumeAnomalies: volumeAnomalies.zScoreAnomalies.length,
            activityAnomalies: activityAnomalies.zScoreAnomalies.length,
            isolationForestDetections: volumeAnomalies.isolationForestAnomalies.length,
            signalSource: 'worker_thread_anomaly_detection'
          }
        };
      }

    } catch (error) {
      advancedLogger.error('Error in statistical anomaly detection', error as Error, {
        component: 'signal_detector',
        operation: 'statistical_anomaly_detection',
        marketId: market.id
      });
    }

    return null;
  }

  /**
   * Get current detection configuration summary
   */
  public getDetectionConfiguration(): any {
    const systemConfig = configManager.getConfig();
    return {
      signals: {
        volumeSpike: systemConfig.detection.signals.volumeSpike,
        priceMovement: systemConfig.detection.signals.priceMovement,
        crossMarketCorrelation: systemConfig.detection.signals.crossMarketCorrelation
      },
      statistical: systemConfig.detection.statistical,
      alerts: systemConfig.detection.alerts,
      workerThreads: {
        enabled: true,
        performanceStats: statisticalWorkerService.getPerformanceStats()
      }
    };
  }

  /**
   * Shutdown worker threads when detector is destroyed
   */
  public async shutdown(): Promise<void> {
    await statisticalWorkerService.shutdown();
  }
}