import { 
  BotConfig, 
  EarlySignal, 
  TickData, 
  OrderbookData, 
  Market,
  MicrostructureSignal,
  TechnicalIndicators,
  OrderbookMetrics 
} from '../types';
import { SignalDetector } from './SignalDetector';
import { OrderbookAnalyzer } from './OrderbookAnalyzer';
import { TechnicalIndicatorCalculator } from './TechnicalIndicators';
import { WebSocketService } from './WebSocketService';
import { OrderFlowAnalyzer } from './OrderFlowAnalyzer';
import { logger } from '../utils/logger';

export class MicrostructureDetector {
  private config: BotConfig;
  private signalDetector: SignalDetector;
  private orderbookAnalyzer: OrderbookAnalyzer;
  private technicalIndicators: TechnicalIndicatorCalculator;
  private orderFlowAnalyzer: OrderFlowAnalyzer;
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
      this.updateSignalCounts('orderbook', signals.length + microSignals.length + flowSignals.length);

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
    
    return {
      healthy: this.isRunning && connected && this.trackedMarkets.size > 0,
      details: {
        running: this.isRunning,
        webSocketConnected: connected,
        marketsTracked: this.trackedMarkets.size,
        totalSignals: stats.totalSignals,
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