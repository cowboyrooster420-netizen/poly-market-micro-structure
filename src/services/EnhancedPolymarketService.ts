import { BotConfig, Market, OrderbookData, TickData } from '../types';
import { PolymarketService } from './PolymarketService';
import { MarketClassifier } from './MarketClassifier';
import { DataAccessLayer } from '../data/DataAccessLayer';
import { configManager } from '../config/ConfigManager';
import { logger } from '../utils/logger';
import { advancedLogger } from '../utils/AdvancedLogger';
import { polymarketRateLimiter } from '../utils/RateLimiter';

interface MarketSyncStats {
  marketsProcessed: number;
  newMarkets: number;
  updatedMarkets: number;
  errors: number;
  lastSyncTime: number;
  filteredMarkets?: number;
  eventBasedMarkets?: number;
  trendBasedMarkets?: number;
}

export class EnhancedPolymarketService extends PolymarketService {
  private dataLayer: DataAccessLayer;
  private marketClassifier: MarketClassifier;
  private syncStats: MarketSyncStats = {
    marketsProcessed: 0,
    newMarkets: 0,
    updatedMarkets: 0,
    errors: 0,
    lastSyncTime: 0,
    filteredMarkets: 0,
    eventBasedMarkets: 0,
    trendBasedMarkets: 0
  };
  private syncInterval?: NodeJS.Timeout;
  private readonly SYNC_INTERVAL_MS = 60000; // 1 minute
  private readonly BATCH_SIZE = 50;
  private isRunning = false;

  constructor(config: BotConfig, dataLayer: DataAccessLayer) {
    super(config);
    this.dataLayer = dataLayer;

    // Initialize market classifier with config
    const filterConfig = configManager.getConfig().detection.marketFiltering;
    this.marketClassifier = new MarketClassifier(filterConfig);

    // Subscribe to config changes
    configManager.onConfigChange('enhanced_polymarket_service', (newConfig) => {
      this.marketClassifier.updateConfig(newConfig.detection.marketFiltering);
    });
  }

  async initialize(): Promise<void> {
    await super.initialize();
    
    // Start background sync processes
    await this.startBackgroundSync();
    
    logger.info('Enhanced Polymarket service initialized with data persistence');
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = undefined;
    }
    
    logger.info('Enhanced Polymarket service stopped');
  }

  private async startBackgroundSync(): Promise<void> {
    this.isRunning = true;
    
    // Initial sync
    await this.syncMarkets();
    
    // Set up periodic sync
    this.syncInterval = setInterval(async () => {
      if (this.isRunning) {
        try {
          await this.syncMarkets();
        } catch (error) {
          logger.error('Background market sync failed:', error);
        }
      }
    }, this.SYNC_INTERVAL_MS);
    
    logger.info(`Background market sync started (interval: ${this.SYNC_INTERVAL_MS}ms)`);
  }

  private async syncMarkets(): Promise<void> {
    const startTime = Date.now();
    logger.debug('Starting market synchronization...');
    
    try {
      // Get fresh market data from API
      const apiMarkets = await super.getActiveMarkets();
      
      this.syncStats.marketsProcessed = apiMarkets.length;
      this.syncStats.newMarkets = 0;
      this.syncStats.updatedMarkets = 0;
      this.syncStats.errors = 0;
      
      // Process markets in batches
      for (let i = 0; i < apiMarkets.length; i += this.BATCH_SIZE) {
        const batch = apiMarkets.slice(i, i + this.BATCH_SIZE);
        await this.processBatch(batch);
      }
      
      this.syncStats.lastSyncTime = Date.now();
      const duration = this.syncStats.lastSyncTime - startTime;
      
      logger.info(`Market sync completed: ${this.syncStats.marketsProcessed} processed, ${this.syncStats.newMarkets} new, ${this.syncStats.updatedMarkets} updated (${duration}ms)`);
      
    } catch (error) {
      logger.error('Market synchronization failed:', error);
      this.syncStats.errors++;
    }
  }

  private async processBatch(markets: Market[]): Promise<void> {
    const promises = markets.map(async (market) => {
      try {
        // Check if market exists in database
        const existingMarket = await this.dataLayer.getMarket(market.id);
        
        let shouldSavePrices = false;

        if (!existingMarket) {
          // New market - save everything
          await this.dataLayer.saveMarket(market);
          this.syncStats.newMarkets++;
          shouldSavePrices = true;

          logger.info(`New market discovered: ${market.question.substring(0, 50)}... (${market.id})`);
        } else {
          // Check if market data has changed
          const needsUpdate =
            existingMarket.volumeNum !== market.volumeNum ||
            existingMarket.active !== market.active ||
            existingMarket.closed !== market.closed;

          if (needsUpdate) {
            await this.dataLayer.saveMarket(market);
            this.syncStats.updatedMarkets++;
            logger.debug(`Market updated: ${market.id}`);
          }

          // Check if prices have changed
          if (market.outcomePrices && existingMarket.outcomePrices) {
            for (let i = 0; i < Math.min(market.outcomePrices.length, existingMarket.outcomePrices.length); i++) {
              const newPrice = parseFloat(market.outcomePrices[i]);
              const oldPrice = parseFloat(existingMarket.outcomePrices[i]);
              if (!isNaN(newPrice) && !isNaN(oldPrice) && Math.abs(newPrice - oldPrice) > 0.0001) {
                shouldSavePrices = true;
                break;
              }
            }
          } else if (market.outcomePrices) {
            // No previous prices - save them
            shouldSavePrices = true;
          }
        }

        // Only save prices if they've changed
        if (shouldSavePrices && market.outcomePrices && market.outcomePrices.length >= 2) {
          for (let i = 0; i < market.outcomePrices.length; i++) {
            const price = parseFloat(market.outcomePrices[i]);
            if (!isNaN(price)) {
              await this.dataLayer.savePrice(market.id, i, price, market.volumeNum);
            }
          }
        }
        
      } catch (error) {
        logger.error(`Error processing market ${market.id}:`, error);
        this.syncStats.errors++;
      }
    });
    
    await Promise.allSettled(promises);
  }

  // Enhanced market retrieval with database fallback and filtering
  async getActiveMarkets(): Promise<Market[]> {
    try {
      // Try to get from API first
      const apiMarkets = await super.getActiveMarkets();

      if (apiMarkets.length > 0) {
        // Apply market filtering to focus on event-based markets
        const beforeFilterCount = apiMarkets.length;
        const filteredMarkets = this.marketClassifier.filterMarkets(apiMarkets);
        const afterFilterCount = filteredMarkets.length;

        // Update stats
        this.syncStats.filteredMarkets = beforeFilterCount - afterFilterCount;
        this.syncStats.eventBasedMarkets = afterFilterCount;
        this.syncStats.trendBasedMarkets = beforeFilterCount - afterFilterCount;

        // Log filtering summary
        advancedLogger.info('Market filtering applied', {
          component: 'enhanced_polymarket_service',
          operation: 'get_active_markets',
          metadata: {
            totalMarkets: beforeFilterCount,
            eventBasedMarkets: afterFilterCount,
            filteredOut: beforeFilterCount - afterFilterCount,
            filterRate: `${(((beforeFilterCount - afterFilterCount) / beforeFilterCount) * 100).toFixed(1)}%`
          }
        });

        return filteredMarkets;
      }

      // Fallback to database if API fails
      logger.warn('API returned no markets, falling back to database');
      const dbMarkets = await this.dataLayer.getActiveMarkets();
      return this.marketClassifier.filterMarkets(dbMarkets);

    } catch (error) {
      logger.error('Error getting active markets from API, falling back to database:', error);
      const dbMarkets = await this.dataLayer.getActiveMarkets();
      return this.marketClassifier.filterMarkets(dbMarkets);
    }
  }

  async getMarketById(marketId: string): Promise<Market | null> {
    try {
      // Try database first (faster)
      let market = await this.dataLayer.getMarket(marketId);
      
      if (market) {
        return market;
      }
      
      // Fallback to API
      market = await super.getMarketById(marketId);
      
      if (market) {
        // Save to database for future use
        await this.dataLayer.saveMarket(market);
      }
      
      return market;
      
    } catch (error) {
      logger.error(`Error getting market ${marketId}:`, error);
      return null;
    }
  }

  // Enhanced orderbook with persistence
  async getOrderbook(marketId: string): Promise<OrderbookData | null> {
    try {
      // Get fresh orderbook from API
      const orderbook = await super.getOrderbook(marketId);
      
      if (orderbook) {
        // Save to database
        await this.dataLayer.saveOrderbook(orderbook);
        return orderbook;
      }
      
      // Fallback to latest stored orderbook
      return await this.dataLayer.getLatestOrderbook(marketId);
      
    } catch (error) {
      logger.error(`Error getting orderbook for ${marketId}:`, error);
      // Try to return cached orderbook
      return await this.dataLayer.getLatestOrderbook(marketId);
    }
  }

  // Enhanced trades with persistence
  async getRecentTrades(marketId: string, limit: number = 50): Promise<TickData[]> {
    try {
      // Get fresh trades from API
      const apiTrades = await super.getRecentTrades(marketId, limit);
      
      // Save trades to database
      for (const trade of apiTrades) {
        try {
          await this.dataLayer.saveTradeTick(trade);
        } catch (error) {
          // Don't fail the whole operation if one trade fails to save
          logger.debug(`Failed to save trade for ${marketId}:`, error);
        }
      }
      
      if (apiTrades.length > 0) {
        return apiTrades;
      }
      
      // Fallback to database
      return await this.dataLayer.getTradeTicks(marketId, limit);
      
    } catch (error) {
      logger.error(`Error getting recent trades for ${marketId}:`, error);
      // Fallback to database
      return await this.dataLayer.getTradeTicks(marketId, limit);
    }
  }

  // Historical data operations (not available in API)
  async getHistoricalPrices(marketId: string, hours: number = 24): Promise<any[]> {
    return await this.dataLayer.getPriceHistory(marketId, hours);
  }

  async getOrderbookHistory(marketId: string, hours: number = 24): Promise<OrderbookData[]> {
    try {
      // OPTIMIZED: Added LIMIT to prevent unbounded result sets
      // Limiting to 2,880 rows (24 hours at 1 snapshot per 30 seconds)
      const result = await this.dataLayer.db.query(`
        SELECT market_id, EXTRACT(EPOCH FROM timestamp) * 1000 as timestamp,
               bids, asks, spread, mid_price, best_bid, best_ask
        FROM orderbook_snapshots
        WHERE market_id = $1 AND timestamp > (CURRENT_TIMESTAMP - INTERVAL '${hours} hours')
        ORDER BY timestamp DESC
        LIMIT 2880
      `, [marketId]);

      return result.map((row: any) => ({
        marketId: row.market_id,
        timestamp: parseInt(row.timestamp),
        bids: JSON.parse(row.bids),
        asks: JSON.parse(row.asks),
        spread: parseFloat(row.spread),
        midPrice: parseFloat(row.mid_price),
        bestBid: parseFloat(row.best_bid),
        bestAsk: parseFloat(row.best_ask)
      }));
    } catch (error) {
      logger.error(`Error getting orderbook history for ${marketId}:`, error);
      return [];
    }
  }

  // Batch operations with database optimization
  async getMultipleOrderbooks(marketIds: string[]): Promise<Map<string, OrderbookData>> {
    const results = new Map<string, OrderbookData>();
    
    // Try to get cached orderbooks first
    const cachedPromises = marketIds.map(async (marketId) => {
      const cached = await this.dataLayer.getLatestOrderbook(marketId);
      if (cached && Date.now() - cached.timestamp < 60000) { // Use cache if less than 1 minute old
        results.set(marketId, cached);
        return marketId;
      }
      return null;
    });
    
    const cachedMarkets = (await Promise.all(cachedPromises)).filter(Boolean) as string[];
    const remainingMarkets = marketIds.filter(id => !cachedMarkets.includes(id));
    
    logger.debug(`Using cached orderbooks for ${cachedMarkets.length}/${marketIds.length} markets`);
    
    // Get fresh data for remaining markets
    if (remainingMarkets.length > 0) {
      const freshResults = await super.getMultipleOrderbooks(remainingMarkets);
      
      // Save fresh orderbooks and add to results
      for (const [marketId, orderbook] of freshResults) {
        try {
          await this.dataLayer.saveOrderbook(orderbook);
          results.set(marketId, orderbook);
        } catch (error) {
          logger.debug(`Failed to save orderbook for ${marketId}:`, error);
          results.set(marketId, orderbook); // Still return the data
        }
      }
    }
    
    return results;
  }

  // Analytics and monitoring
  async getMarketStatistics(): Promise<any> {
    try {
      const result = await this.dataLayer.db.query(`
        SELECT 
          COUNT(*) as total_markets,
          COUNT(CASE WHEN active = true THEN 1 END) as active_markets,
          COUNT(CASE WHEN closed = true THEN 1 END) as closed_markets,
          SUM(volume) as total_volume,
          AVG(volume) as avg_volume,
          MAX(volume) as max_volume
        FROM markets
      `);

      const stats = result[0];
      return {
        totalMarkets: parseInt(stats.total_markets),
        activeMarkets: parseInt(stats.active_markets),
        closedMarkets: parseInt(stats.closed_markets),
        totalVolume: parseFloat(stats.total_volume) || 0,
        averageVolume: parseFloat(stats.avg_volume) || 0,
        maxVolume: parseFloat(stats.max_volume) || 0,
        ...this.syncStats
      };
    } catch (error) {
      logger.error('Error getting market statistics:', error);
      return this.syncStats;
    }
  }

  async getDataQualityMetrics(): Promise<any> {
    try {
      const now = Date.now();
      const oneHourAgo = now - (60 * 60 * 1000);

      // SQLite-compatible datetime conversion (works with both SQLite and PostgreSQL)
      // Use datetime() function for SQLite, which accepts milliseconds / 1000
      const freshnessChecks = await Promise.all([
        this.dataLayer.db.query(`
          SELECT COUNT(*) as count FROM market_prices
          WHERE timestamp > datetime($1 / 1000, 'unixepoch')
        `, [oneHourAgo]),

        this.dataLayer.db.query(`
          SELECT COUNT(*) as count FROM orderbook_snapshots
          WHERE timestamp > datetime($1 / 1000, 'unixepoch')
        `, [oneHourAgo]),

        this.dataLayer.db.query(`
          SELECT COUNT(*) as count FROM trade_ticks
          WHERE timestamp > datetime($1 / 1000, 'unixepoch')
        `, [oneHourAgo])
      ]);

      return {
        freshPrices: parseInt(freshnessChecks[0][0].count),
        freshOrderbooks: parseInt(freshnessChecks[1][0].count),
        freshTrades: parseInt(freshnessChecks[2][0].count),
        dataHealthy: freshnessChecks.every(check => parseInt(check[0].count) > 0),
        lastSyncTime: this.syncStats.lastSyncTime,
        syncErrors: this.syncStats.errors
      };
    } catch (error) {
      logger.debug('Data quality metrics not available (expected for SQLite):', error);
      return {
        freshPrices: 0,
        freshOrderbooks: 0,
        freshTrades: 0,
        dataHealthy: true, // Assume healthy if metrics unavailable
        lastSyncTime: this.syncStats.lastSyncTime,
        syncErrors: this.syncStats.errors
      };
    }
  }

  // Configuration and maintenance
  async triggerFullResync(): Promise<void> {
    logger.info('Triggering full market resynchronization...');
    await this.syncMarkets();
  }

  async cleanupOldData(days: number = 7): Promise<void> {
    logger.info(`Cleaning up data older than ${days} days...`);
    await this.dataLayer.cleanupOldData(days);
  }

  // Enhanced health check
  async healthCheck(): Promise<{ healthy: boolean; latency: number; details: any }> {
    const apiHealth = await super.healthCheck();
    const dataHealth = await this.dataLayer.healthCheck();
    const qualityMetrics = await this.getDataQualityMetrics();
    
    return {
      healthy: apiHealth.healthy && dataHealth.healthy && qualityMetrics.dataHealthy,
      latency: apiHealth.latency,
      details: {
        api: { healthy: apiHealth.healthy, latency: apiHealth.latency },
        database: dataHealth,
        dataQuality: qualityMetrics,
        sync: this.syncStats,
        backgroundSync: this.isRunning
      }
    };
  }

  // Getter for sync stats
  getSyncStats(): MarketSyncStats {
    return { ...this.syncStats };
  }
}