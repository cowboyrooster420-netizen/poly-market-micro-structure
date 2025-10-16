import { BotConfig, EarlySignal, Market, MarketMetrics, MicrostructureSignal, TickData, OrderbookData } from '../types';
import { OrderbookAnalyzer } from './OrderbookAnalyzer';
import { TechnicalIndicatorCalculator } from './TechnicalIndicators';
import { statisticalWorkerService } from './StatisticalWorkerService';
import { configManager } from '../config/ConfigManager';
import { logger } from '../utils/logger';
import { advancedLogger } from '../utils/AdvancedLogger';

export class SignalDetector {
  private config: BotConfig;
  private marketHistory: Map<string, MarketMetrics[]> = new Map();
  private lastScanTime = 0;
  private orderbookAnalyzer: OrderbookAnalyzer;
  private technicalIndicators: TechnicalIndicatorCalculator;

  constructor(config: BotConfig) {
    this.config = config;
    this.orderbookAnalyzer = new OrderbookAnalyzer(config);
    this.technicalIndicators = new TechnicalIndicatorCalculator(config);
    
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

      // Detect various signal types
      const newMarketSignal = this.detectNewMarket(market, currentTime);
      if (newMarketSignal) {
        signals.push(newMarketSignal);
        newMarketCount++;
      }

      const volumeSpikeSignal = this.detectVolumeSpike(market, currentTime);
      if (volumeSpikeSignal) {
        signals.push(volumeSpikeSignal);
        volumeSpikeCount++;
      }

      const priceMovementSignal = this.detectPriceMovement(market, currentTime);
      if (priceMovementSignal) {
        signals.push(priceMovementSignal);
        priceMovementCount++;
      }

      const unusualActivitySignal = this.detectUnusualActivity(market, currentTime);
      if (unusualActivitySignal) {
        signals.push(unusualActivitySignal);
        unusualActivityCount++;
      }
    }

    this.lastScanTime = currentTime;
    
    // Debug logging to show detection stats
    logger.debug(`Detection stats: ${marketsWithHistory} markets with history, checked ${markets.length} markets`);
    if (signals.length === 0) {
      logger.debug(`No signals found - new:${newMarketCount}, volume:${volumeSpikeCount}, price:${priceMovementCount}, activity:${unusualActivityCount}`);
    }
    
    return signals;
  }

  // New methods for real-time microstructure analysis
  detectMicrostructureSignals(tick: TickData): EarlySignal[] {
    const signals: EarlySignal[] = [];
    
    // Calculate technical indicators
    const indicators = this.technicalIndicators.calculateIndicators(tick.marketId, tick);
    if (indicators) {
      const momentumSignals = this.technicalIndicators.detectMomentumSignals(indicators);
      signals.push(...this.convertMicrostructureToEarlySignals(momentumSignals));
    }

    return signals;
  }

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

    // Keep only last 24 hours of data (assuming 30s intervals = 2880 data points)
    if (history.length > 2880) {
      history.shift();
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

    const recent = history.slice(-5);
    const avgVolume = recent.reduce((sum, m) => sum + m.volume24h, 0) / recent.length;
    const volumeMultiplier = avgVolume > 0 ? market.volumeNum / avgVolume : 0;
    
    // Debug logging for top markets
    if (market.volumeNum > this.config.minVolumeThreshold * 5) {
      logger.debug(`Volume check - ${market.question?.substring(0, 40)}: current=$${market.volumeNum.toFixed(0)}, avg=$${avgVolume.toFixed(0)}, multiplier=${volumeMultiplier.toFixed(2)}x`);
    }
    
    // Detect volume spike using configuration threshold
    const systemConfig = configManager.getConfig();
    const multiplierThreshold = systemConfig.detection.signals.volumeSpike.multiplier;
    
    if (market.volumeNum > avgVolume * multiplierThreshold && market.volumeNum > this.config.minVolumeThreshold * 5) {
      logger.info(`🚨 VOLUME SPIKE: ${market.question?.substring(0, 50)} - ${volumeMultiplier.toFixed(1)}x increase!`);
      return {
        marketId: market.id,
        market,
        signalType: 'volume_spike',
        confidence: Math.min(0.9, (market.volumeNum / avgVolume) / 10),
        timestamp,
        metadata: {
          currentVolume: market.volumeNum,
          averageVolume: avgVolume,
          spikeMultiplier: market.volumeNum / avgVolume,
        },
      };
    }

    return null;
  }

  private detectPriceMovement(market: Market, timestamp: number): EarlySignal | null {
    const history = this.marketHistory.get(market.id);
    if (!history || history.length < 3) return null;

    const latest = history[history.length - 1];
    const priceChanges = Object.values(latest.priceChange);
    
    // Look for significant price changes (>10% in short time)
    const maxPriceChange = priceChanges.length > 0 ? Math.max(...priceChanges.map(Math.abs)) : 0;
    
    // Debug log significant price movements (>5%)
    if (maxPriceChange > 5) {
      logger.debug(`Price movement - ${market.question?.substring(0, 40)}: ${maxPriceChange.toFixed(2)}% change, volume=$${market.volumeNum.toFixed(0)}`);
    }
    
    const systemConfig = configManager.getConfig();
    const priceThreshold = systemConfig.detection.signals.priceMovement.percentageThreshold;
    
    if (maxPriceChange > priceThreshold && market.volumeNum > this.config.minVolumeThreshold) {
      logger.info(`🚨 PRICE MOVEMENT: ${market.question?.substring(0, 50)} - ${maxPriceChange.toFixed(1)}% change!`);
      return {
        marketId: market.id,
        market,
        signalType: 'price_movement',
        confidence: Math.min(0.9, maxPriceChange / 50),
        timestamp,
        metadata: {
          priceChanges: latest.priceChange,
          maxChange: maxPriceChange,
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
    if (latest.activityScore > 80 && market.volumeNum > this.config.minVolumeThreshold) {
      return {
        marketId: market.id,
        market,
        signalType: 'unusual_activity',
        confidence: latest.activityScore / 100,
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
    
    currentPrices.forEach((currentPrice, index) => {
      const previousPrice = previousMetrics.prices[index];
      if (previousPrice && previousPrice > 0) {
        const change = ((currentPrice - previousPrice) / previousPrice) * 100;
        changes[`outcome_${index}`] = change;
      } else {
        changes[`outcome_${index}`] = 0;
      }
    });

    return changes;
  }

  private calculateActivityScore(market: Market, previousMetrics?: MarketMetrics): number {
    let score = 0;

    // Volume component (0-40 points)
    if (market.volumeNum > this.config.minVolumeThreshold * 10) score += 40;
    else if (market.volumeNum > this.config.minVolumeThreshold * 5) score += 30;
    else if (market.volumeNum > this.config.minVolumeThreshold * 2) score += 20;
    else score += 10;

    // Volume change component (0-30 points)
    if (previousMetrics) {
      if (previousMetrics.volumeChange > 200) score += 30;
      else if (previousMetrics.volumeChange > 100) score += 20;
      else if (previousMetrics.volumeChange > 50) score += 10;
    }

    // Price balance component (0-30 points)
    const prices = market.outcomePrices.map(p => parseFloat(p));
    const priceBalance = Math.abs(0.5 - Math.min(...prices));
    if (priceBalance < 0.1) score += 30; // Close to 50/50
    else if (priceBalance < 0.2) score += 20;
    else if (priceBalance < 0.3) score += 10;

    return Math.min(100, score);
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