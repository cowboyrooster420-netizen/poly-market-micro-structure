import { BotConfig, EarlySignal, Market, MicrostructureSignal } from '../types';
import { PolymarketService } from '../services/PolymarketService';
import { SignalDetector } from '../services/SignalDetector';
import { MicrostructureDetector } from '../services/MicrostructureDetector';
import { DiscordAlerter } from '../services/DiscordAlerter';
import { logger } from '../utils/logger';

export class EarlyBot {
  private config: BotConfig;
  private polymarketService: PolymarketService;
  private signalDetector: SignalDetector;
  private microstructureDetector: MicrostructureDetector;
  private discordAlerter: DiscordAlerter;
  private isRunning = false;
  private intervalId?: NodeJS.Timeout;
  private performanceReportInterval?: NodeJS.Timeout;

  constructor() {
    this.config = {
      checkIntervalMs: this.parseIntWithBounds(process.env.CHECK_INTERVAL_MS, 30000, 5000, 300000), // 5s to 5min
      minVolumeThreshold: this.parseIntWithBounds(process.env.MIN_VOLUME_THRESHOLD, 10000, 0, 10000000), // 0 to 10M
      maxMarketsToTrack: this.parseIntWithBounds(process.env.MAX_MARKETS_TO_TRACK, 100, 1, 1000), // 1 to 1000
      logLevel: process.env.LOG_LEVEL || 'info',
      apiUrls: {
        clob: process.env.CLOB_API_URL || 'https://clob.polymarket.com',
        gamma: process.env.GAMMA_API_URL || 'https://gamma-api.polymarket.com',
      },
      microstructure: {
        orderbookImbalanceThreshold: this.parseFloatWithBounds(process.env.ORDERBOOK_IMBALANCE_THRESHOLD, 0.3, 0, 1),
        spreadAnomalyThreshold: this.parseFloatWithBounds(process.env.SPREAD_ANOMALY_THRESHOLD, 2.0, 0.1, 10),
        liquidityShiftThreshold: this.parseFloatWithBounds(process.env.LIQUIDITY_SHIFT_THRESHOLD, 20, 1, 100),
        momentumThreshold: this.parseFloatWithBounds(process.env.MOMENTUM_THRESHOLD, 5, 0.1, 50),
        tickBufferSize: this.parseIntWithBounds(process.env.TICK_BUFFER_SIZE, 1000, 100, 10000), // 100 to 10k
      },
      discord: {
        webhookUrl: process.env.DISCORD_WEBHOOK_URL,
        enableRichEmbeds: process.env.DISCORD_RICH_EMBEDS !== 'false',
        alertRateLimit: this.parseIntWithBounds(process.env.DISCORD_RATE_LIMIT, 10, 1, 100), // 1 to 100
      },
    };

    this.polymarketService = new PolymarketService(this.config);
    this.signalDetector = new SignalDetector(this.config);
    this.microstructureDetector = new MicrostructureDetector(this.config);
    this.discordAlerter = new DiscordAlerter(this.config);
  }

  private parseIntWithBounds(value: string | undefined, defaultValue: number, min: number, max: number): number {
    if (!value) return defaultValue;
    
    const parsed = parseInt(value);
    if (isNaN(parsed)) {
      logger.warn(`Invalid integer value "${value}", using default ${defaultValue}`);
      return defaultValue;
    }
    
    if (parsed < min || parsed > max) {
      logger.warn(`Value ${parsed} out of bounds [${min}, ${max}], using default ${defaultValue}`);
      return defaultValue;
    }
    
    return parsed;
  }

  private parseFloatWithBounds(value: string | undefined, defaultValue: number, min: number, max: number): number {
    if (!value) return defaultValue;
    
    const parsed = parseFloat(value);
    if (isNaN(parsed)) {
      logger.warn(`Invalid float value "${value}", using default ${defaultValue}`);
      return defaultValue;
    }
    
    if (parsed < min || parsed > max) {
      logger.warn(`Value ${parsed} out of bounds [${min}, ${max}], using default ${defaultValue}`);
      return defaultValue;
    }
    
    return parsed;
  }

  async initialize(): Promise<void> {
    logger.info('Initializing Poly Early Bot...');
    
    // Initialize services
    await this.polymarketService.initialize();
    await this.signalDetector.initialize();
    await this.microstructureDetector.initialize();
    
    // Set up event handlers
    this.microstructureDetector.onSignal(this.handleSignal.bind(this));
    this.microstructureDetector.onMicrostructureSignal(this.handleMicrostructureSignal.bind(this));
    
    // Test Discord connection if configured
    if (this.config.discord.webhookUrl) {
      try {
        await this.discordAlerter.sendTestAlert();
        logger.info('Discord webhook connection successful');
      } catch (error) {
        logger.warn('Discord webhook test failed:', error);
      }
    }
    
    logger.info('Bot initialized successfully');
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Bot is already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting real-time microstructure detection...');

    // Start microstructure detection
    await this.microstructureDetector.start();

    // Get high-volume markets for tracking
    const markets = await this.polymarketService.getMarketsWithMinVolume(this.config.minVolumeThreshold);
    const topMarkets = markets
      .sort((a, b) => b.volumeNum - a.volumeNum)
      .slice(0, this.config.maxMarketsToTrack);
    
    logger.info(`Found ${topMarkets.length} markets above volume threshold`);
    
    // Check how many markets have asset IDs for WebSocket subscriptions
    const marketsWithAssets = topMarkets.filter(m => m.metadata?.assetIds && m.metadata.assetIds.length > 0).length;
    logger.info(`${marketsWithAssets}/${topMarkets.length} markets have asset IDs for WebSocket subscriptions`);
    
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

    // Set up performance reporting
    this.performanceReportInterval = setInterval(async () => {
      try {
        await this.sendPerformanceReport();
      } catch (error) {
        logger.error('Error during performance report:', error);
      }
    }, 30 * 60 * 1000); // Every 30 minutes

    logger.info('Real-time detection started successfully');
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }

    if (this.performanceReportInterval) {
      clearInterval(this.performanceReportInterval);
      this.performanceReportInterval = undefined;
    }

    await this.microstructureDetector.stop();

    logger.info('Bot stopped');
  }

  private async refreshMarkets(): Promise<void> {
    logger.info('🔄 Scanning markets for opportunities...');

    try {
      // Get current high-volume markets
      const markets = await this.polymarketService.getMarketsWithMinVolume(this.config.minVolumeThreshold);
      const topMarkets = markets
        .sort((a, b) => b.volumeNum - a.volumeNum)
        .slice(0, this.config.maxMarketsToTrack);
      
      logger.info(`📊 Analyzing ${topMarkets.length} active markets...`);
      
      // DETECT SIGNALS from all markets
      const signals = await this.signalDetector.detectSignals(topMarkets);
      
      // Process any detected signals
      for (const signal of signals) {
        await this.handleSignal(signal);
      }
      
      if (signals.length > 0) {
        logger.info(`🔔 Detected ${signals.length} signals in this scan`);
      } else {
        logger.info('✅ Scan complete - no signals detected (markets are stable)');
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
      logger.error('Error refreshing markets:', error);
    }
  }

  private async handleSignal(signal: EarlySignal): Promise<void> {
    logger.info(`🔍 Signal Detected:`, {
      type: signal.signalType,
      market: signal.marketId.substring(0, 8) + '...',
      confidence: signal.confidence.toFixed(2),
      severity: signal.metadata?.severity,
    });

    // Send Discord alert
    if (this.config.discord.webhookUrl) {
      try {
        await this.discordAlerter.sendAlert(signal);
      } catch (error) {
        logger.error('Error sending Discord alert:', error);
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

  private async sendPerformanceReport(): Promise<void> {
    try {
      const stats = this.microstructureDetector.getPerformanceStats();
      const health = await this.microstructureDetector.healthCheck();
      
      const report = {
        ...stats,
        healthy: health.healthy,
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
    
    return {
      running: this.isRunning,
      microstructureDetector: microHealth,
      polymarketService: polyHealth,
      trackedMarkets: this.microstructureDetector.getTrackedMarkets().length,
      discordConfigured: !!this.config.discord.webhookUrl,
    };
  }
}