import { BotConfig, Market, OrderbookData, OrderbookLevel, TickData } from '../types';
import { logger } from '../utils/logger';
import { advancedLogger } from '../utils/AdvancedLogger';
import { metricsCollector } from '../monitoring/MetricsCollector';
import { polymarketRateLimiter } from '../utils/RateLimiter';
import { MarketCategorizer } from './MarketCategorizer';

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

  constructor(config: BotConfig) {
    this.config = config;
    this.categorizer = new MarketCategorizer();
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
      // Use Gamma API for active markets with rate limiting
      const response = await advancedLogger.timeOperation(
        () => polymarketRateLimiter.execute(async () => {
          return fetchWithTimeout(
            `${this.config.apiUrls.gamma}/markets?active=true&closed=false&limit=1000`,
            {},
            15000
          );
        }),
        'polymarket_get_active_markets',
        { component: 'polymarket_service', operation: 'get_active_markets' }
      );

      if (!response.ok) {
        throw new Error(`API request failed: ${response.status}`);
      }

      const markets: any = await response.json();
      
      // Gamma API returns array directly, already filtered for active/open markets
      const marketsList = Array.isArray(markets) ? markets : [];
      const transformedMarkets = this.transformMarkets(marketsList);
      
      // Record metrics
      const duration = Date.now() - startTime;
      metricsCollector.recordDatabaseMetrics('get_active_markets', duration, true);
      metricsCollector.setGauge('polymarket.active_markets_count', transformedMarkets.length);
      
      advancedLogger.info(`Fetched ${transformedMarkets.length} active markets`, {
        component: 'polymarket_service',
        operation: 'get_active_markets',
        metadata: { marketCount: transformedMarkets.length, durationMs: duration }
      });
      
      return transformedMarkets;
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
      // Debug log the raw market data to understand structure
      if (process.env.LOG_LEVEL === 'debug') {
        logger.debug('Raw market data sample:', {
          keys: Object.keys(data),
          hasTokens: !!data.tokens,
          tokensLength: data.tokens?.length || 0,
          tokensSample: data.tokens?.[0] ? Object.keys(data.tokens[0]) : [],
        });
      }

      // Extract asset IDs from multiple possible formats
      let assetIds: string[] = [];

      // Format 1: tokens array with token_id
      if (data.tokens && Array.isArray(data.tokens)) {
        assetIds = data.tokens
          .map((t: any) => t.token_id || t.id || t.asset_id)
          .filter(Boolean);
      }

      // Format 2: direct asset_id field
      if (!assetIds.length && data.asset_id) {
        assetIds = [data.asset_id];
      }

      // Format 3: outcome_tokens array
      if (!assetIds.length && data.outcome_tokens) {
        assetIds = data.outcome_tokens.filter(Boolean);
      }

      // Format 4: Use condition_id as fallback for WebSocket
      if (!assetIds.length && data.condition_id) {
        assetIds = [data.condition_id];
        logger.debug(`Using condition_id as asset fallback for market: ${data.condition_id}`);
      }

      // Extract outcomes and prices
      const outcomes = data.outcomes || (data.tokens ? data.tokens.map((t: any) => t.outcome) : ['Yes', 'No']);
      const outcomePrices = this.extractPrices(data);

      // Calculate spread (difference between highest and lowest price)
      let spread: number | undefined;
      if (outcomePrices && outcomePrices.length >= 2) {
        const prices = outcomePrices.map(p => parseFloat(p)).filter(p => !isNaN(p));
        if (prices.length >= 2) {
          const maxPrice = Math.max(...prices);
          const minPrice = Math.min(...prices);
          spread = (maxPrice - minPrice) * 10000; // Convert to basis points
        }
      }

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

      // Build initial market object
      const market: Market = {
        id: data.condition_id || data.id,
        question: data.question || data.title || 'Unknown Market',
        description: data.description,
        outcomes,
        outcomePrices,
        volume: data.volume || '0',
        volumeNum: parseFloat(data.volume || '0'),
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

      return market;
    } catch (error) {
      logger.warn('Failed to transform market data:', error);
      return null;
    }
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