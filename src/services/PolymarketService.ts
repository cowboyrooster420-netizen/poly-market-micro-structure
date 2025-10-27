import { BotConfig, Market, OrderbookData, OrderbookLevel, TickData } from '../types';
import { logger } from '../utils/logger';
import { advancedLogger } from '../utils/AdvancedLogger';
import { metricsCollector } from '../monitoring/MetricsCollector';
import { polymarketRateLimiter } from '../utils/RateLimiter';
import { MarketCategorizer } from './MarketCategorizer';
import { configManager } from '../config/ConfigManager';

// Helper function to add timeout to fetch requests
function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs: number = 10000): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  return fetch(url, {
    ...options,
    signal: controller.signal,
  }).finally(() => {
    clearTimeout(timeoutId);
  });
}

export class PolymarketService {
  private config: BotConfig;
  protected categorizer: MarketCategorizer;
  private marketCache: Map<string, Market> = new Map(); // Cache markets to update spread from orderbook
  private assetIdToMarketId: Map<string, string> = new Map(); // Map asset IDs to market IDs for spread updates

  constructor(config: BotConfig) {
    this.config = config;

    // Initialize categorizer with full configuration from ConfigManager
    const detectionConfig = configManager.getConfig().detection;
    const volumeThresholds = detectionConfig.categoryVolumeThresholds;
    const watchlistCriteria = detectionConfig.marketTiers.watchlist;
    const opportunityScoringConfig = detectionConfig.opportunityScoring;
    this.categorizer = new MarketCategorizer(volumeThresholds, watchlistCriteria, opportunityScoringConfig);

    // Subscribe to config changes to update all configurations dynamically
    configManager.onConfigChange('polymarket_service', (newConfig) => {
      const newDetection = newConfig.detection;
      this.categorizer.updateVolumeThresholds(newDetection.categoryVolumeThresholds);
      this.categorizer.updateWatchlistCriteria(newDetection.marketTiers.watchlist);
      this.categorizer.updateOpportunityScoringConfig(newDetection.opportunityScoring);
    });
  }

  async initialize(): Promise<void> {
    logger.debug('Initializing Polymarket service...');
    // Test API connectivity
    try {
      await this.testConnection();
      logger.debug('Polymarket API connection successful');
    } catch (error) {
      logger.error('Failed to connect to Polymarket API:', error);
      throw error;
    }
  }

  async getActiveMarkets(): Promise<Market[]> {
    const startTime = Date.now();

    try {
      // Fetch via /events endpoint (recommended by API docs for complete market coverage)
      // Events contain embedded markets, and we can order by volume for better prioritization
      const allEvents: any[] = [];
      const batchSize = 1000;
      const maxEvents = 5000;
      let offset = 0;
      let hasMore = true;

      while (hasMore && allEvents.length < maxEvents) {
        const response = await advancedLogger.timeOperation(
          () => polymarketRateLimiter.execute(async () => {
            return fetchWithTimeout(
              `${this.config.apiUrls.gamma}/events?active=true&closed=false&order=volume&ascending=false&limit=${batchSize}&offset=${offset}`,
              {},
              15000
            );
          }),
          'polymarket_get_active_events_batch',
          { component: 'polymarket_service', operation: 'get_active_markets', metadata: { offset, batchSize } }
        );

        if (!response.ok) {
          throw new Error(`API request failed: ${response.status}`);
        }

        const events: any = await response.json();
        const eventsList = Array.isArray(events) ? events : [];

        if (eventsList.length === 0) {
          // No more events available
          hasMore = false;
        } else {
          allEvents.push(...eventsList);
          offset += eventsList.length;

          // If we got fewer than requested, we've reached the end
          if (eventsList.length < batchSize) {
            hasMore = false;
          }

          logger.info(`Fetched ${eventsList.length} events (offset ${offset - eventsList.length}, total: ${allEvents.length})`);
        }
      }

      logger.info(`📥 Fetched ${allEvents.length} total events from Gamma API`);

      // Extract markets from events (each event contains a markets array)
      const allMarkets: any[] = [];
      const marketIds = new Set<string>();

      for (const event of allEvents) {
        if (event.markets && Array.isArray(event.markets)) {
          for (const market of event.markets) {
            // Deduplicate by market ID (same market might appear in multiple events)
            const marketId = market.id || market.condition_id || market.conditionId;
            if (marketId && !marketIds.has(marketId)) {
              marketIds.add(marketId);
              allMarkets.push(market);
            }
          }
        }
      }

      logger.info(`📥 Extracted ${allMarkets.length} unique markets from ${allEvents.length} events`);

      const transformedMarkets = this.transformMarkets(allMarkets);

      // Apply tier assignment (categorization + volume filtering + watchlist logic)
      const tierResult = this.categorizer.assignTiers(transformedMarkets);

      // Return combined ACTIVE + WATCHLIST markets (ignore IGNORED tier)
      const monitoredMarkets = [...tierResult.active, ...tierResult.watchlist];

      // Analyze asset ID coverage by category to diagnose extraction issues
      const assetIdStats: Record<string, {with: number, without: number}> = {};
      const marketsWithAssets = monitoredMarkets.filter(m => m.metadata?.assetIds && m.metadata.assetIds.length > 0);
      const marketsWithoutAssets = monitoredMarkets.filter(m => !m.metadata?.assetIds || m.metadata.assetIds.length === 0);

      for (const market of marketsWithAssets) {
        const cat = market.category || 'uncategorized';
        if (!assetIdStats[cat]) assetIdStats[cat] = {with: 0, without: 0};
        assetIdStats[cat].with++;
      }
      for (const market of marketsWithoutAssets) {
        const cat = market.category || 'uncategorized';
        if (!assetIdStats[cat]) assetIdStats[cat] = {with: 0, without: 0};
        assetIdStats[cat].without++;
      }

      logger.info(`📊 Asset ID coverage by category: ${Object.entries(assetIdStats)
        .map(([cat, stats]) => `${cat}(${stats.with}✅/${stats.without}❌)`)
        .join(', ')}`);

      // Calculate opportunity score statistics
      const scores = monitoredMarkets.map(m => m.opportunityScore || 0);
      const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
      const maxScore = scores.length > 0 ? Math.max(...scores) : 0;
      const minScore = scores.length > 0 ? Math.min(...scores) : 0;
      const highScoreMarkets = scores.filter(s => s >= 70).length;
      const mediumScoreMarkets = scores.filter(s => s >= 50 && s < 70).length;
      const lowScoreMarkets = scores.filter(s => s < 50).length;

      // Record metrics
      const duration = Date.now() - startTime;
      metricsCollector.recordDatabaseMetrics('get_active_markets', duration, true);
      metricsCollector.setGauge('polymarket.total_markets_fetched', transformedMarkets.length);
      metricsCollector.setGauge('polymarket.active_tier_count', tierResult.active.length);
      metricsCollector.setGauge('polymarket.watchlist_tier_count', tierResult.watchlist.length);
      metricsCollector.setGauge('polymarket.ignored_tier_count', tierResult.ignored.length);
      metricsCollector.setGauge('polymarket.avg_opportunity_score', Math.round(avgScore));
      metricsCollector.setGauge('polymarket.max_opportunity_score', Math.round(maxScore));
      metricsCollector.setGauge('polymarket.high_score_markets', highScoreMarkets);

      advancedLogger.info(`Fetched and tiered markets with opportunity scoring`, {
        component: 'polymarket_service',
        operation: 'get_active_markets',
        metadata: {
          totalMarkets: transformedMarkets.length,
          activeTier: tierResult.active.length,
          watchlistTier: tierResult.watchlist.length,
          ignoredTier: tierResult.ignored.length,
          monitoredMarkets: monitoredMarkets.length,
          watchlistUtilization: tierResult.stats.watchlist,
          opportunityScores: {
            average: Math.round(avgScore * 10) / 10,
            max: Math.round(maxScore),
            min: Math.round(minScore),
            highScore: highScoreMarkets,
            mediumScore: mediumScoreMarkets,
            lowScore: lowScoreMarkets
          },
          durationMs: duration
        }
      });

      return monitoredMarkets;
    } catch (error) {
      const duration = Date.now() - startTime;
      metricsCollector.recordDatabaseMetrics('get_active_markets', duration, false);

      advancedLogger.error('Error fetching active markets', error as Error, {
        component: 'polymarket_service',
        operation: 'get_active_markets'
      });

      throw error;
    }
  }

  async getMarketById(marketId: string): Promise<Market | null> {
    try {
      // Try to fetch single market by condition_id query parameter
      // This is much more efficient than fetching all 1000 markets
      const response = await polymarketRateLimiter.execute(async () => {
        return fetchWithTimeout(
          `${this.config.apiUrls.gamma}/markets?condition_id=${marketId}`,
          {},
          10000
        );
      });

      if (!response.ok) {
        // If query parameter doesn't work, fall back to searching all markets
        // This ensures backward compatibility
        logger.debug(`Direct market query failed (${response.status}), falling back to search`);
        const markets = await this.getActiveMarkets();
        const market = markets.find(m => m.id === marketId || m.id.includes(marketId));
        return market || null;
      }

      const data = await response.json();
      const marketsList = Array.isArray(data) ? data : (data ? [data] : []);

      if (marketsList.length === 0) {
        return null;
      }

      const transformedMarkets = this.transformMarkets(marketsList);
      return transformedMarkets[0] || null;

    } catch (error) {
      logger.error(`Error fetching market ${marketId}:`, error);
      return null;
    }
  }

  private async testConnection(): Promise<void> {
    const response = await polymarketRateLimiter.execute(async () => {
      return fetchWithTimeout(
        `${this.config.apiUrls.gamma}/markets?limit=1`,
        {},
        10000
      );
    });
    if (!response.ok) {
      throw new Error(`API test failed: ${response.status}`);
    }
  }

  private transformMarkets(data: any[]): Market[] {
    return data.map(market => this.transformMarket(market)).filter(Boolean) as Market[];
  }

  private transformMarket(data: any): Market | null {
    try {
      // CRITICAL DEBUG: Always log first 3 markets to diagnose asset ID extraction issue
      const shouldDebug = this.marketCache.size < 3;
      if (shouldDebug) {
        logger.info(`🔍 DEBUGGING MARKET: ${data.question?.substring(0, 60)}`);
        logger.info(`📋 ALL API FIELDS: ${Object.keys(data).sort().join(', ')}`);
        logger.info(`🏷️  condition_id: ${data.condition_id || 'MISSING'}`);
        logger.info(`🎯 asset_id field: ${data.asset_id || 'MISSING'}`);
        logger.info(`🎯 outcome_tokens field: ${data.outcome_tokens || 'MISSING'}`);
        logger.info(`🎯 clobTokenIds field: ${data.clobTokenIds || 'MISSING'}`);

        if (data.tokens) {
          logger.info(`📦 tokens array exists: length=${data.tokens.length}, isArray=${Array.isArray(data.tokens)}`);
          if (data.tokens[0]) {
            logger.info(`📦 First token keys: ${Object.keys(data.tokens[0]).sort().join(', ')}`);
            logger.info(`📦 First token.token_id: ${data.tokens[0].token_id || 'MISSING'}`);
            logger.info(`📦 First token.id: ${data.tokens[0].id || 'MISSING'}`);
            logger.info(`📦 First token.asset_id: ${data.tokens[0].asset_id || 'MISSING'}`);
            logger.info(`📦 First token.outcome: ${data.tokens[0].outcome || 'MISSING'}`);
          } else {
            logger.info(`📦 tokens array is EMPTY`);
          }
        } else {
          logger.info(`❌ NO tokens field in API response`);
        }
        logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      }

      // Extract asset IDs from multiple possible formats
      let assetIds: string[] = [];

      // Format 1: tokens array with token_id
      if (data.tokens && Array.isArray(data.tokens)) {
        assetIds = data.tokens
          .map((t: any) => t.token_id || t.id || t.asset_id)
          .filter(Boolean);
        if (shouldDebug) logger.info(`✅ Format 1 (tokens array): Found ${assetIds.length} asset IDs`);
      }

      // Format 2: direct asset_id field
      if (!assetIds.length && data.asset_id) {
        assetIds = [data.asset_id];
        if (shouldDebug) logger.info(`✅ Format 2 (direct asset_id): Found 1 asset ID`);
      }

      // Format 3: outcome_tokens array
      if (!assetIds.length && data.outcome_tokens) {
        assetIds = data.outcome_tokens.filter(Boolean);
        if (shouldDebug) logger.info(`✅ Format 3 (outcome_tokens): Found ${assetIds.length} asset IDs`);
      }

      // Format 4: clobTokenIds array (CLOB token IDs from Gamma API)
      if (!assetIds.length && data.clobTokenIds && Array.isArray(data.clobTokenIds)) {
        assetIds = data.clobTokenIds.filter(Boolean);
        if (shouldDebug) logger.info(`✅ Format 4 (clobTokenIds): Found ${assetIds.length} asset IDs`);
      }

      // Format 5: Use condition_id/conditionId as fallback for WebSocket
      if (!assetIds.length && (data.condition_id || data.conditionId)) {
        assetIds = [data.condition_id || data.conditionId];
        if (shouldDebug) logger.info(`⚠️  Format 5 (condition_id fallback): Using condition_id`);
      }

      // FINAL CHECK - Log if no assets found
      if (assetIds.length === 0) {
        logger.warn('❌ NO ASSET IDS EXTRACTED! Market will have no WebSocket subscriptions!', {
          marketQuestion: data.question?.substring(0, 50),
          conditionId: data.condition_id || data.conditionId,
          conditionIdLength: (data.condition_id || data.conditionId || '').length,
          allApiFields: Object.keys(data).sort().join(', '),
          clobTokenIdsValue: data.clobTokenIds,
          tokenFieldExists: !!data.tokens,
          assetIdFieldExists: !!data.asset_id,
          outcomeTokensFieldExists: !!data.outcome_tokens,
          // Deployment status fields
          deploying: data.deploying,
          pendingDeployment: data.pendingDeployment,
          ready: data.ready,
          acceptingOrders: data.acceptingOrders,
          enableOrderBook: data.enableOrderBook,
          active: data.active,
          closed: data.closed
        });
      }

      // Extract outcomes and prices
      const outcomes = data.outcomes || (data.tokens ? data.tokens.map((t: any) => t.outcome) : ['Yes', 'No']);
      const outcomePrices = this.extractPrices(data);

      // Spread will be calculated from real-time orderbook data
      // The initial spread from outcome prices is misleading - it shows the outcome range, not bid-ask spread
      // Real bid-ask spread comes from WebSocket orderbook updates
      let spread: number | undefined;

      // Calculate market age
      let marketAge: number | undefined;
      const createdAt = data.created_at || data.createdAt;
      if (createdAt) {
        const createdTime = new Date(createdAt).getTime();
        marketAge = Date.now() - createdTime;
      }

      // Calculate time to close
      let timeToClose: number | undefined;
      const endDate = data.end_date_iso || data.endDate;
      if (endDate) {
        const endTime = new Date(endDate).getTime();
        timeToClose = endTime - Date.now();
      }

      // Extract volume from multiple possible formats with fallback chain
      let volumeStr = '0';
      let volumeNum = 0;

      // Format 1: Direct volume field (total lifetime volume)
      if (data.volume) {
        volumeStr = data.volume;
        volumeNum = parseFloat(data.volume);
        if (shouldDebug) logger.info(`✅ Volume Format 1 (volume): $${volumeNum.toFixed(0)}`);
      }
      // Format 2: volumeNum field (numeric total volume)
      else if (data.volumeNum) {
        volumeNum = parseFloat(data.volumeNum);
        volumeStr = volumeNum.toString();
        if (shouldDebug) logger.info(`✅ Volume Format 2 (volumeNum): $${volumeNum.toFixed(0)}`);
      }
      // Format 3: Calculate from CLOB + AMM volume (total)
      else if (data.volumeClob || data.volumeAmm) {
        const clobVol = parseFloat(data.volumeClob || '0');
        const ammVol = parseFloat(data.volumeAmm || '0');
        volumeNum = clobVol + ammVol;
        volumeStr = volumeNum.toString();
        if (shouldDebug) logger.info(`✅ Volume Format 3 (volumeClob + volumeAmm): $${volumeNum.toFixed(0)}`);
      }
      // Format 4: Use 24hr volume as fallback
      else if (data.volume24hr || data.volume24hrClob || data.volume24hrAmm) {
        const vol24hr = parseFloat(data.volume24hr || '0');
        const clob24hr = parseFloat(data.volume24hrClob || '0');
        const amm24hr = parseFloat(data.volume24hrAmm || '0');
        volumeNum = Math.max(vol24hr, clob24hr + amm24hr);
        volumeStr = volumeNum.toString();
        if (shouldDebug) logger.info(`✅ Volume Format 4 (24hr volume): $${volumeNum.toFixed(0)}`);
      }
      // Format 5: Use 1 week volume as fallback
      else if (data.volume1wk || data.volume1wkClob || data.volume1wkAmm) {
        const vol1wk = parseFloat(data.volume1wk || '0');
        const clob1wk = parseFloat(data.volume1wkClob || '0');
        const amm1wk = parseFloat(data.volume1wkAmm || '0');
        volumeNum = Math.max(vol1wk, clob1wk + amm1wk);
        volumeStr = volumeNum.toString();
        if (shouldDebug) logger.info(`✅ Volume Format 5 (1wk volume): $${volumeNum.toFixed(0)}`);
      }

      if (volumeNum === 0 && shouldDebug) {
        logger.warn('⚠️  NO VOLUME EXTRACTED! Market may be filtered out', {
          marketQuestion: data.question?.substring(0, 50),
          availableVolumeFields: Object.keys(data).filter(k => k.toLowerCase().includes('volume')).join(', ')
        });
      }

      // Build initial market object
      const market: Market = {
        id: data.condition_id || data.id,
        question: data.question || data.title || 'Unknown Market',
        description: data.description,
        outcomes,
        outcomePrices,
        volume: volumeStr,
        volumeNum: volumeNum,
        active: data.active !== undefined ? data.active : !data.closed,
        closed: data.closed || false,
        endDate,
        tags: data.tags,
        createdAt,
        updatedAt: data.updated_at || data.updatedAt,
        // Add asset IDs for WebSocket subscriptions
        metadata: {
          assetIds: assetIds,
          conditionId: data.condition_id,
          slug: data.slug || data.market_slug,
          clobTokenIds: data.clobTokenIds,
          rawTokensData: process.env.LOG_LEVEL === 'debug' ? data.tokens : undefined,
        },
        // Market characteristics
        outcomeCount: outcomes.length,
        spread,
        marketAge,
        timeToClose
      };

      // Apply category detection
      const categoryResult = this.categorizer.categorize(market);
      market.category = categoryResult.category || undefined;
      market.categoryScore = categoryResult.categoryScore;
      market.isBlacklisted = categoryResult.isBlacklisted;

      // Cache market for spread updates from orderbook
      this.marketCache.set(market.id, market);

      // Map asset IDs to market ID so orderbook updates can find the right market
      // Orderbook messages come with asset IDs, not market IDs
      const marketAssetIds = market.metadata?.assetIds;
      if (marketAssetIds && Array.isArray(marketAssetIds)) {
        for (const assetId of marketAssetIds) {
          this.assetIdToMarketId.set(assetId, market.id);
        }
      }

      return market;
    } catch (error) {
      logger.warn('Failed to transform market data:', error);
      return null;
    }
  }

  /**
   * Update market spread from real-time orderbook data
   * Call this when orderbook updates arrive via WebSocket
   */
  updateMarketSpread(orderbookData: OrderbookData): void {
    // Orderbook data comes with either a market ID or an asset ID
    // Try to resolve asset ID to market ID first
    const incomingId = orderbookData.marketId;
    const actualMarketId = this.assetIdToMarketId.get(incomingId) || incomingId;

    const market = this.marketCache.get(actualMarketId);
    if (market && orderbookData.spread !== undefined) {
      // Update the market's spread with the real-time orderbook spread
      // Convert from absolute decimal to basis points (e.g., 0.027 -> 270)
      market.spread = orderbookData.spread * 10000;
      logger.debug(`Updated market ${actualMarketId.substring(0, 8)}... spread: ${market.spread.toFixed(0)} bps (from ${incomingId === actualMarketId ? 'marketId' : 'assetId ' + incomingId.substring(0, 8) + '...'})`);
    } else if (!market) {
      logger.debug(`Market not found in cache for ID ${incomingId.substring(0, 8)}... (resolved to ${actualMarketId.substring(0, 8)}...)`);
    }
  }

  /**
   * Get cached market with latest spread data
   * Returns the cached market or null if not found
   */
  getCachedMarket(marketId: string): Market | null {
    return this.marketCache.get(marketId) || null;
  }

  private extractPrices(data: any): string[] {
    // Handle various price formats from Polymarket API
    if (data.tokens && data.tokens.length > 0) {
      // Extract ALL token prices, not just first 2 (supports multi-outcome markets)
      return data.tokens.map((token: any) => token.price || '0');
    }

    if (data.outcomePrices) {
      if (typeof data.outcomePrices === 'string') {
        try {
          return JSON.parse(data.outcomePrices);
        } catch {
          return ['0', '0'];
        }
      }
      if (Array.isArray(data.outcomePrices)) {
        return data.outcomePrices;
      }
    }

    // Fallback for binary markets
    return ['0', '0'];
  }

  // Enhanced methods for microstructure analysis
  async getOrderbook(marketId: string): Promise<OrderbookData | null> {
    const startTime = Date.now();
    
    try {
      const response = await advancedLogger.timeOperation(
        () => polymarketRateLimiter.execute(async () => {
          return fetchWithTimeout(`${this.config.apiUrls.clob}/book?token_id=${marketId}`, {}, 10000);
        }),
        'polymarket_get_orderbook',
        { 
          component: 'polymarket_service',
          operation: 'get_orderbook',
          marketId: marketId.substring(0, 8) + '...'
        }
      );
      
      if (!response.ok) {
        if (response.status === 404) {
          return null;
        }
        throw new Error(`Orderbook API request failed: ${response.status}`);
      }

      const data = await response.json();
      const orderbook = this.transformOrderbook(data, marketId);
      
      // Record metrics
      const duration = Date.now() - startTime;
      metricsCollector.recordDatabaseMetrics('get_orderbook', duration, true);
      
      return orderbook;
    } catch (error) {
      const duration = Date.now() - startTime;
      metricsCollector.recordDatabaseMetrics('get_orderbook', duration, false);
      
      advancedLogger.error(`Error fetching orderbook for market`, error as Error, {
        component: 'polymarket_service',
        operation: 'get_orderbook',
        marketId: marketId.substring(0, 8) + '...'
      });
      
      return null;
    }
  }

  async getRecentTrades(marketId: string, limit: number = 50): Promise<TickData[]> {
    try {
      // Use Data API for trades with rate limiting
      const response = await polymarketRateLimiter.execute(async () => {
        return fetchWithTimeout(
          `${this.config.apiUrls.gamma}/trades?market=${marketId}&limit=${limit}`,
          {},
          10000
        );
      });

      if (!response.ok) {
        throw new Error(`Trades API request failed: ${response.status}`);
      }

      const data: any = await response.json();
      const tradesArray = Array.isArray(data) ? data : [];
      return this.transformTrades(tradesArray, marketId);
    } catch (error) {
      logger.error(`Error fetching trades for ${marketId}:`, error);
      return [];
    }
  }

  async getMarketPrice(marketId: string): Promise<number | null> {
    try {
      // Get price from orderbook midpoint
      const orderbook = await this.getOrderbook(marketId);
      return orderbook ? orderbook.midPrice : null;
    } catch (error) {
      logger.error(`Error fetching price for ${marketId}:`, error);
      return null;
    }
  }

  async getMarketDepth(marketId: string, depth: number = 10): Promise<{ bids: OrderbookLevel[]; asks: OrderbookLevel[] } | null> {
    const orderbook = await this.getOrderbook(marketId);
    if (!orderbook) return null;

    return {
      bids: orderbook.bids.slice(0, depth),
      asks: orderbook.asks.slice(0, depth),
    };
  }

  async getMarketsWithMinVolume(minVolume: number): Promise<Market[]> {
    try {
      const markets = await this.getActiveMarkets();
      return markets.filter(market => market.volumeNum >= minVolume);
    } catch (error) {
      logger.error('Error filtering markets by volume:', error);
      return [];
    }
  }

  // Batch operations for efficiency
  async getMultipleOrderbooks(marketIds: string[]): Promise<Map<string, OrderbookData>> {
    const results = new Map<string, OrderbookData>();

    // Process in parallel with rate limiter (rate limiter handles throttling internally)
    const promises = marketIds.map(async (marketId) => {
      try {
        const orderbook = await this.getOrderbook(marketId);
        if (orderbook) {
          return { marketId, orderbook };
        }
      } catch (error) {
        logger.warn(`Failed to fetch orderbook for ${marketId}:`, error);
      }
      return null;
    });

    const settled = await Promise.all(promises);

    // Collect successful results
    for (const result of settled) {
      if (result) {
        results.set(result.marketId, result.orderbook);
      }
    }

    return results;
  }

  async getMultiplePrices(marketIds: string[]): Promise<Map<string, number>> {
    const results = new Map<string, number>();

    // Process in parallel with rate limiter (rate limiter handles throttling internally)
    const promises = marketIds.map(async (marketId) => {
      try {
        const price = await this.getMarketPrice(marketId);
        if (price !== null) {
          return { marketId, price };
        }
      } catch (error) {
        logger.warn(`Failed to fetch price for ${marketId}:`, error);
      }
      return null;
    });

    const settled = await Promise.all(promises);

    // Collect successful results
    for (const result of settled) {
      if (result) {
        results.set(result.marketId, result.price);
      }
    }

    return results;
  }

  private transformOrderbook(data: any, marketId: string): OrderbookData {
    const bids: OrderbookLevel[] = (data.bids || []).map((bid: any) => ({
      price: parseFloat(bid.price),
      size: parseFloat(bid.size),
      volume: parseFloat(bid.price) * parseFloat(bid.size),
    })).sort((a: OrderbookLevel, b: OrderbookLevel) => b.price - a.price); // Highest bid first

    const asks: OrderbookLevel[] = (data.asks || []).map((ask: any) => ({
      price: parseFloat(ask.price),
      size: parseFloat(ask.size),
      volume: parseFloat(ask.price) * parseFloat(ask.size),
    })).sort((a: OrderbookLevel, b: OrderbookLevel) => a.price - b.price); // Lowest ask first

    const bestBid = bids.length > 0 ? bids[0].price : 0;
    const bestAsk = asks.length > 0 ? asks[0].price : 0;
    const spread = bestAsk > 0 && bestBid > 0 ? bestAsk - bestBid : 0;
    const midPrice = bestAsk > 0 && bestBid > 0 ? (bestAsk + bestBid) / 2 : 0;

    return {
      marketId,
      timestamp: Date.now(),
      bids,
      asks,
      spread,
      midPrice,
      bestBid,
      bestAsk,
    };
  }

  private transformTrades(data: any[], marketId: string): TickData[] {
    return data.map(trade => ({
      timestamp: new Date(trade.timestamp).getTime(),
      marketId,
      price: parseFloat(trade.price),
      volume: parseFloat(trade.size || trade.volume || '0'),
      side: (trade.side === 'buy' ? 'buy' : 'sell') as 'buy' | 'sell',
      size: parseFloat(trade.size || '0'),
    })).sort((a, b) => b.timestamp - a.timestamp); // Most recent first
  }


  // Health check method
  async healthCheck(): Promise<{ healthy: boolean; latency: number; details?: any }> {
    const start = Date.now();
    
    try {
      const response = await polymarketRateLimiter.execute(async () => {
        return fetchWithTimeout(`${this.config.apiUrls.gamma}/markets?limit=1`, {}, 10000);
      });
      const latency = Date.now() - start;
      const healthy = response.ok;
      
      // Record health check metrics
      metricsCollector.recordHistogram('polymarket.health_check_latency', latency);
      metricsCollector.setGauge('polymarket.healthy', healthy ? 1 : 0);
      
      if (!healthy) {
        advancedLogger.warn('Polymarket health check failed', {
          component: 'polymarket_service',
          operation: 'health_check',
          metadata: { status: response.status, latency }
        });
      }
      
      return {
        healthy,
        latency,
        details: {
          status: response.status,
          endpoint: 'gamma/markets'
        }
      };
    } catch (error) {
      const latency = Date.now() - start;
      
      metricsCollector.recordHistogram('polymarket.health_check_latency', latency);
      metricsCollector.setGauge('polymarket.healthy', 0);
      
      advancedLogger.error('Polymarket health check error', error as Error, {
        component: 'polymarket_service',
        operation: 'health_check',
        metadata: { latency }
      });
      
      return {
        healthy: false,
        latency,
        details: {
          error: (error as Error).message
        }
      };
    }
  }
}