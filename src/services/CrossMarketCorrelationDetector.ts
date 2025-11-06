import { PriceHistoryTracker } from './PriceHistoryTracker';
import { Market, EarlySignal } from '../types';
import { advancedLogger as logger } from '../utils/AdvancedLogger';

export interface CorrelationSignal {
  markets: string[];
  correlation: number;
  priceChanges: number[];
  volumeIncreases: number[];
  windowMs: number;
  confidence: number;
  leakStartTime?: number;
}

export interface CrossMarketConfig {
  minCorrelation: number;
  correlationWindows: number[];
  minMarketsForSignal: number;
  volumeConfirmationThreshold: number;
  minPriceChangePercent: number;
  baselineWindow: number;
}

/**
 * Detects coordinated price movements across related markets
 * This is a key signal for information leakage - when multiple markets
 * react to non-public information before news is announced
 *
 * Example: Trump + related crypto markets moving together 15 minutes before tariff announcement
 */
export class CrossMarketCorrelationDetector {
  private priceTracker: PriceHistoryTracker;
  private config: CrossMarketConfig;
  private baselineCorrelations: Map<string, number>;

  constructor(priceTracker: PriceHistoryTracker, config?: Partial<CrossMarketConfig>) {
    this.priceTracker = priceTracker;
    this.baselineCorrelations = new Map();

    this.config = {
      minCorrelation: config?.minCorrelation || 0.6, // Lowered from 0.7 to catch weaker coordinated movements
      correlationWindows: config?.correlationWindows || [
        3600000,  // 1 hour
        14400000, // 4 hours
        28800000  // 8 hours
      ],
      minMarketsForSignal: config?.minMarketsForSignal || 3,
      volumeConfirmationThreshold: config?.volumeConfirmationThreshold || 1.5, // 1.5x volume increase
      minPriceChangePercent: config?.minPriceChangePercent || 2, // 2% minimum move
      baselineWindow: config?.baselineWindow || 86400000 // 24 hours for baseline
    };
  }

  /**
   * Detect cross-market information leaks for a group of related markets
   * Returns signal if correlation spike detected
   *
   * PERFORMANCE OPTIMIZATION: Pre-filters markets to reduce O(N²) correlation calculations
   */
  detectCoordinatedMovement(markets: Market[]): CorrelationSignal | null {
    // Need at least minMarketsForSignal to detect coordination
    if (markets.length < this.config.minMarketsForSignal) {
      return null;
    }

    // PERFORMANCE: Filter markets with sufficient price history AND significant movement
    // This dramatically reduces the number of correlation calculations needed
    const activeMarkets = markets.filter(m => {
      // Must have price history
      if (!this.priceTracker.hasSufficientHistory(m.id, 10)) {
        return false;
      }

      // OPTIMIZATION: Only check markets that have moved recently (>1% in last hour)
      const priceChange = Math.abs(this.priceTracker.calculatePriceChange(m.id, 3600000)); // 1 hour
      return priceChange > 1.0; // 1% minimum movement
    });

    if (activeMarkets.length < this.config.minMarketsForSignal) {
      // Not enough actively moving markets - skip expensive correlation checks
      return null;
    }

    // PERFORMANCE: Limit to top 50 most active markets to prevent O(N²) explosion
    // 50 markets = 1,225 correlations vs 500 markets = 124,750 correlations
    const limitedMarkets = activeMarkets
      .sort((a, b) => {
        const changeA = Math.abs(this.priceTracker.calculatePriceChange(a.id, 3600000));
        const changeB = Math.abs(this.priceTracker.calculatePriceChange(b.id, 3600000));
        return changeB - changeA; // Sort by largest price change
      })
      .slice(0, 50); // Top 50 most active

    if (limitedMarkets.length < this.config.minMarketsForSignal) {
      return null;
    }

    logger.info(`Pre-filtered ${markets.length} → ${limitedMarkets.length} active markets for correlation check`, {
      component: 'cross_market_detector',
      operation: 'pre_filter',
      metadata: { originalCount: markets.length, filteredCount: limitedMarkets.length }
    });

    // Test each correlation window
    for (const windowMs of this.config.correlationWindows) {
      const signal = this.detectCorrelationSpike(limitedMarkets, windowMs);
      if (signal) {
        return signal;
      }
    }

    return null;
  }

  /**
   * Detect correlation spike within a specific time window
   */
  private detectCorrelationSpike(markets: Market[], windowMs: number): CorrelationSignal | null {
    const marketIds = markets.map(m => m.id);

    // Calculate pairwise correlations
    const correlations: number[] = [];
    const priceChanges: number[] = [];
    const volumeIncreases: number[] = [];

    for (let i = 0; i < marketIds.length; i++) {
      const marketId1 = marketIds[i];

      // Calculate price change for this market
      const priceChange = this.priceTracker.calculatePriceChange(marketId1, windowMs);
      priceChanges.push(priceChange);

      // Calculate volume increase (compare current vs baseline)
      const currentVolume = markets[i].volumeNum || 0;
      const baselineVolume = this.calculateBaselineVolume(marketId1);
      const volumeIncrease = baselineVolume > 0 ? currentVolume / baselineVolume : 1;
      volumeIncreases.push(volumeIncrease);

      // Calculate correlations with other markets
      for (let j = i + 1; j < marketIds.length; j++) {
        const marketId2 = marketIds[j];
        const correlation = this.priceTracker.calculateCorrelation(marketId1, marketId2, windowMs);
        correlations.push(correlation);
      }
    }

    if (correlations.length === 0) {
      return null;
    }

    // Calculate average correlation
    const avgCorrelation = correlations.reduce((sum, c) => sum + c, 0) / correlations.length;

    // Calculate average price change magnitude
    const avgPriceChange = priceChanges.reduce((sum, c) => sum + Math.abs(c), 0) / priceChanges.length;

    // Calculate average volume increase
    const avgVolumeIncrease = volumeIncreases.reduce((sum, v) => sum + v, 0) / volumeIncreases.length;

    // Check if correlation is abnormally high
    const baselineCorrelation = this.getBaselineCorrelation(markets[0].category || 'uncategorized');
    const correlationSpike = avgCorrelation - baselineCorrelation;

    logger.info(`Cross-market analysis: correlation=${avgCorrelation.toFixed(2)}, ` +
      `baseline=${baselineCorrelation.toFixed(2)}, priceChange=${avgPriceChange.toFixed(1)}%, ` +
      `volumeIncrease=${avgVolumeIncrease.toFixed(2)}x`, {
      component: 'cross_market_detector',
      operation: 'analyze_correlation',
      metadata: { avgCorrelation, baselineCorrelation, avgPriceChange, avgVolumeIncrease }
    });

    // Signal conditions:
    // 1. High correlation (above threshold)
    // 2. Significant price movement
    // 3. Volume confirmation (optional but strengthens signal)
    // 4. Correlation spike above baseline
    const meetsCorrelationThreshold = avgCorrelation >= this.config.minCorrelation;
    const meetsPriceThreshold = avgPriceChange >= this.config.minPriceChangePercent;
    const hasVolumeConfirmation = avgVolumeIncrease >= this.config.volumeConfirmationThreshold;
    const hasCorrelationSpike = correlationSpike > 0.2; // 20% increase above baseline

    if (meetsCorrelationThreshold && meetsPriceThreshold) {
      // Calculate confidence based on multiple factors
      let confidence = 0.5;

      // Strong correlation increases confidence
      if (avgCorrelation >= 0.8) confidence += 0.2;
      else if (avgCorrelation >= 0.7) confidence += 0.1;

      // Significant price movement increases confidence
      if (avgPriceChange >= 5) confidence += 0.2;
      else if (avgPriceChange >= 3) confidence += 0.1;

      // Volume confirmation increases confidence
      if (hasVolumeConfirmation) confidence += 0.15;

      // Correlation spike above baseline increases confidence
      if (hasCorrelationSpike) confidence += 0.15;

      // More markets = stronger signal
      if (markets.length >= 5) confidence += 0.1;

      confidence = Math.min(confidence, 1.0);

      logger.info(`🔗 Cross-market leak detected: ${markets.length} markets, ` +
        `correlation=${avgCorrelation.toFixed(2)}, priceChange=${avgPriceChange.toFixed(1)}%, ` +
        `volumeIncrease=${avgVolumeIncrease.toFixed(2)}x, confidence=${confidence.toFixed(2)}`);

      return {
        markets: marketIds,
        correlation: avgCorrelation,
        priceChanges,
        volumeIncreases,
        windowMs,
        confidence,
        leakStartTime: this.estimateLeakStartTime(marketIds, windowMs)
      };
    }

    return null;
  }

  /**
   * Estimate when the information leak started
   * Look back through price history to find when correlation began
   */
  private estimateLeakStartTime(marketIds: string[], windowMs: number): number | undefined {
    const now = Date.now();
    const checkInterval = 300000; // Check every 5 minutes

    // Look back up to the window size
    for (let offset = 0; offset < windowMs; offset += checkInterval) {
      const checkTime = now - offset;

      // Calculate correlation at this point in time
      let totalCorrelation = 0;
      let pairCount = 0;

      for (let i = 0; i < marketIds.length; i++) {
        for (let j = i + 1; j < marketIds.length; j++) {
          const correlation = this.priceTracker.calculateCorrelation(
            marketIds[i],
            marketIds[j],
            checkInterval // Use smaller window for leak start detection
          );
          totalCorrelation += correlation;
          pairCount++;
        }
      }

      const avgCorrelation = pairCount > 0 ? totalCorrelation / pairCount : 0;

      // If correlation drops below threshold, we found the start
      if (avgCorrelation < this.config.minCorrelation) {
        return checkTime + checkInterval; // Leak started after this point
      }
    }

    return undefined; // Leak started before our history window
  }

  /**
   * Calculate baseline correlation for a category
   * This represents "normal" correlation between markets in this category
   */
  private getBaselineCorrelation(category: string): number {
    const key = `baseline_${category}`;
    const cached = this.baselineCorrelations.get(key);
    if (cached !== undefined) {
      return cached;
    }

    // Default baselines by category
    // Related markets (e.g., Trump + crypto) naturally have some correlation
    const defaultBaselines: Record<string, number> = {
      politics: 0.3,
      earnings: 0.2,
      fed: 0.4,
      crypto_events: 0.5,
      macro: 0.4,
      uncategorized: 0.1
    };

    const baseline = defaultBaselines[category] || 0.2;
    this.baselineCorrelations.set(key, baseline);
    return baseline;
  }

  /**
   * Calculate baseline volume for a market (24-hour average)
   */
  private calculateBaselineVolume(marketId: string): number {
    const history = this.priceTracker.getPriceHistory(marketId, this.config.baselineWindow);
    if (history.length === 0) return 0;

    const totalVolume = history.reduce((sum, point) => sum + point.volume, 0);
    return totalVolume / history.length;
  }

  /**
   * Group markets by category for correlation analysis
   */
  groupMarketsByCategory(markets: Market[]): Map<string, Market[]> {
    const groups = new Map<string, Market[]>();

    for (const market of markets) {
      const category = market.category || 'uncategorized';
      const existing = groups.get(category) || [];
      existing.push(market);
      groups.set(category, existing);
    }

    return groups;
  }

  /**
   * Detect coordinated movements across all tracked markets
   * Returns signals grouped by category
   */
  detectAllCoordinatedMovements(markets: Market[]): CorrelationSignal[] {
    const signals: CorrelationSignal[] = [];

    // Group markets by category
    const categoryGroups = this.groupMarketsByCategory(markets);

    // Check each category for coordinated movement
    for (const [category, categoryMarkets] of categoryGroups.entries()) {
      if (categoryMarkets.length >= this.config.minMarketsForSignal) {
        logger.info(`Checking ${categoryMarkets.length} ${category} markets for correlation...`, {
          component: 'cross_market_detector',
          operation: 'check_category',
          metadata: { category, marketCount: categoryMarkets.length }
        });
        const signal = this.detectCoordinatedMovement(categoryMarkets);
        if (signal) {
          signals.push(signal);
        }
      }
    }

    // Also check for cross-category correlations (e.g., Trump + crypto)
    // This is where the most valuable signals come from
    if (markets.length >= this.config.minMarketsForSignal) {
      const crossCategorySignal = this.detectCoordinatedMovement(markets);
      if (crossCategorySignal) {
        signals.push(crossCategorySignal);
      }
    }

    return signals;
  }

  /**
   * Update baseline correlations periodically
   * Should be called daily to adapt to market regime changes
   */
  updateBaselines(markets: Market[]): void {
    const categoryGroups = this.groupMarketsByCategory(markets);

    for (const [category, categoryMarkets] of categoryGroups.entries()) {
      if (categoryMarkets.length < 2) continue;

      const marketIds = categoryMarkets.map(m => m.id);
      const correlations: number[] = [];

      // Calculate all pairwise correlations using long window (24 hours)
      for (let i = 0; i < marketIds.length; i++) {
        for (let j = i + 1; j < marketIds.length; j++) {
          const correlation = this.priceTracker.calculateCorrelation(
            marketIds[i],
            marketIds[j],
            this.config.baselineWindow
          );
          if (!isNaN(correlation)) {
            correlations.push(correlation);
          }
        }
      }

      if (correlations.length > 0) {
        const avgCorrelation = correlations.reduce((sum, c) => sum + c, 0) / correlations.length;
        const key = `baseline_${category}`;
        this.baselineCorrelations.set(key, avgCorrelation);

        logger.info(`Updated baseline correlation for ${category}: ${avgCorrelation.toFixed(2)}`);
      }
    }
  }

  /**
   * Convert CorrelationSignal to EarlySignal for alerting
   */
  convertToEarlySignal(correlationSignal: CorrelationSignal, markets: Market[]): EarlySignal | null {
    if (correlationSignal.markets.length === 0) return null;

    // Use first market as representative
    const primaryMarket = markets.find(m => m.id === correlationSignal.markets[0]);
    if (!primaryMarket) return null;

    const avgPriceChange = correlationSignal.priceChanges.reduce((sum, c) => sum + Math.abs(c), 0) / correlationSignal.priceChanges.length;
    const avgVolumeIncrease = correlationSignal.volumeIncreases.reduce((sum, v) => sum + v, 0) / correlationSignal.volumeIncreases.length;

    return {
      marketId: primaryMarket.id,
      market: primaryMarket,
      signalType: 'coordinated_cross_market',
      timestamp: Date.now(),
      confidence: correlationSignal.confidence,
      metadata: {
        correlatedMarkets: correlationSignal.markets,
        correlationCoefficient: correlationSignal.correlation,
        priceChanges: correlationSignal.priceChanges,
        volumeIncreases: correlationSignal.volumeIncreases,
        windowMs: correlationSignal.windowMs,
        leakStartTime: correlationSignal.leakStartTime,
        marketCount: correlationSignal.markets.length,
        avgPriceChange,
        avgVolumeIncrease
      }
    };
  }

  /**
   * Get configuration
   */
  getConfig(): CrossMarketConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<CrossMarketConfig>): void {
    this.config = { ...this.config, ...newConfig };
    logger.info('Cross-market correlation config updated', {
      component: 'cross_market_detector',
      operation: 'update_config',
      metadata: { config: this.config }
    });
  }
}
