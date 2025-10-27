import { BotConfig, EarlySignal, Market, MicrostructureSignal } from '../types';
import { PolymarketService } from '../services/PolymarketService';
import { EnhancedPolymarketService } from '../services/EnhancedPolymarketService';
import { SignalDetector } from '../services/SignalDetector';
import { MicrostructureDetector } from '../services/MicrostructureDetector';
import { DiscordAlerter } from '../services/DiscordAlerter';
import { PrioritizedDiscordNotifier } from '../services/PrioritizedDiscordNotifier';
import { TopicClusteringEngine } from '../services/TopicClusteringEngine';
import { SignalPerformanceTracker } from '../services/SignalPerformanceTracker';
import { DatabaseManager } from '../data/database';
import { DataAccessLayer } from '../data/DataAccessLayer';
import { getDatabaseConfig, validateDatabaseConfig } from '../config/database.config';
import { configManager } from '../config/ConfigManager';
import { logger } from '../utils/logger';
import { advancedLogger } from '../utils/AdvancedLogger';
import { metricsCollector } from '../monitoring/MetricsCollector';
import { errorHandler } from '../utils/ErrorHandler';
import { healthMonitor } from '../utils/HealthMonitor';

export class EarlyBot {
  private config: BotConfig;
  private database: DatabaseManager;
  private dataLayer: DataAccessLayer;
  private polymarketService: EnhancedPolymarketService;
  private signalDetector: SignalDetector;
  private microstructureDetector: MicrostructureDetector;
  private discordAlerter: DiscordAlerter;
  private prioritizedNotifier: PrioritizedDiscordNotifier;
  private topicClusteringEngine: TopicClusteringEngine;
  private signalPerformanceTracker: SignalPerformanceTracker;
  private isRunning = false;
  private intervalId?: NodeJS.Timeout;
  private performanceReportInterval?: NodeJS.Timeout;
  private pnlReportInterval?: NodeJS.Timeout;

  constructor() {
    // Get initial configuration from config manager
    const systemConfig = configManager.getConfig();
    
    this.config = {
      checkIntervalMs: systemConfig.detection.markets.refreshIntervalMs,
      minVolumeThreshold: systemConfig.detection.markets.minVolumeThreshold,
      maxMarketsToTrack: systemConfig.detection.markets.maxMarketsToTrack,
      logLevel: systemConfig.environment.logLevel,
      apiUrls: {
        clob: process.env.CLOB_API_URL || 'https://clob.polymarket.com',
        gamma: process.env.GAMMA_API_URL || 'https://gamma-api.polymarket.com',
      },
      microstructure: {
        orderbookImbalanceThreshold: systemConfig.detection.microstructure.orderbookImbalance.threshold,
        spreadAnomalyThreshold: systemConfig.detection.microstructure.frontRunning.spreadImpactThreshold,
        liquidityShiftThreshold: systemConfig.detection.microstructure.liquidityVacuum.depthDropThreshold,
        tickBufferSize: systemConfig.performance.memory.maxRingBufferSize,
      },
      discord: {
        webhookUrl: process.env.DISCORD_WEBHOOK_URL,
        enableRichEmbeds: process.env.DISCORD_RICH_EMBEDS !== 'false',
        alertRateLimit: systemConfig.detection.alerts.discordRateLimit,
      },
    };
    
    // Subscribe to configuration changes
    configManager.onConfigChange('earlybot', this.onConfigurationChange.bind(this));

    // Initialize database and data layer
    const dbConfig = getDatabaseConfig();
    validateDatabaseConfig(dbConfig);
    this.database = new DatabaseManager(dbConfig);
    this.dataLayer = new DataAccessLayer(this.database);
    
    this.polymarketService = new EnhancedPolymarketService(this.config, this.dataLayer);
    this.signalDetector = new SignalDetector(this.config);
    this.microstructureDetector = new MicrostructureDetector(this.config);
    this.discordAlerter = new DiscordAlerter(this.config);
    this.prioritizedNotifier = new PrioritizedDiscordNotifier(this.config);
    this.topicClusteringEngine = new TopicClusteringEngine();
    this.signalPerformanceTracker = new SignalPerformanceTracker(this.database);
  }

  async initialize(): Promise<void> {
    logger.info('Initializing Poly Early Bot with comprehensive error handling...');
    
    try {
      // Start metrics collection
      metricsCollector.start(60000); // 1-minute intervals
      advancedLogger.info('Bot initialization started', {
        component: 'bot',
        operation: 'initialize'
      });
      // Initialize database first with error handling
      logger.info('Initializing database...');
      await errorHandler.executeWithRetry(
        () => this.database.initialize(),
        'database_initialization',
        { maxRetries: 3, delayMs: 2000 }
      );
      
      // Register health checks
      this.registerHealthChecks();
      
      // Start health monitoring
      healthMonitor.start();
      
      // Log initialization metrics
      metricsCollector.setGauge('bot.initialization_phase', 1);
      
      // Initialize services with error handling
      await errorHandler.executeWithRetry(
        () => this.polymarketService.initialize(),
        'polymarket_service_initialization'
      );
      
      await errorHandler.executeWithRetry(
        () => this.signalDetector.initialize(),
        'signal_detector_initialization'
      );
      
      await errorHandler.executeWithRetry(
        () => this.microstructureDetector.initialize(),
        'microstructure_detector_initialization'
      );

      // Initialize signal performance tracker
      await errorHandler.executeWithRetry(
        () => this.signalPerformanceTracker.initialize(),
        'signal_performance_tracker_initialization'
      );

      // Connect performance tracker to Discord alerter for historical stats
      this.discordAlerter.setPerformanceTracker(this.signalPerformanceTracker);
      this.prioritizedNotifier.setPerformanceTracker(this.signalPerformanceTracker);
      logger.info('Discord alerts will now include historical performance stats');

      // Set up event handlers
      this.microstructureDetector.onSignal(this.createSafeSignalHandler());
      this.microstructureDetector.onMicrostructureSignal(this.createSafeMicrostructureHandler());
      this.microstructureDetector.onOrderbookUpdate((orderbook) => {
        this.polymarketService.updateMarketSpread(orderbook);
      });

      // Test Discord connection if configured
      if (this.config.discord.webhookUrl) {
        try {
          await errorHandler.executeWithRetry(
            () => this.discordAlerter.sendTestAlert(),
            'discord_test_alert',
            { maxRetries: 2, delayMs: 1000 }
          );
          logger.info('Discord webhook connection successful');
        } catch (error) {
          logger.warn('Discord webhook test failed after retries:', error);
        }
      }
      
      // Mark initialization as complete
      metricsCollector.setGauge('bot.initialization_phase', 0);
      metricsCollector.incrementCounter('bot.initialization_success', 1);
      
      advancedLogger.info('Bot initialized successfully with comprehensive monitoring and configuration management', {
        component: 'bot',
        operation: 'initialize',
        metadata: { 
          status: 'success',
          configPreset: this.getActiveConfigurationSummary()
        }
      });
      
    } catch (error) {
      metricsCollector.incrementCounter('bot.initialization_errors', 1);
      advancedLogger.error('Critical error during bot initialization', error as Error, {
        component: 'bot',
        operation: 'initialize'
      });
      errorHandler.handleError(error as Error, { 
        phase: 'initialization',
        component: 'EarlyBot'
      });
      throw error;
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Bot is already running');
      return;
    }

    this.isRunning = true;
    metricsCollector.setGauge('bot.running', 1);
    
    advancedLogger.info('Starting real-time microstructure detection', {
      component: 'bot',
      operation: 'start'
    });

    // Start microstructure detection
    await this.microstructureDetector.start();

    // Start signal performance tracking (background P&L updates)
    await this.signalPerformanceTracker.start();
    logger.info('Signal performance tracking started (P&L updates every 30 minutes)');

    // Get markets using categorizer's smart per-category volume thresholds
    // The categorizer already filters by appropriate volumes (e.g. $2k for earnings, $8k for politics)
    const markets = await advancedLogger.timeOperation(
      () => this.polymarketService.getActiveMarkets(),
      'get_active_markets',
      { component: 'bot', operation: 'start' }
    );
    const topMarkets = markets
      .sort((a, b) => b.volumeNum - a.volumeNum)
      .slice(0, this.config.maxMarketsToTrack);

    // Record market metrics
    metricsCollector.recordMarketMetrics(topMarkets.length, 0);

    advancedLogger.info(`Found ${topMarkets.length} markets after categorizer filtering`, {
      component: 'bot',
      operation: 'market_discovery',
      metadata: { marketCount: topMarkets.length, maxMarketsToTrack: this.config.maxMarketsToTrack }
    });
    
    // Check how many markets have asset IDs for WebSocket subscriptions
    const marketsWithAssets = topMarkets.filter(m => m.metadata?.assetIds && m.metadata.assetIds.length > 0).length;
    metricsCollector.setGauge('markets.with_websocket_assets', marketsWithAssets);
    
    advancedLogger.info(`WebSocket-enabled markets: ${marketsWithAssets}/${topMarkets.length}`, {
      component: 'bot',
      operation: 'websocket_setup',
      metadata: { marketsWithAssets, totalMarkets: topMarkets.length }
    });
    
    if (topMarkets.length > 0) {
      logger.info(`Top market example: "${topMarkets[0].question?.substring(0, 50)}..." - Volume: $${topMarkets[0].volumeNum.toFixed(0)}`);
      
      const firstMarketAssets = topMarkets[0].metadata?.assetIds;
      if (firstMarketAssets && firstMarketAssets.length > 0) {
        logger.info(`Asset IDs: [${firstMarketAssets.map(id => id.substring(0, 8) + '...').join(', ')}]`);
      }
    }
    
    // Track top markets with asset IDs for WebSocket subscriptions
    const marketsToTrack = topMarkets.map(m => ({
      id: m.id,
      assetIds: m.metadata?.assetIds || []
    }));
    this.microstructureDetector.trackMarkets(marketsToTrack);

    // Set up periodic market refresh
    this.intervalId = setInterval(async () => {
      try {
        await this.refreshMarkets();
      } catch (error) {
        logger.error('Error during market refresh:', error);
      }
    }, this.config.checkIntervalMs);

    // Performance reporting disabled - reports had no useful information
    // this.performanceReportInterval = setInterval(async () => {
    //   try {
    //     await this.sendPerformanceReport();
    //   } catch (error) {
    //     logger.error('Error during performance report:', error);
    //   }
    // }, 30 * 60 * 1000); // Every 30 minutes

    // Set up daily P&L report (every 24 hours)
    this.pnlReportInterval = setInterval(async () => {
      try {
        await this.sendDailyPnLReport();
      } catch (error) {
        logger.error('Error during daily P&L report:', error);
      }
    }, 24 * 60 * 60 * 1000); // Every 24 hours

    // Send initial P&L report after 5 minutes (to give time for data collection)
    setTimeout(async () => {
      try {
        await this.sendDailyPnLReport();
      } catch (error) {
        logger.error('Error sending initial P&L report:', error);
      }
    }, 5 * 60 * 1000);

    logger.info('Daily P&L reports scheduled (every 24 hours)');

    metricsCollector.incrementCounter('bot.start_success', 1);
    
    advancedLogger.info('Real-time detection started successfully', {
      component: 'bot',
      operation: 'start',
      metadata: { 
        trackedMarkets: topMarkets.length,
        checkInterval: this.config.checkIntervalMs,
        status: 'success'
      }
    });
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    advancedLogger.info('Stopping bot with graceful shutdown', {
      component: 'bot',
      operation: 'stop'
    });
    
    this.isRunning = false;
    metricsCollector.setGauge('bot.running', 0);
    
    try {
      // Clear intervals
      if (this.intervalId) {
        clearInterval(this.intervalId);
        this.intervalId = undefined;
      }

      if (this.performanceReportInterval) {
        clearInterval(this.performanceReportInterval);
        this.performanceReportInterval = undefined;
      }

      // Stop services with error handling
      await errorHandler.executeWithRetry(
        () => this.microstructureDetector.stop(),
        'microstructure_detector_stop',
        { maxRetries: 2 }
      );
      
      await errorHandler.executeWithRetry(
        () => this.polymarketService.stop(),
        'polymarket_service_stop',
        { maxRetries: 2 }
      );

      // Stop signal performance tracking
      await this.signalPerformanceTracker.stop();
      logger.info('Signal performance tracking stopped');

      // Stop health monitoring
      healthMonitor.stop();
      
      // Stop metrics collection
      metricsCollector.stop();
      
      // Close database connections
      await errorHandler.executeWithRetry(
        () => this.database.close(),
        'database_close',
        { maxRetries: 3 }
      );

      metricsCollector.incrementCounter('bot.stop_success', 1);
      
      advancedLogger.info('Bot stopped gracefully', {
        component: 'bot',
        operation: 'stop',
        metadata: { status: 'success' }
      });
      
    } catch (error) {
      metricsCollector.incrementCounter('bot.stop_errors', 1);
      
      advancedLogger.error('Error during bot shutdown', error as Error, {
        component: 'bot',
        operation: 'stop'
      });
      errorHandler.handleError(error as Error, { 
        phase: 'shutdown',
        component: 'EarlyBot'
      });
    }
  }

  private async refreshMarkets(): Promise<void> {
    const startTime = Date.now();
    
    advancedLogger.info('🔄 Scanning markets for opportunities', {
      component: 'bot',
      operation: 'refresh_markets'
    });

    try {
      // Get markets using categorizer's smart per-category volume thresholds
      const markets = await advancedLogger.timeOperation(
        () => this.polymarketService.getActiveMarkets(),
        'get_active_markets_refresh',
        { component: 'bot', operation: 'refresh_markets' }
      );
      const topMarkets = markets
        .sort((a, b) => b.volumeNum - a.volumeNum)
        .slice(0, this.config.maxMarketsToTrack);

      // Record refresh metrics
      const processingTime = Date.now() - startTime;
      metricsCollector.recordMarketMetrics(topMarkets.length, processingTime);

      advancedLogger.info(`📊 Analyzing ${topMarkets.length} active markets`, {
        component: 'bot',
        operation: 'market_analysis',
        metadata: { marketCount: topMarkets.length, processingTimeMs: processingTime }
      });
      
      // 🧩 CLASSIFY MARKETS INTO TOPIC CLUSTERS for leak detection
      this.topicClusteringEngine.classifyMarkets(topMarkets);
      
      // Log cluster statistics
      const clusterStats = this.topicClusteringEngine.getClusterStatistics();
      const activeClusters = Object.entries(clusterStats).filter(([_, stats]) => stats.marketCount > 0);
      if (activeClusters.length > 0) {
        logger.info(`🏷️  Active clusters: ${activeClusters.map(([name, stats]) => `${name}(${stats.marketCount})`).join(', ')}`);
      }
      
      // DETECT SIGNALS from all markets
      const signals = await advancedLogger.timeOperation(
        () => this.signalDetector.detectSignals(topMarkets),
        'detect_signals',
        { component: 'bot', operation: 'signal_detection' }
      );
      
      // 🔍 DETECT COORDINATED CROSS-MARKET MOVEMENTS (Information Leak Detection)
      // DISABLED: Uses fake random data instead of real price data - generates false signals
      // TODO: Reimplement with actual historical price data tracking
      // await this.detectCrossMarketLeaks(topMarkets);
      
      // Process any detected signals
      for (const signal of signals) {
        await this.handleSignal(signal);
      }
      
      // Record signal metrics
      metricsCollector.setGauge('signals.current_scan_count', signals.length);
      metricsCollector.incrementCounter('scans.completed', 1);
      
      if (signals.length > 0) {
        advancedLogger.warn(`🔔 Detected ${signals.length} signals in this scan`, {
          component: 'bot',
          operation: 'signal_processing',
          metadata: { signalCount: signals.length }
        });
      } else {
        advancedLogger.info('✅ Scan complete - no signals detected (markets are stable)', {
          component: 'bot',
          operation: 'signal_processing',
          metadata: { signalCount: 0, status: 'stable' }
        });
      }
      
      const newMarketIds = new Set(topMarkets.map(m => m.id));
      const currentMarketIds = new Set(this.microstructureDetector.getTrackedMarkets());

      // Add new markets
      const marketsToAdd = topMarkets.filter(m => !currentMarketIds.has(m.id));
      if (marketsToAdd.length > 0) {
        const newMarketsToTrack = marketsToAdd.map(m => ({
          id: m.id,
          assetIds: m.metadata?.assetIds || []
        }));
        this.microstructureDetector.trackMarkets(newMarketsToTrack);
        logger.info(`Added ${marketsToAdd.length} new markets for tracking`);
      }

      // Remove markets that no longer meet criteria
      const marketsToRemove = Array.from(currentMarketIds).filter(id => !newMarketIds.has(id));
      for (const marketId of marketsToRemove) {
        this.microstructureDetector.untrackMarket(marketId);
      }
      
      if (marketsToRemove.length > 0) {
        logger.info(`Removed ${marketsToRemove.length} markets from tracking`);
      }

    } catch (error) {
      metricsCollector.incrementCounter('scans.errors', 1);
      
      advancedLogger.error('Error refreshing markets', error as Error, {
        component: 'bot',
        operation: 'refresh_markets'
      });
    }
  }

  private async handleSignal(signal: EarlySignal): Promise<void> {
    // Log signal with advanced logger
    advancedLogger.logSignalDetection(
      signal.signalType,
      signal.marketId,
      signal.confidence,
      signal.metadata
    );
    
    // Record signal metrics
    metricsCollector.recordSignalMetrics(
      signal.signalType,
      signal.confidence,
      signal.marketId
    );

    // Save signal to database
    try {
      await advancedLogger.timeOperation(
        () => this.dataLayer.saveSignal(signal),
        'save_signal_to_database',
        {
          component: 'bot',
          operation: 'signal_persistence',
          signalType: signal.signalType,
          marketId: signal.marketId
        }
      );

      metricsCollector.incrementCounter('signals.saved_to_database', 1);
    } catch (error) {
      metricsCollector.incrementCounter('signals.database_save_errors', 1);
      advancedLogger.error('Error saving signal to database', error as Error, {
        component: 'bot',
        operation: 'signal_persistence',
        signalType: signal.signalType,
        marketId: signal.marketId
      });
    }

    // Track signal performance (P&L tracking)
    if (signal.market) {
      try {
        const performanceRecordId = await this.signalPerformanceTracker.trackSignal(signal, signal.market);
        advancedLogger.info('Signal performance tracking started', {
          component: 'bot',
          operation: 'performance_tracking',
          metadata: {
            signalType: signal.signalType,
            marketId: signal.marketId,
            performanceRecordId
          }
        });
      } catch (error) {
        advancedLogger.error('Error starting signal performance tracking', error as Error, {
          component: 'bot',
          operation: 'performance_tracking',
          signalType: signal.signalType,
          marketId: signal.marketId
        });
      }
    }

    // Send Discord alert through prioritized notification system
    if (this.config.discord.webhookUrl) {
      try {
        // Refresh market data from cache to get latest spread from orderbook updates
        const cachedMarket = this.polymarketService.getCachedMarket(signal.marketId);
        if (cachedMarket) {
          if (cachedMarket.spread !== undefined) {
            signal.market = cachedMarket;
            advancedLogger.info(`Updated signal with cached market data - spread: ${cachedMarket.spread} bps`, {
              component: 'bot',
              operation: 'refresh_market_data',
              metadata: {
                marketId: signal.marketId,
                spread: cachedMarket.spread,
                volume: cachedMarket.volumeNum
              }
            });
          } else {
            signal.market = cachedMarket;
            advancedLogger.warn(`Market in cache but spread not yet populated - may show N/A`, {
              component: 'bot',
              operation: 'refresh_market_data',
              metadata: {
                marketId: signal.marketId,
                question: cachedMarket.question?.substring(0, 50)
              }
            });
          }
        } else {
          advancedLogger.warn(`Market not in cache - spread will show N/A`, {
            component: 'bot',
            operation: 'refresh_market_data',
            metadata: {
              marketId: signal.marketId,
              question: signal.market?.question?.substring(0, 50)
            }
          });
        }

        const { sent, decision } = await advancedLogger.timeOperation(
          () => this.prioritizedNotifier.processSignal(signal),
          'send_prioritized_alert',
          {
            component: 'bot',
            operation: 'prioritized_notification',
            signalType: signal.signalType
          }
        );

        if (sent) {
          advancedLogger.info(`Priority alert sent: ${decision.priority}`, {
            component: 'bot',
            operation: 'prioritized_notification',
            metadata: {
              marketId: signal.marketId,
              priority: decision.priority,
              score: decision.adjustedScore,
              signalType: signal.signalType
            }
          });
          metricsCollector.incrementCounter('alerts.prioritized_sent');
        } else {
          advancedLogger.info(`Alert filtered: ${decision.reason}`, {
            component: 'bot',
            operation: 'prioritized_notification',
            metadata: {
              marketId: signal.marketId,
              priority: decision.priority,
              score: decision.adjustedScore,
              reason: decision.reason
            }
          });
          metricsCollector.incrementCounter('alerts.prioritized_filtered');
        }
      } catch (error) {
        metricsCollector.incrementCounter('alerts.prioritized_errors');
        advancedLogger.error('Error sending prioritized alert', error as Error, {
          component: 'bot',
          operation: 'prioritized_notification',
          signalType: signal.signalType
        });
      }
    }
  }

  private async handleMicrostructureSignal(signal: MicrostructureSignal): Promise<void> {
    logger.debug(`📊 Microstructure Signal:`, {
      type: signal.type,
      market: signal.marketId.substring(0, 8) + '...',
      confidence: signal.confidence.toFixed(2),
      severity: signal.severity,
    });

    // Send microstructure alert for high-confidence signals
    if (signal.confidence > 0.8 && this.config.discord.webhookUrl) {
      try {
        await this.discordAlerter.sendMicrostructureAlert(signal);
      } catch (error) {
        logger.error('Error sending microstructure alert:', error);
      }
    }
  }

  private async detectCrossMarketLeaks(markets: Market[]): Promise<void> {
    try {
      // Get all entity clusters to check for coordinated movements
      const entityClusters = this.topicClusteringEngine.getAllEntityClusters();
      
      for (const entityCluster of entityClusters) {
        if (entityCluster.marketCount < 2) continue; // Need at least 2 markets for correlation
        
        const entityMarkets = this.topicClusteringEngine.getEntityMarkets(entityCluster.entity);
        if (entityMarkets.length < 2) continue;
        
        // Calculate simple price changes (placeholder - in real implementation would use historical data)
        const priceChanges = new Map<string, number>();
        for (const market of entityMarkets) {
          // For now, use volume change as a proxy for price movement
          // In real implementation, you'd track actual price changes over time
          const volumeChange = Math.random() * 10 - 5; // Placeholder random change -5% to +5%
          priceChanges.set(market.id, volumeChange);
        }
        
        // Detect coordinated movements
        const coordinatedMove = this.topicClusteringEngine.detectCoordinatedMovements(
          entityCluster.entity,
          priceChanges,
          2.0 // 2 sigma threshold
        );
        
        if (coordinatedMove) {
          logger.warn(`🚨 COORDINATED MOVEMENT DETECTED in ${entityCluster.entity}:`, {
            markets: coordinatedMove.markets.length,
            avgChange: coordinatedMove.averageChange.toFixed(2) + '%',
            correlation: coordinatedMove.correlationScore.toFixed(2),
            marketNames: coordinatedMove.markets.map(m => m.question?.substring(0, 30) + '...').join(', ')
          });
          
          // Create leak detection signal
          const leakSignal: EarlySignal = {
            marketId: coordinatedMove.markets[0].id, // Primary market
            market: coordinatedMove.markets[0],
            signalType: 'coordinated_cross_market',
            confidence: coordinatedMove.correlationScore,
            timestamp: Date.now(),
            metadata: {
              severity: coordinatedMove.correlationScore > 0.7 ? 'critical' : 'high',
              signalSource: 'cross_market_leak_detection',
              entityCluster: entityCluster.entity,
              correlatedMarkets: coordinatedMove.markets.map(m => m.id),
              averageChange: coordinatedMove.averageChange,
              correlationScore: coordinatedMove.correlationScore,
              marketCount: coordinatedMove.markets.length,
              leakType: 'coordinated_cross_market'
            }
          };
          
          await this.handleSignal(leakSignal);
        }
      }
      
    } catch (error) {
      logger.error('Error detecting cross-market leaks:', error);
    }
  }

  private async sendPerformanceReport(): Promise<void> {
    try {
      const stats = this.microstructureDetector.getPerformanceStats();
      const health = await this.microstructureDetector.healthCheck();
      const clusterHealth = this.topicClusteringEngine.healthCheck();

      const report = {
        ...stats,
        healthy: health.healthy && clusterHealth.healthy,
        clustering: clusterHealth.details,
        timestamp: new Date().toISOString(),
      };

      if (this.config.discord.webhookUrl) {
        await this.discordAlerter.sendPerformanceReport(report);
      }

      logger.info('Performance report sent');
    } catch (error) {
      logger.error('Error sending performance report:', error);
    }
  }

  /**
   * Send daily P&L report showing signal performance and profitability
   */
  private async sendDailyPnLReport(): Promise<void> {
    try {
      const allStats = await this.signalPerformanceTracker.getAllSignalTypeStats();

      if (allStats.length === 0) {
        logger.info('No signal performance data available yet for daily P&L report');
        return;
      }

      if (this.config.discord.webhookUrl) {
        await this.discordAlerter.sendPnLReport(allStats);
        logger.info('Daily P&L report sent');
      }
    } catch (error) {
      logger.error('Error sending daily P&L report:', error);
    }
  }

  /**
   * Send test notifications at all priority levels
   */
  async sendTestPrioritizedNotifications(): Promise<void> {
    if (!this.config.discord.webhookUrl) {
      logger.warn('Discord webhook not configured, skipping test notifications');
      return;
    }

    try {
      logger.info('Sending test notifications for all priority levels...');
      const results = await this.prioritizedNotifier.sendTestNotifications();

      // Log results
      for (const [priority, success] of Object.entries(results)) {
        if (success) {
          logger.info(`✅ ${priority} priority test notification sent successfully`);
        } else {
          logger.error(`❌ ${priority} priority test notification failed`);
        }
      }

      logger.info('Test notifications complete');
    } catch (error) {
      logger.error('Error sending test notifications:', error);
    }
  }

  // Public methods for external control
  async addMarket(marketId: string): Promise<void> {
    // Try to get market details to extract asset IDs
    try {
      const market = await this.polymarketService.getMarketById(marketId);
      const assetIds = market?.metadata?.assetIds || [];
      this.microstructureDetector.trackMarket(marketId, assetIds);
      logger.info(`Manually added market: ${marketId.substring(0, 8)}... with ${assetIds.length} assets`);
    } catch (error) {
      // Fallback to just market ID if can't fetch details
      this.microstructureDetector.trackMarket(marketId);
      logger.info(`Manually added market: ${marketId.substring(0, 8)}... (no asset IDs)`);
    }
  }

  async removeMarket(marketId: string): Promise<void> {
    this.microstructureDetector.untrackMarket(marketId);
    logger.info(`Manually removed market: ${marketId}`);
  }

  getTrackedMarkets(): string[] {
    return this.microstructureDetector.getTrackedMarkets();
  }

  async getHealthStatus(): Promise<any> {
    const microHealth = await this.microstructureDetector.healthCheck();
    const polyHealth = await this.polymarketService.healthCheck();
    const clusterHealth = this.topicClusteringEngine.healthCheck();
    const dataHealth = await this.dataLayer.healthCheck();
    const systemHealth = healthMonitor.getSystemHealth();
    const errorStats = errorHandler.getErrorStatistics();
    const notificationStats = this.prioritizedNotifier.getStats();

    return {
      running: this.isRunning,
      overall: systemHealth.overall,
      score: systemHealth.score,
      uptime: systemHealth.uptime,
      microstructureDetector: microHealth,
      polymarketService: polyHealth,
      topicClustering: clusterHealth,
      dataLayer: dataHealth,
      systemHealth: systemHealth,
      errorStatistics: {
        totalErrors: errorStats.totalErrors,
        recentErrorRate: errorStats.recentErrorRate,
        circuitBreakers: Object.fromEntries(
          Array.from(errorStats.circuitBreakerStates.entries())
            .map(([key, state]) => [key, state.state])
        )
      },
      prioritizedNotifications: {
        configured: notificationStats.configured,
        alertManagerStats: notificationStats.alertManagerStats,
        rateLimitStatus: notificationStats.rateLimitStatus
      },
      trackedMarkets: this.microstructureDetector.getTrackedMarkets().length,
      discordConfigured: !!this.config.discord.webhookUrl,
      configurationManager: this.getConfigurationStatus(),
    };
  }

  /**
   * Register health checks for all components
   */
  private registerHealthChecks(): void {
    // Register standard system health checks
    healthMonitor.registerStandardHealthChecks();

    // Register database health check
    healthMonitor.registerHealthCheck({
      name: 'database',
      check: async () => {
        const health = await this.database.healthCheck();
        return {
          healthy: health.healthy,
          metrics: health.details
        };
      },
      interval: 30000,
      timeout: 10000,
      critical: true
    });

    // Register polymarket service health check
    healthMonitor.registerHealthCheck({
      name: 'polymarket-service',
      check: async () => {
        const health = await this.polymarketService.healthCheck();
        return {
          healthy: health.healthy,
          metrics: health.details
        };
      },
      interval: 60000,
      timeout: 15000,
      critical: false
    });

    // Register microstructure detector health check
    healthMonitor.registerHealthCheck({
      name: 'microstructure-detector',
      check: async () => {
        const health = await this.microstructureDetector.healthCheck();
        return {
          healthy: health.healthy,
          metrics: health.details
        };
      },
      interval: 45000,
      timeout: 10000,
      critical: true
    });

    logger.info('Health checks registered for all components');
  }

  /**
   * Create safe signal handler with error handling
   */
  private createSafeSignalHandler(): (signal: EarlySignal) => Promise<void> {
    return errorHandler.createSafeWrapper(
      this.handleSignal.bind(this),
      'signal_handling',
      {
        retryConfig: { maxRetries: 2, delayMs: 1000 },
        fallback: async (signal: EarlySignal) => {
          logger.warn(`Signal handling fallback for ${signal.signalType} on market ${signal.marketId}`);
          // Log signal to database without Discord notification
          try {
            await this.dataLayer.saveSignal(signal);
          } catch (error) {
            logger.error('Failed to save signal even in fallback mode:', error);
          }
        }
      }
    );
  }

  /**
   * Create safe microstructure signal handler with error handling
   */
  private createSafeMicrostructureHandler(): (signal: MicrostructureSignal) => Promise<void> {
    return errorHandler.createSafeWrapper(
      this.handleMicrostructureSignal.bind(this),
      'microstructure_signal_handling',
      {
        retryConfig: { maxRetries: 1, delayMs: 500 }
      }
    );
  }

  /**
   * Handle configuration changes at runtime
   */
  private onConfigurationChange(newConfig: any): void {
    try {
      const oldConfig = { ...this.config };
      
      // Update bot configuration from new system config
      this.config.checkIntervalMs = newConfig.detection.markets.refreshIntervalMs;
      this.config.minVolumeThreshold = newConfig.detection.markets.minVolumeThreshold;
      this.config.maxMarketsToTrack = newConfig.detection.markets.maxMarketsToTrack;
      this.config.microstructure.orderbookImbalanceThreshold = newConfig.detection.microstructure.orderbookImbalance.threshold;
      this.config.microstructure.liquidityShiftThreshold = newConfig.detection.microstructure.liquidityVacuum.depthDropThreshold;
      this.config.discord.alertRateLimit = newConfig.detection.alerts.discordRateLimit;
      
      // Log configuration changes
      const changes = this.getConfigurationChanges(oldConfig, this.config);
      if (changes.length > 0) {
        advancedLogger.info('Configuration updated at runtime', {
          component: 'bot',
          operation: 'config_change',
          metadata: { 
            changes,
            newSummary: this.getActiveConfigurationSummary()
          }
        });
        
        // Update metrics
        metricsCollector.incrementCounter('bot.config_updates', 1);
        
        // Restart intervals if timing changed
        if (oldConfig.checkIntervalMs !== this.config.checkIntervalMs && this.isRunning) {
          this.restartPeriodicOperations();
        }
      }
      
    } catch (error) {
      advancedLogger.error('Error handling configuration change', error as Error, {
        component: 'bot',
        operation: 'config_change'
      });
    }
  }

  /**
   * Get active configuration summary for logging
   */
  private getActiveConfigurationSummary(): Record<string, any> {
    const systemConfig = configManager.getConfig();
    return {
      volumeThreshold: systemConfig.detection.signals.volumeSpike.multiplier,
      priceThreshold: systemConfig.detection.signals.priceMovement.percentageThreshold,
      correlationThreshold: systemConfig.detection.signals.crossMarketCorrelation.correlationThreshold,
      zScoreThreshold: systemConfig.detection.statistical.anomalyDetection.zScoreThreshold,
      maxMarkets: systemConfig.detection.markets.maxMarketsToTrack,
      minVolume: systemConfig.detection.markets.minVolumeThreshold,
      refreshInterval: systemConfig.detection.markets.refreshIntervalMs / 1000
    };
  }

  /**
   * Get configuration changes between old and new config
   */
  private getConfigurationChanges(oldConfig: BotConfig, newConfig: BotConfig): string[] {
    const changes: string[] = [];
    
    if (oldConfig.checkIntervalMs !== newConfig.checkIntervalMs) {
      changes.push(`refreshInterval: ${oldConfig.checkIntervalMs/1000}s → ${newConfig.checkIntervalMs/1000}s`);
    }
    if (oldConfig.minVolumeThreshold !== newConfig.minVolumeThreshold) {
      changes.push(`minVolume: $${oldConfig.minVolumeThreshold} → $${newConfig.minVolumeThreshold}`);
    }
    if (oldConfig.maxMarketsToTrack !== newConfig.maxMarketsToTrack) {
      changes.push(`maxMarkets: ${oldConfig.maxMarketsToTrack} → ${newConfig.maxMarketsToTrack}`);
    }
    if (oldConfig.microstructure.orderbookImbalanceThreshold !== newConfig.microstructure.orderbookImbalanceThreshold) {
      changes.push(`imbalanceThreshold: ${oldConfig.microstructure.orderbookImbalanceThreshold} → ${newConfig.microstructure.orderbookImbalanceThreshold}`);
    }
    if (oldConfig.discord.alertRateLimit !== newConfig.discord.alertRateLimit) {
      changes.push(`discordRateLimit: ${oldConfig.discord.alertRateLimit} → ${newConfig.discord.alertRateLimit}`);
    }
    
    return changes;
  }

  /**
   * Restart periodic operations with new timing
   */
  private restartPeriodicOperations(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      
      this.intervalId = setInterval(async () => {
        try {
          await this.refreshMarkets();
        } catch (error) {
          logger.error('Error during market refresh:', error);
        }
      }, this.config.checkIntervalMs);
      
      advancedLogger.info('Restarted periodic operations with new interval', {
        component: 'bot',
        operation: 'restart_intervals',
        metadata: { newIntervalMs: this.config.checkIntervalMs }
      });
    }
  }

  /**
   * Get current configuration management status
   */
  public getConfigurationStatus(): any {
    const systemConfig = configManager.getConfig();
    return {
      configManager: {
        available: true,
        configFile: 'config/detection-config.json',
        lastUpdate: Date.now()
      },
      activeConfiguration: this.getActiveConfigurationSummary(),
      features: systemConfig.features,
      performance: {
        maxConcurrentRequests: systemConfig.performance.processing.maxConcurrentRequests,
        requestTimeout: systemConfig.performance.processing.requestTimeoutMs,
        maxDataPoints: systemConfig.performance.memory.maxHistoricalDataPoints,
        bufferSize: systemConfig.performance.memory.maxRingBufferSize
      }
    };
  }
}