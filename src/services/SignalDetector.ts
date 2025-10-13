import { BotConfig, EarlySignal, Market, MarketMetrics, MicrostructureSignal, TickData, OrderbookData } from '../types';
import { OrderbookAnalyzer } from './OrderbookAnalyzer';
import { TechnicalIndicatorCalculator } from './TechnicalIndicators';
import { logger } from '../utils/logger';

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
  }

  async initialize(): Promise<void> {
    logger.debug('Initializing signal detector...');
    this.lastScanTime = Date.now();
  }

  async detectSignals(markets: Market[]): Promise<EarlySignal[]> {
    const signals: EarlySignal[] = [];
    const currentTime = Date.now();

    for (const market of markets) {
      // Skip markets below volume threshold
      if (market.volumeNum < this.config.minVolumeThreshold) {
        continue;
      }

      // Update market metrics
      this.updateMarketMetrics(market, currentTime);

      // Detect various signal types
      const newMarketSignal = this.detectNewMarket(market, currentTime);
      if (newMarketSignal) signals.push(newMarketSignal);

      const volumeSpikeSignal = this.detectVolumeSpike(market, currentTime);
      if (volumeSpikeSignal) signals.push(volumeSpikeSignal);

      const priceMovementSignal = this.detectPriceMovement(market, currentTime);
      if (priceMovementSignal) signals.push(priceMovementSignal);

      const unusualActivitySignal = this.detectUnusualActivity(market, currentTime);
      if (unusualActivitySignal) signals.push(unusualActivitySignal);
    }

    this.lastScanTime = currentTime;
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

    const currentMetrics: MarketMetrics = {
      marketId,
      volume24h: market.volumeNum,
      volumeChange: previousMetrics ? 
        ((market.volumeNum - previousMetrics.volume24h) / previousMetrics.volume24h) * 100 : 0,
      priceChange: this.calculatePriceChange(market, previousMetrics),
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

    if (createdTime > oneHourAgo && market.volumeNum > this.config.minVolumeThreshold * 2) {
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
    
    // Detect 3x volume spike
    if (market.volumeNum > avgVolume * 3 && market.volumeNum > this.config.minVolumeThreshold * 5) {
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
    
    // Look for significant price changes (>10% in short time)
    const maxPriceChange = Math.max(...Object.values(latest.priceChange).map(Math.abs));
    
    if (maxPriceChange > 10 && market.volumeNum > this.config.minVolumeThreshold) {
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

  private calculatePriceChange(market: Market, previousMetrics?: MarketMetrics): Record<string, number> {
    if (!previousMetrics) return {};

    const changes: Record<string, number> = {};
    
    market.outcomePrices.forEach((price, index) => {
      const currentPrice = parseFloat(price);
      // For price change calculation, we'd need previous prices stored
      // This is a simplified version
      changes[`outcome_${index}`] = 0; // Placeholder
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
}