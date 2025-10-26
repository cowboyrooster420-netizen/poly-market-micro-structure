import { OrderbookData, EnhancedMicrostructureMetrics, BotConfig } from '../types';
import { RingBuffer, StatisticalModels, StatisticalConfig } from '../statistics/StatisticalModels';
import { AnomalyDetector, AnomalyDetectionConfig } from '../statistics/AnomalyDetector';
import { logger } from '../utils/logger';
import { toBasisPoints } from '../utils/spreadHelpers';

interface TimeBasedBaseline {
  hourOfDay: number;
  volume: number;
  depth: number;
  spread: number;
  imbalance: number;
  sampleCount: number;
}

interface MarketBaselines {
  hourlyBaselines: Map<number, TimeBasedBaseline>;
  overallBaselines: {
    volume: number;
    depth: number;
    spread: number;
    imbalance: number;
  };
  lastUpdated: number;
}

export class EnhancedMicrostructureAnalyzer {
  private config: BotConfig;
  private marketMetrics: Map<string, EnhancedMicrostructureMetrics> = new Map();
  private marketBaselines: Map<string, MarketBaselines> = new Map();
  
  // Statistical models and anomaly detection
  private statisticalModels: StatisticalModels;
  private anomalyDetector: AnomalyDetector;
  
  // Ring buffers for historical data (depth@1, micro-price, etc.)
  private depthBuffers: Map<string, RingBuffer<number>> = new Map();
  private microPriceBuffers: Map<string, RingBuffer<number>> = new Map();
  private spreadBuffers: Map<string, RingBuffer<number>> = new Map();
  private imbalanceBuffers: Map<string, RingBuffer<number>> = new Map();
  private volumeBuffers: Map<string, RingBuffer<number>> = new Map();
  
  // Constants for baseline calculations
  private readonly BASELINE_WINDOW_SIZE = 720; // 6 hours at 30s intervals
  private readonly MICRO_PRICE_WINDOW = 50; // 50 ticks for micro-price calculation
  private readonly SLOPE_CALCULATION_WINDOW = 20; // 20 data points for slope
  
  constructor(config: BotConfig) {
    this.config = config;
    
    // Initialize statistical models with robust configuration
    const statConfig: StatisticalConfig = {
      windowSize: this.BASELINE_WINDOW_SIZE,
      outlierThreshold: config.microstructure.spreadAnomalyThreshold,
      minSampleSize: 30,
      confidenceLevel: 0.95,
      ewmaAlpha: 0.1
    };
    
    const anomalyConfig: AnomalyDetectionConfig = {
      ...statConfig,
      multivariateSensitivity: 0.85,
      isolationForestContamination: 0.1,
      mahalanobisThreshold: 3.0,
      consensusThreshold: 0.6
    };
    
    this.statisticalModels = new StatisticalModels(statConfig);
    this.anomalyDetector = new AnomalyDetector(anomalyConfig);
    
    logger.info('Enhanced Microstructure Analyzer initialized with robust statistical models');
  }

  /**
   * Process orderbook data and generate enhanced microstructure metrics
   */
  processOrderbook(orderbook: OrderbookData): EnhancedMicrostructureMetrics | null {
    try {
      const marketId = orderbook.marketId;
      const timestamp = orderbook.timestamp;
      
      // Initialize buffers if they don't exist
      this.initializeBuffersForMarket(marketId);
      
      // Calculate depth@1 metrics
      const depth1Metrics = this.calculateDepth1Metrics(orderbook);
      
      // Calculate micro-price
      const microPriceMetrics = this.calculateMicroPriceMetrics(orderbook, marketId);
      
      // Calculate advanced orderbook metrics
      const advancedMetrics = this.calculateAdvancedOrderbookMetrics(orderbook);
      
      // Get or create baselines
      const baselines = this.getOrCreateBaselines(marketId);
      
      // Calculate robust z-scores using statistical models
      const zScores = this.calculateRobustZScores(orderbook, depth1Metrics, advancedMetrics, timestamp);
      
      // Get time-of-day baseline
      const timeBaseline = this.getTimeOfDayBaseline(marketId, timestamp);
      
      const metrics: EnhancedMicrostructureMetrics = {
        marketId,
        timestamp,
        
        // Depth metrics
        depth1Bid: depth1Metrics.bidDepth,
        depth1Ask: depth1Metrics.askDepth,
        depth1Total: depth1Metrics.totalDepth,
        depth1Change: depth1Metrics.change,
        depth1Baseline: depth1Metrics.baseline,
        
        // Micro-price metrics
        microPrice: microPriceMetrics.microPrice,
        microPriceSlope: microPriceMetrics.slope,
        microPriceDrift: microPriceMetrics.drift,
        
        // Advanced orderbook metrics
        orderBookImbalance: advancedMetrics.imbalance,
        spreadBps: advancedMetrics.spreadBps,
        spreadChange: advancedMetrics.spreadChange,
        liquidityVacuum: this.detectLiquidityVacuum(depth1Metrics, advancedMetrics),
        
        // Z-scores
        volumeZScore: zScores.volume,
        depthZScore: zScores.depth,
        spreadZScore: zScores.spread,
        imbalanceZScore: zScores.imbalance,
        
        // Time-based baseline
        timeOfDayBaseline: timeBaseline
      };
      
      // Store metrics and update baselines
      this.marketMetrics.set(marketId, metrics);
      this.updateBaselines(marketId, metrics, timestamp);
      
      return metrics;
      
    } catch (error) {
      logger.error(`Error processing orderbook for market ${orderbook.marketId}:`, error);
      return null;
    }
  }

  /**
   * Calculate depth@1 (top-of-book) metrics
   */
  private calculateDepth1Metrics(orderbook: OrderbookData): {
    bidDepth: number;
    askDepth: number;
    totalDepth: number;
    change: number;
    baseline: number;
  } {
    const bidDepth = orderbook.bids.length > 0 ? orderbook.bids[0].size : 0;
    const askDepth = orderbook.asks.length > 0 ? orderbook.asks[0].size : 0;
    const totalDepth = bidDepth + askDepth;
    
    // Get depth buffer and calculate change
    const depthBuffer = this.depthBuffers.get(orderbook.marketId)!;
    const previousDepth = depthBuffer.length() > 0 ? depthBuffer.getLatest() || 0 : totalDepth;
    const change = previousDepth > 0 ? ((totalDepth - previousDepth) / previousDepth) * 100 : 0;
    
    // Calculate 15-minute baseline
    const baseline = depthBuffer.length() > 0 ? this.calculateAverage(depthBuffer.getAll()) : totalDepth;
    
    // Store current depth
    depthBuffer.push(totalDepth);
    
    return {
      bidDepth,
      askDepth,
      totalDepth,
      change,
      baseline
    };
  }

  /**
   * Calculate volume-weighted micro-price and drift
   */
  private calculateMicroPriceMetrics(orderbook: OrderbookData, marketId: string): {
    microPrice: number;
    slope: number;
    drift: number;
  } {
    // Calculate volume-weighted mid price (micro-price)
    let totalBidVolume = 0;
    let totalAskVolume = 0;
    let bidWeightedPrice = 0;
    let askWeightedPrice = 0;
    
    // Take top 3 levels for micro-price calculation
    const levelsToUse = Math.min(3, Math.min(orderbook.bids.length, orderbook.asks.length));
    
    for (let i = 0; i < levelsToUse; i++) {
      if (orderbook.bids[i]) {
        const volume = orderbook.bids[i].volume;
        totalBidVolume += volume;
        bidWeightedPrice += orderbook.bids[i].price * volume;
      }
      
      if (orderbook.asks[i]) {
        const volume = orderbook.asks[i].volume;
        totalAskVolume += volume;
        askWeightedPrice += orderbook.asks[i].price * volume;
      }
    }
    
    const avgBidPrice = totalBidVolume > 0 ? bidWeightedPrice / totalBidVolume : orderbook.bestBid;
    const avgAskPrice = totalAskVolume > 0 ? askWeightedPrice / totalAskVolume : orderbook.bestAsk;
    const totalVolume = totalBidVolume + totalAskVolume;
    
    // Micro-price: volume-weighted average of bid and ask sides
    const microPrice = totalVolume > 0 ? 
      (avgBidPrice * totalBidVolume + avgAskPrice * totalAskVolume) / totalVolume :
      orderbook.midPrice;
    
    // Get micro-price buffer and calculate slope/drift
    const microBuffer = this.microPriceBuffers.get(marketId)!;
    microBuffer.push(microPrice);
    
    const slope = this.calculateSlope(microBuffer, this.SLOPE_CALCULATION_WINDOW);
    const drift = this.calculateDrift(microBuffer);
    
    return {
      microPrice,
      slope,
      drift
    };
  }

  /**
   * Calculate advanced orderbook metrics
   */
  private calculateAdvancedOrderbookMetrics(orderbook: OrderbookData): {
    imbalance: number;
    spreadBps: number;
    spreadChange: number;
  } {
    // Order book imbalance calculation
    const totalBidVolume = orderbook.bids.reduce((sum, level) => sum + level.volume, 0);
    const totalAskVolume = orderbook.asks.reduce((sum, level) => sum + level.volume, 0);
    const imbalance = totalBidVolume + totalAskVolume > 0 ? 
      (totalBidVolume - totalAskVolume) / (totalBidVolume + totalAskVolume) : 0;
    
    // Spread in basis points using helper function
    // For prediction markets, prices are probabilities (0-1), so spread is absolute
    // Example: spread of 0.027 (2.7 cents) = 2.7% = 270 bps
    const spreadBps = toBasisPoints(orderbook.spread);
    
    // Spread change calculation
    const spreadBuffer = this.spreadBuffers.get(orderbook.marketId)!;
    const previousSpread = spreadBuffer.length() > 0 ? spreadBuffer.getLatest() || spreadBps : spreadBps;
    const spreadChange = previousSpread > 0 ? ((spreadBps - previousSpread) / previousSpread) * 100 : 0;
    
    // Store current spread and imbalance
    spreadBuffer.push(spreadBps);
    this.imbalanceBuffers.get(orderbook.marketId)!.push(imbalance);
    
    return {
      imbalance,
      spreadBps,
      spreadChange
    };
  }

  /**
   * Calculate robust z-scores using statistical models for anomaly detection
   */
  private calculateRobustZScores(
    orderbook: OrderbookData,
    depthMetrics: any,
    advancedMetrics: any,
    timestamp: number
  ): {
    volume: number;
    depth: number;
    spread: number;
    imbalance: number;
  } {
    const marketId = orderbook.marketId;
    
    // Update statistical models with current data
    this.statisticalModels.addDataPoint(marketId, 'depth', depthMetrics.totalDepth);
    this.statisticalModels.addDataPoint(marketId, 'spread', advancedMetrics.spreadBps);
    this.statisticalModels.addDataPoint(marketId, 'imbalance', Math.abs(advancedMetrics.imbalance));
    
    // Calculate time-adjusted z-scores for better anomaly detection
    const volumeResult = this.statisticalModels.calculateTimeAdjustedZScore(marketId, 'volume', 0, timestamp); // Placeholder volume
    const depthResult = this.statisticalModels.calculateTimeAdjustedZScore(marketId, 'depth', depthMetrics.totalDepth, timestamp);
    const spreadResult = this.statisticalModels.calculateTimeAdjustedZScore(marketId, 'spread', advancedMetrics.spreadBps, timestamp);
    const imbalanceResult = this.statisticalModels.calculateTimeAdjustedZScore(marketId, 'imbalance', Math.abs(advancedMetrics.imbalance), timestamp);
    
    // Log significant anomalies
    if (depthResult.isAnomaly) {
      logger.debug(`Depth anomaly detected for market ${marketId}: Z-score ${depthResult.zScore.toFixed(2)}, confidence ${(depthResult.confidenceLevel * 100).toFixed(1)}%`);
    }
    if (spreadResult.isAnomaly) {
      logger.debug(`Spread anomaly detected for market ${marketId}: Z-score ${spreadResult.zScore.toFixed(2)}, confidence ${(spreadResult.confidenceLevel * 100).toFixed(1)}%`);
    }
    if (imbalanceResult.isAnomaly) {
      logger.debug(`Imbalance anomaly detected for market ${marketId}: Z-score ${imbalanceResult.zScore.toFixed(2)}, confidence ${(imbalanceResult.confidenceLevel * 100).toFixed(1)}%`);
    }
    
    return {
      volume: volumeResult.zScore,
      depth: depthResult.zScore,
      spread: spreadResult.zScore,
      imbalance: imbalanceResult.zScore
    };
  }

  /**
   * Perform comprehensive anomaly detection using advanced statistical models
   */
  async performAnomalyDetection(metrics: EnhancedMicrostructureMetrics): Promise<any> {
    try {
      const anomalyResult = await this.anomalyDetector.detectAnomalies(metrics.marketId, metrics);
      
      if (anomalyResult.isAnomalous) {
        logger.info(`🚨 Advanced anomaly detected for market ${metrics.marketId}:`, {
          confidence: (anomalyResult.confidence * 100).toFixed(1) + '%',
          severity: anomalyResult.severity,
          types: anomalyResult.anomalyType.join(', '),
          explanation: anomalyResult.explanation
        });
      }
      
      return anomalyResult;
    } catch (error) {
      logger.error(`Error in anomaly detection for market ${metrics.marketId}:`, error);
      return null;
    }
  }

  /**
   * Get market health score using statistical stability metrics
   */
  getMarketHealthScore(marketId: string): number {
    return this.statisticalModels.getMarketHealthScore(marketId);
  }

  /**
   * Get market risk assessment based on recent anomaly patterns
   */
  getMarketRiskAssessment(marketId: string): any {
    return this.anomalyDetector.getMarketRiskAssessment(marketId);
  }

  /**
   * Perform trend analysis for a specific metric
   */
  performTrendAnalysis(marketId: string, type: 'price' | 'volume' | 'spread' | 'depth' | 'imbalance'): any {
    return this.statisticalModels.performTrendAnalysis(marketId, type);
  }

  /**
   * Calculate volatility metrics for price data
   */
  calculateVolatilityMetrics(marketId: string, prices: number[]): any {
    return this.statisticalModels.calculateVolatilityMetrics(marketId, prices);
  }

  /**
   * Detect structural breaks in market behavior
   */
  detectStructuralBreaks(marketId: string, type: 'price' | 'volume' | 'spread' | 'depth' | 'imbalance'): number[] {
    return this.statisticalModels.detectStructuralBreaks(marketId, type);
  }

  /**
   * Get comprehensive market statistics for a given market
   */
  getMarketStatistics(marketId: string): {
    healthScore: number;
    riskAssessment: any;
    trendAnalysis: any;
    recentAnomalies: number;
    statisticalStability: boolean;
  } {
    const healthScore = this.getMarketHealthScore(marketId);
    const riskAssessment = this.getMarketRiskAssessment(marketId);
    const spreadTrend = this.performTrendAnalysis(marketId, 'spread');
    const depthTrend = this.performTrendAnalysis(marketId, 'depth');
    
    // Count recent anomalies (this would track anomalies in a real implementation)
    const recentAnomalies = 0; // Placeholder
    
    return {
      healthScore,
      riskAssessment,
      trendAnalysis: {
        spread: spreadTrend,
        depth: depthTrend
      },
      recentAnomalies,
      statisticalStability: healthScore > 75 && riskAssessment.riskLevel !== 'critical'
    };
  }

  /**
   * Detect liquidity vacuum condition
   */
  private detectLiquidityVacuum(depthMetrics: any, advancedMetrics: any): boolean {
    // Liquidity vacuum: depth drop >40% without significant spread widening
    const depthDrop = depthMetrics.change < -40;
    const spreadStable = Math.abs(advancedMetrics.spreadChange) < 10; // Less than 10% spread change
    
    return depthDrop && spreadStable;
  }

  /**
   * Calculate slope of a data series
   */
  private calculateSlope(buffer: RingBuffer<number>, window: number): number {
    if (buffer.length() < 2) return 0;
    
    const data = buffer.getLast(Math.min(window, buffer.length()));
    if (data.length < 2) return 0;
    
    // Simple linear regression slope
    const n = data.length;
    const xMean = (n - 1) / 2; // x values are just indices
    const yMean = data.reduce((sum: number, val: number) => sum + val, 0) / n;
    
    let numerator = 0;
    let denominator = 0;
    
    for (let i = 0; i < n; i++) {
      const xDiff = i - xMean;
      const yDiff = data[i] - yMean;
      numerator += xDiff * yDiff;
      denominator += xDiff * xDiff;
    }
    
    return denominator !== 0 ? numerator / denominator : 0;
  }

  /**
   * Calculate sustained drift above 95th percentile
   */
  private calculateDrift(buffer: RingBuffer<number>): number {
    if (buffer.length() < 10) return 0;
    
    const recentData = buffer.getLast(10);
    const allData = buffer.getAll();
    
    // Calculate 95th percentile of all historical slopes
    const slopes: number[] = [];
    for (let i = 1; i < allData.length; i++) {
      slopes.push(allData[i] - allData[i-1]);
    }
    
    slopes.sort((a, b) => a - b);
    const p95Index = Math.floor(slopes.length * 0.95);
    const p95Threshold = slopes[p95Index] || 0;
    
    // Calculate recent slope
    const recentSlope = recentData.length > 1 ? 
      (recentData[recentData.length - 1] - recentData[0]) / recentData.length : 0;
    
    return recentSlope > p95Threshold ? recentSlope : 0;
  }

  /**
   * Calculate simple z-score (placeholder implementation)
   */
  private calculateSimpleZScore(current: number, baseline: number): number {
    if (baseline === 0) return 0;
    
    // Simplified z-score calculation
    // In real implementation, you'd calculate proper standard deviation
    const deviation = Math.abs(current - baseline);
    const estimatedStdDev = baseline * 0.1; // Assume 10% of baseline as std dev
    
    return estimatedStdDev > 0 ? deviation / estimatedStdDev : 0;
  }

  /**
   * Calculate average of an array
   */
  private calculateAverage(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, val) => sum + val, 0) / values.length;
  }

  /**
   * Initialize ring buffers for a market
   */
  private initializeBuffersForMarket(marketId: string): void {
    if (!this.depthBuffers.has(marketId)) {
      this.depthBuffers.set(marketId, new RingBuffer<number>(this.BASELINE_WINDOW_SIZE));
      this.microPriceBuffers.set(marketId, new RingBuffer<number>(this.MICRO_PRICE_WINDOW));
      this.spreadBuffers.set(marketId, new RingBuffer<number>(this.BASELINE_WINDOW_SIZE));
      this.imbalanceBuffers.set(marketId, new RingBuffer<number>(this.BASELINE_WINDOW_SIZE));
      this.volumeBuffers.set(marketId, new RingBuffer<number>(this.BASELINE_WINDOW_SIZE));
    }
  }

  /**
   * Get or create baselines for a market
   */
  private getOrCreateBaselines(marketId: string): MarketBaselines {
    if (!this.marketBaselines.has(marketId)) {
      const baselines: MarketBaselines = {
        hourlyBaselines: new Map(),
        overallBaselines: {
          volume: 0,
          depth: 0,
          spread: 0,
          imbalance: 0
        },
        lastUpdated: Date.now()
      };
      this.marketBaselines.set(marketId, baselines);
    }
    return this.marketBaselines.get(marketId)!;
  }

  /**
   * Get time-of-day baseline for a specific hour
   */
  private getTimeOfDayBaseline(marketId: string, timestamp: number): {
    volume: number;
    depth: number;
    spread: number;
    imbalance: number;
  } {
    const hour = new Date(timestamp).getHours();
    const baselines = this.marketBaselines.get(marketId);
    
    if (baselines && baselines.hourlyBaselines.has(hour)) {
      const hourlyBaseline = baselines.hourlyBaselines.get(hour)!;
      return {
        volume: hourlyBaseline.volume,
        depth: hourlyBaseline.depth,
        spread: hourlyBaseline.spread,
        imbalance: hourlyBaseline.imbalance
      };
    }
    
    // Return overall baselines if no hourly data
    return baselines?.overallBaselines || {
      volume: 0,
      depth: 0,
      spread: 0,
      imbalance: 0
    };
  }

  /**
   * Update baselines with new data
   */
  private updateBaselines(marketId: string, metrics: EnhancedMicrostructureMetrics, timestamp: number): void {
    const baselines = this.marketBaselines.get(marketId)!;
    const hour = new Date(timestamp).getHours();
    
    // Update hourly baselines
    if (!baselines.hourlyBaselines.has(hour)) {
      baselines.hourlyBaselines.set(hour, {
        hourOfDay: hour,
        volume: 0,
        depth: metrics.depth1Total,
        spread: metrics.spreadBps,
        imbalance: Math.abs(metrics.orderBookImbalance),
        sampleCount: 1
      });
    } else {
      const hourlyBaseline = baselines.hourlyBaselines.get(hour)!;
      const count = hourlyBaseline.sampleCount;
      
      // Running average update
      hourlyBaseline.depth = (hourlyBaseline.depth * count + metrics.depth1Total) / (count + 1);
      hourlyBaseline.spread = (hourlyBaseline.spread * count + metrics.spreadBps) / (count + 1);
      hourlyBaseline.imbalance = (hourlyBaseline.imbalance * count + Math.abs(metrics.orderBookImbalance)) / (count + 1);
      hourlyBaseline.sampleCount++;
    }
    
    // Update overall baselines
    const depthBuffer = this.depthBuffers.get(marketId)!;
    const spreadBuffer = this.spreadBuffers.get(marketId)!;
    const imbalanceBuffer = this.imbalanceBuffers.get(marketId)!;
    
    baselines.overallBaselines.depth = this.calculateAverage(depthBuffer.getAll());
    baselines.overallBaselines.spread = this.calculateAverage(spreadBuffer.getAll());
    baselines.overallBaselines.imbalance = this.calculateAverage(imbalanceBuffer.getAll());
    baselines.lastUpdated = timestamp;
  }

  /**
   * Get enhanced metrics for a market
   */
  getMarketMetrics(marketId: string): EnhancedMicrostructureMetrics | null {
    return this.marketMetrics.get(marketId) || null;
  }

  /**
   * Cleanup stale market data
   */
  cleanupStaleMarkets(maxAge: number = 24 * 60 * 60 * 1000): void {
    const now = Date.now();
    const staleMarkets: string[] = [];
    
    for (const [marketId, baselines] of this.marketBaselines) {
      if (now - baselines.lastUpdated > maxAge) {
        staleMarkets.push(marketId);
      }
    }
    
    for (const marketId of staleMarkets) {
      this.marketBaselines.delete(marketId);
      this.marketMetrics.delete(marketId);
      this.depthBuffers.delete(marketId);
      this.microPriceBuffers.delete(marketId);
      this.spreadBuffers.delete(marketId);
      this.imbalanceBuffers.delete(marketId);
      this.volumeBuffers.delete(marketId);
    }
    
    if (staleMarkets.length > 0) {
      logger.info(`Cleaned up ${staleMarkets.length} stale market data entries`);
    }
  }

  /**
   * Health check
   */
  healthCheck(): { healthy: boolean; details: any } {
    const trackedMarkets = this.marketMetrics.size;
    const totalBaselines = this.marketBaselines.size;
    
    return {
      healthy: trackedMarkets > 0,
      details: {
        trackedMarkets,
        totalBaselines,
        buffersActive: this.depthBuffers.size,
        lastUpdate: Math.max(...Array.from(this.marketMetrics.values()).map(m => m.timestamp))
      }
    };
  }
}