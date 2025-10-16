import { 
  BotConfig, 
  EarlySignal, 
  TickData, 
  OrderbookData, 
  Market,
  MicrostructureSignal,
  TechnicalIndicators,
  OrderbookMetrics,
  EnhancedMicrostructureMetrics 
} from '../types';
import { SignalDetector } from './SignalDetector';
import { OrderbookAnalyzer } from './OrderbookAnalyzer';
import { TechnicalIndicatorCalculator } from './TechnicalIndicators';
import { WebSocketService } from './WebSocketService';
import { OrderFlowAnalyzer } from './OrderFlowAnalyzer';
import { EnhancedMicrostructureAnalyzer } from './EnhancedMicrostructureAnalyzer';
import { FrontRunningHeuristicEngine } from './FrontRunningHeuristicEngine';
import { logger } from '../utils/logger';

export class MicrostructureDetector {
  private config: BotConfig;
  private signalDetector: SignalDetector;
  private orderbookAnalyzer: OrderbookAnalyzer;
  private technicalIndicators: TechnicalIndicatorCalculator;
  private orderFlowAnalyzer: OrderFlowAnalyzer;
  private enhancedAnalyzer: EnhancedMicrostructureAnalyzer;
  private frontRunEngine: FrontRunningHeuristicEngine;
  private webSocketService: WebSocketService;
  private isRunning = false;
  private trackedMarkets: Set<string> = new Set();
  
  // Event handlers
  private onSignalHandler: ((signal: EarlySignal) => void) | null = null;
  private onMicrostructureSignalHandler: ((signal: MicrostructureSignal) => void) | null = null;

  // Performance tracking
  private signalCounts: Map<string, number> = new Map();
  private lastPerformanceReport = Date.now();
  private performanceInterval: NodeJS.Timeout | null = null;

  constructor(config: BotConfig) {
    this.config = config;
    this.signalDetector = new SignalDetector(config);
    this.orderbookAnalyzer = new OrderbookAnalyzer(config);
    this.technicalIndicators = new TechnicalIndicatorCalculator(config);
    this.orderFlowAnalyzer = new OrderFlowAnalyzer(config);
    this.enhancedAnalyzer = new EnhancedMicrostructureAnalyzer(config);
    this.frontRunEngine = new FrontRunningHeuristicEngine(config);
    this.webSocketService = new WebSocketService(config);
  }

  async initialize(): Promise<void> {
    logger.info('Initializing MicrostructureDetector...');

    // Initialize all components
    await this.signalDetector.initialize();
    
    // Set up WebSocket event handlers
    this.webSocketService.onTick(this.handleTick.bind(this));
    this.webSocketService.onOrderbook(this.handleOrderbook.bind(this));
    this.webSocketService.onConnection(this.handleConnectionChange.bind(this));

    // Connect to WebSocket
    try {
      await this.webSocketService.connect();
      logger.info('WebSocket connected successfully');
    } catch (error) {
      logger.warn('WebSocket connection failed, will retry:', error);
    }

    logger.info('MicrostructureDetector initialized');
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('MicrostructureDetector is already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting microstructure detection...');

    // Start performance reporting
    this.startPerformanceReporting();
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    this.isRunning = false;
    
    // Clear the performance reporting interval
    if (this.performanceInterval) {
      clearInterval(this.performanceInterval);
      this.performanceInterval = null;
    }
    
    this.webSocketService.disconnect();
    this.trackedMarkets.clear();
    
    // Clean up ring buffers to prevent memory leaks
    this.technicalIndicators.dispose();
    this.orderbookAnalyzer.dispose();
    this.orderFlowAnalyzer.dispose();
    this.enhancedAnalyzer.cleanupStaleMarkets();
    this.frontRunEngine.cleanup();
    
    logger.info('MicrostructureDetector stopped');
  }

  trackMarket(marketId: string, assetIds?: string[]): void {
    if (this.trackedMarkets.has(marketId)) return;

    this.trackedMarkets.add(marketId);
    
    // Subscribe using asset IDs if available, otherwise use market ID
    if (assetIds && assetIds.length > 0) {
      for (const assetId of assetIds) {
        this.webSocketService.subscribeToMarket(assetId);
        logger.debug(`Subscribed to asset: ${assetId} for market: ${marketId.substring(0, 8)}...`);
      }
    } else {
      this.webSocketService.subscribeToMarket(marketId);
      logger.debug(`Subscribed to market: ${marketId.substring(0, 8)}...`);
    }
    
    logger.debug(`Now tracking market: ${marketId.substring(0, 8)}...`);
  }

  untrackMarket(marketId: string): void {
    if (!this.trackedMarkets.has(marketId)) return;

    this.trackedMarkets.delete(marketId);
    this.webSocketService.unsubscribeFromMarket(marketId);
    
    logger.debug(`Stopped tracking market: ${marketId}`);
  }

  trackMarkets(markets: { id: string; assetIds?: string[] }[]): void {
    for (const market of markets) {
      this.trackMarket(market.id, market.assetIds);
    }
  }

  // Event handler setters
  onSignal(handler: (signal: EarlySignal) => void): void {
    this.onSignalHandler = handler;
  }

  onMicrostructureSignal(handler: (signal: MicrostructureSignal) => void): void {
    this.onMicrostructureSignalHandler = handler;
  }

  // Getters for market data
  getMarketIndicators(marketId: string): TechnicalIndicators | null {
    return this.technicalIndicators.getMarketIndicators(marketId);
  }

  getMarketOrderbookMetrics(marketId: string): OrderbookMetrics | null {
    return this.orderbookAnalyzer.getMarketMetrics(marketId);
  }

  getEnhancedMarketMetrics(marketId: string): EnhancedMicrostructureMetrics | null {
    return this.enhancedAnalyzer.getMarketMetrics(marketId);
  }

  getFrontRunningScore(marketId: string): any | null {
    return this.frontRunEngine.getMarketScore(marketId);
  }

  getTopFrontRunningMarkets(limit: number = 10): any[] {
    return this.frontRunEngine.getTopScoringMarkets(limit);
  }

  getTrackedMarkets(): string[] {
    return Array.from(this.trackedMarkets);
  }

  getPerformanceStats(): { [key: string]: number } {
    const totalSignals = Array.from(this.signalCounts.values()).reduce((sum, count) => sum + count, 0);
    const uniqueMarkets = this.trackedMarkets.size;
    const connected = this.webSocketService.isWebSocketConnected();
    
    return {
      totalSignals,
      uniqueMarkets,
      connected: connected ? 1 : 0,
      signalTypes: this.signalCounts.size,
    };
  }

  private async handleTick(tick: TickData): Promise<void> {
    if (!this.isRunning || !this.trackedMarkets.has(tick.marketId)) return;

    try {
      // Detect microstructure signals from tick data
      const signals = this.signalDetector.detectMicrostructureSignals(tick);
      
      for (const signal of signals) {
        this.processSignal(signal);
      }

      // Update performance counters
      this.updateSignalCounts('tick', signals.length);

    } catch (error) {
      logger.error('Error processing tick data:', error);
    }
  }

  private async handleOrderbook(orderbook: OrderbookData): Promise<void> {
    if (!this.isRunning || !this.trackedMarkets.has(orderbook.marketId)) return;

    try {
      // 🔥 ENHANCED: Process with advanced microstructure analyzer
      const enhancedMetrics = this.enhancedAnalyzer.processOrderbook(orderbook);
      
      if (enhancedMetrics) {
        // Detect information leakage patterns
        await this.detectLeakagePatterns(enhancedMetrics, orderbook);
        
        // 🎯 FRONT-RUNNING HEURISTIC ANALYSIS
        await this.analyzeFrontRunningSignals(enhancedMetrics, orderbook);
      }

      // Detect orderbook-based signals
      const signals = this.signalDetector.detectOrderbookSignals(orderbook);
      
      for (const signal of signals) {
        this.processSignal(signal);
      }

      // Also detect pure microstructure signals
      const microSignals = this.orderbookAnalyzer.detectOrderbookSignals(orderbook);
      for (const microSignal of microSignals) {
        this.processMicrostructureSignal(microSignal);
      }

      // 🔥 NEW: Advanced order flow analysis
      const flowSignals = this.orderFlowAnalyzer.analyzeOrderFlow(orderbook);
      for (const flowSignal of flowSignals) {
        this.processOrderFlowSignal(flowSignal, orderbook.marketId);
      }

      // Update performance counters
      const totalSignals = signals.length + microSignals.length + flowSignals.length;
      this.updateSignalCounts('orderbook', totalSignals);

    } catch (error) {
      logger.error('Error processing orderbook data:', error);
    }
  }

  private handleConnectionChange(connected: boolean): void {
    if (connected) {
      logger.info('WebSocket reconnected, resubscribing to markets');
      // Resubscribe to all tracked markets
      for (const marketId of this.trackedMarkets) {
        this.webSocketService.subscribeToMarket(marketId);
      }
    } else {
      logger.warn('WebSocket disconnected');
    }
  }

  private processSignal(signal: EarlySignal): void {
    // Enrich signal with additional context
    const enrichedSignal = this.enrichSignal(signal);
    
    // Log significant signals
    if (enrichedSignal.confidence > 0.7) {
      logger.info(`🔍 High-confidence signal detected:`, {
        type: enrichedSignal.signalType,
        market: enrichedSignal.marketId,
        confidence: enrichedSignal.confidence.toFixed(2),
        severity: enrichedSignal.metadata?.severity,
      });
    }

    // Call handler if set
    if (this.onSignalHandler) {
      this.onSignalHandler(enrichedSignal);
    }
  }

  private processMicrostructureSignal(signal: MicrostructureSignal): void {
    // Log microstructure signals
    logger.debug(`📊 Microstructure signal:`, {
      type: signal.type,
      market: signal.marketId,
      confidence: signal.confidence.toFixed(2),
      severity: signal.severity,
    });

    // Call handler if set
    if (this.onMicrostructureSignalHandler) {
      this.onMicrostructureSignalHandler(signal);
    }
  }

  private async detectLeakagePatterns(metrics: EnhancedMicrostructureMetrics, orderbook: OrderbookData): Promise<void> {
    const marketId = metrics.marketId;
    
    try {
      // 1. LIQUIDITY VACUUM DETECTION
      if (metrics.liquidityVacuum) {
        logger.warn(`🌪️  LIQUIDITY VACUUM detected in ${marketId.substring(0, 8)}...`, {
          depthDrop: metrics.depth1Change.toFixed(1) + '%',
          spreadStable: metrics.spreadChange.toFixed(1) + '%',
          zScore: metrics.depthZScore.toFixed(2)
        });
        
        const vacuumSignal: EarlySignal = {
          marketId,
          market: {} as Market,
          signalType: 'liquidity_vacuum',
          confidence: Math.min(0.95, Math.abs(metrics.depth1Change) / 40),
          timestamp: metrics.timestamp,
          metadata: {
            severity: Math.abs(metrics.depth1Change) > 60 ? 'critical' : 'high',
            signalSource: 'enhanced_microstructure',
            depthDrop: metrics.depth1Change,
            spreadChange: metrics.spreadChange,
            zScore: metrics.depthZScore,
            leakType: 'liquidity_vacuum'
          }
        };
        
        this.processSignal(vacuumSignal);
      }
      
      // 2. STEALTH ACCUMULATION DETECTION (OBI surge with stable spread)
      if (metrics.imbalanceZScore > 3 && Math.abs(metrics.spreadChange) < 10) {
        logger.warn(`🕵️  STEALTH ACCUMULATION detected in ${marketId.substring(0, 8)}...`, {
          imbalanceZScore: metrics.imbalanceZScore.toFixed(2),
          spreadChange: metrics.spreadChange.toFixed(1) + '%',
          imbalance: metrics.orderBookImbalance.toFixed(3)
        });
        
        const stealthSignal: EarlySignal = {
          marketId,
          market: {} as Market,
          signalType: 'stealth_accumulation',
          confidence: Math.min(0.9, metrics.imbalanceZScore / 5),
          timestamp: metrics.timestamp,
          metadata: {
            severity: metrics.imbalanceZScore > 5 ? 'critical' : 'high',
            signalSource: 'enhanced_microstructure',
            imbalanceZScore: metrics.imbalanceZScore,
            orderBookImbalance: metrics.orderBookImbalance,
            spreadStability: metrics.spreadChange,
            leakType: 'stealth_accumulation'
          }
        };
        
        this.processSignal(stealthSignal);
      }
      
      // 3. MICRO-PRICE DRIFT DETECTION
      if (metrics.microPriceDrift > 0) {
        logger.info(`📈 MICRO-PRICE DRIFT detected in ${marketId.substring(0, 8)}...`, {
          drift: metrics.microPriceDrift.toFixed(6),
          slope: metrics.microPriceSlope.toFixed(6),
          microPrice: metrics.microPrice.toFixed(4)
        });
        
        const driftSignal: EarlySignal = {
          marketId,
          market: {} as Market,
          signalType: 'micro_price_drift',
          confidence: Math.min(0.8, metrics.microPriceDrift * 1000), // Scale up small drift values
          timestamp: metrics.timestamp,
          metadata: {
            severity: metrics.microPriceDrift > 0.001 ? 'high' : 'medium',
            signalSource: 'enhanced_microstructure',
            microPriceDrift: metrics.microPriceDrift,
            microPriceSlope: metrics.microPriceSlope,
            microPrice: metrics.microPrice,
            leakType: 'micro_price_drift'
          }
        };
        
        this.processSignal(driftSignal);
      }
      
      // 4. OFF-HOURS ANOMALY DETECTION
      const now = new Date(metrics.timestamp);
      const hour = now.getHours();
      const isOffHours = hour < 6 || hour > 22; // 10 PM - 6 AM EST
      
      if (isOffHours && (metrics.volumeZScore > 3 || metrics.depthZScore > 3)) {
        logger.warn(`🌙 OFF-HOURS ANOMALY detected in ${marketId.substring(0, 8)}...`, {
          hour: hour,
          volumeZ: metrics.volumeZScore.toFixed(2),
          depthZ: metrics.depthZScore.toFixed(2)
        });
        
        const offHoursSignal: EarlySignal = {
          marketId,
          market: {} as Market,
          signalType: 'off_hours_anomaly',
          confidence: Math.min(0.9, Math.max(metrics.volumeZScore, metrics.depthZScore) / 5),
          timestamp: metrics.timestamp,
          metadata: {
            severity: Math.max(metrics.volumeZScore, metrics.depthZScore) > 5 ? 'critical' : 'high',
            signalSource: 'enhanced_microstructure',
            hour: hour,
            volumeZScore: metrics.volumeZScore,
            depthZScore: metrics.depthZScore,
            offHoursFlag: true,
            leakType: 'off_hours_anomaly'
          }
        };
        
        this.processSignal(offHoursSignal);
      }
      
    } catch (error) {
      logger.error('Error detecting leakage patterns:', error);
    }
  }

  private async analyzeFrontRunningSignals(metrics: EnhancedMicrostructureMetrics, orderbook: OrderbookData): Promise<void> {
    try {
      // Create a minimal market object for heuristic analysis
      // In a real implementation, you'd get the full market data
      const mockMarket: Market = {
        id: metrics.marketId,
        question: `Market ${metrics.marketId.substring(0, 8)}...`,
        description: '',
        outcomes: ['Yes', 'No'],
        outcomePrices: [orderbook.midPrice.toString(), (1 - orderbook.midPrice).toString()],
        volume: '0', // We don't have volume in orderbook data
        volumeNum: 10000, // Placeholder volume
        active: true,
        closed: false,
        tags: [],
        metadata: {}
      };
      
      // Calculate front-running score
      const frontRunScore = this.frontRunEngine.calculateFrontRunScore(
        metrics,
        mockMarket,
        [], // No correlated markets for now - would need integration with TopicClusteringEngine
        'unknown' // No topic cluster for now
      );
      
      // Create leak signal if score is significant
      const leakSignal = this.frontRunEngine.createLeakSignal(
        frontRunScore,
        mockMarket,
        []
      );
      
      if (leakSignal) {
        // Process the high-confidence front-running signal
        this.processSignal(leakSignal);
        
        logger.warn(`🎯 FRONT-RUNNING LEAK DETECTED in ${metrics.marketId.substring(0, 8)}...`, {
          score: frontRunScore.score.toFixed(3),
          confidence: frontRunScore.confidence.toFixed(3),
          leakProbability: (frontRunScore.leakProbability * 100).toFixed(1) + '%',
          timeToNews: frontRunScore.timeToNews.toFixed(1) + ' min',
          microPriceDrift: frontRunScore.metadata.microPriceDelta.toFixed(6),
          liquidityDrop: frontRunScore.metadata.liquidityDrop.toFixed(1) + '%'
        });
      }
      
    } catch (error) {
      logger.error('Error analyzing front-running signals:', error);
    }
  }

  private processOrderFlowSignal(flowSignal: any, marketId: string): void {
    // Log order flow signals with different emoji based on severity
    const emoji: { [key: string]: string } = {
      'critical': '🚨',
      'high': '🔥',
      'medium': '⚡',
      'low': '💡'
    };

    logger.info(`${emoji[flowSignal.severity] || '📊'} Order Flow Signal:`, {
      type: flowSignal.type,
      market: marketId.substring(0, 8) + '...',
      severity: flowSignal.severity,
      confidence: flowSignal.confidence.toFixed(2),
      timeHorizon: flowSignal.timeHorizon,
      details: flowSignal.details,
    });

    // Convert to EarlySignal format for Discord alerts
    if (flowSignal.confidence > 0.6) { // Only alert on high-confidence flow signals
      const earlySignal: EarlySignal = {
        marketId,
        market: {} as Market, // Will be enriched later
        signalType: flowSignal.type as any,
        confidence: flowSignal.confidence,
        timestamp: Date.now(),
        metadata: {
          severity: flowSignal.severity,
          signalSource: 'order_flow',
          timeHorizon: flowSignal.timeHorizon,
          flowDetails: flowSignal.details,
        },
      };

      this.processSignal(earlySignal);
    }
  }

  private enrichSignal(signal: EarlySignal): EarlySignal {
    // Add current market indicators for context
    const indicators = this.technicalIndicators.getMarketIndicators(signal.marketId);
    const orderbookMetrics = this.orderbookAnalyzer.getMarketMetrics(signal.marketId);

    return {
      ...signal,
      metadata: {
        ...signal.metadata,
        technicalIndicators: indicators,
        orderbookMetrics: orderbookMetrics,
        detectionTimestamp: Date.now(),
        enrichmentVersion: '1.0',
      },
    };
  }

  private updateSignalCounts(source: string, count: number): void {
    const current = this.signalCounts.get(source) || 0;
    this.signalCounts.set(source, current + count);
  }

  private startPerformanceReporting(): void {
    this.performanceInterval = setInterval(async () => {
      if (!this.isRunning) return;

      try {
        const stats = this.getPerformanceStats();
        const timeSinceLastReport = Date.now() - this.lastPerformanceReport;
        const minutesElapsed = timeSinceLastReport / (1000 * 60);

        logger.info('📈 Performance Report:', {
          totalSignals: stats.totalSignals,
          marketsTracked: stats.uniqueMarkets,
          signalsPerMinute: (stats.totalSignals / minutesElapsed).toFixed(1),
          webSocketConnected: stats.connected === 1,
          uptime: minutesElapsed.toFixed(1) + 'm',
        });

        this.lastPerformanceReport = Date.now();

        // Cleanup stale market data every 5 minutes (with error handling)
        try {
          this.technicalIndicators.cleanupStaleMarkets();
          this.orderbookAnalyzer.cleanupStaleMarkets();
          this.enhancedAnalyzer.cleanupStaleMarkets();
          this.frontRunEngine.cleanup();
        } catch (cleanupError) {
          logger.error('Error during market data cleanup:', cleanupError);
        }
      } catch (error) {
        logger.error('Error in performance reporting interval:', error);
      }
    }, 5 * 60 * 1000); // Report every 5 minutes
  }

  // Utility methods for external monitoring
  async healthCheck(): Promise<{ healthy: boolean; details: any }> {
    const stats = this.getPerformanceStats();
    const connected = this.webSocketService.isWebSocketConnected();
    const enhancedHealth = this.enhancedAnalyzer.healthCheck();
    const frontRunHealth = this.frontRunEngine.healthCheck();
    
    return {
      healthy: this.isRunning && connected && this.trackedMarkets.size > 0 && enhancedHealth.healthy && frontRunHealth.healthy,
      details: {
        running: this.isRunning,
        webSocketConnected: connected,
        marketsTracked: this.trackedMarkets.size,
        totalSignals: stats.totalSignals,
        enhancedAnalyzer: enhancedHealth.details,
        frontRunningEngine: frontRunHealth.details,
        lastUpdate: new Date().toISOString(),
      },
    };
  }

  // Manual signal injection for testing
  injectTestSignal(signal: EarlySignal): void {
    logger.debug('Injecting test signal:', signal);
    this.processSignal(signal);
  }
}