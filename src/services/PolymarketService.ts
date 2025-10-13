import { BotConfig, Market, OrderbookData, OrderbookLevel, TickData } from '../types';
import { logger } from '../utils/logger';
import { polymarketRateLimiter } from '../utils/RateLimiter';

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

  constructor(config: BotConfig) {
    this.config = config;
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
    try {
      // Use CLOB API for markets with rate limiting
      const response = await polymarketRateLimiter.execute(async () => {
        return fetchWithTimeout(`${this.config.apiUrls.clob}/markets`, {}, 15000);
      });

      if (!response.ok) {
        throw new Error(`API request failed: ${response.status}`);
      }

      const result = await response.json();
      const markets = result.data || result;
      
      // Filter for active markets only
      const activeMarkets = Array.isArray(markets) 
        ? markets.filter((m: any) => m.active && !m.closed)
        : [];
      
      return this.transformMarkets(activeMarkets);
    } catch (error) {
      logger.error('Error fetching active markets:', error);
      throw error;
    }
  }

  async getMarketById(marketId: string): Promise<Market | null> {
    try {
      // Search in markets list since there's no direct market endpoint
      const markets = await this.getActiveMarkets();
      const market = markets.find(m => m.id === marketId || m.id.includes(marketId));
      return market || null;
    } catch (error) {
      logger.error(`Error fetching market ${marketId}:`, error);
      return null;
    }
  }

  private async testConnection(): Promise<void> {
    const response = await polymarketRateLimiter.execute(async () => {
      return fetchWithTimeout(`${this.config.apiUrls.clob}/markets`, {}, 10000);
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
      return {
        id: data.condition_id || data.id,
        question: data.question || data.title || 'Unknown Market',
        description: data.description,
        outcomes: data.outcomes || (data.tokens ? data.tokens.map((t: any) => t.outcome) : ['Yes', 'No']),
        outcomePrices: this.extractPrices(data),
        volume: data.volume || '0',
        volumeNum: parseFloat(data.volume || '0'),
        active: data.active !== undefined ? data.active : !data.closed,
        closed: data.closed || false,
        endDate: data.end_date_iso || data.endDate,
        tags: data.tags,
        createdAt: data.created_at || data.createdAt,
        updatedAt: data.updated_at || data.updatedAt,
      };
    } catch (error) {
      logger.warn('Failed to transform market data:', error);
      return null;
    }
  }

  private extractPrices(data: any): string[] {
    // Handle various price formats from Polymarket API
    if (data.tokens && data.tokens.length >= 2) {
      return [
        data.tokens[0].price || '0',
        data.tokens[1].price || '0'
      ];
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
    
    return ['0', '0'];
  }

  // Enhanced methods for microstructure analysis
  async getOrderbook(marketId: string): Promise<OrderbookData | null> {
    try {
      const response = await polymarketRateLimiter.execute(async () => {
        return fetchWithTimeout(`${this.config.apiUrls.clob}/book?token_id=${marketId}`, {}, 10000);
      });
      
      if (!response.ok) {
        if (response.status === 404) {
          return null;
        }
        throw new Error(`Orderbook API request failed: ${response.status}`);
      }

      const data = await response.json();
      return this.transformOrderbook(data, marketId);
    } catch (error) {
      logger.error(`Error fetching orderbook for ${marketId}:`, error);
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

      const data = await response.json();
      return this.transformTrades(data, marketId);
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
    
    // Process sequentially using rate limiter
    for (const marketId of marketIds) {
      const orderbook = await this.getOrderbook(marketId);
      if (orderbook) {
        results.set(marketId, orderbook);
      }
    }
    
    return results;
  }

  async getMultiplePrices(marketIds: string[]): Promise<Map<string, number>> {
    const results = new Map<string, number>();
    
    // Process sequentially using rate limiter
    for (const marketId of marketIds) {
      const price = await this.getMarketPrice(marketId);
      if (price !== null) {
        results.set(marketId, price);
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
      side: trade.side === 'buy' ? 'buy' : 'sell',
      size: parseFloat(trade.size || '0'),
    })).sort((a, b) => b.timestamp - a.timestamp); // Most recent first
  }


  // Health check method
  async healthCheck(): Promise<{ healthy: boolean; latency: number }> {
    const start = Date.now();
    
    try {
      const response = await polymarketRateLimiter.execute(async () => {
        return fetchWithTimeout(`${this.config.apiUrls.clob}/markets`, {}, 10000);
      });
      const latency = Date.now() - start;
      
      return {
        healthy: response.ok,
        latency,
      };
    } catch (error) {
      return {
        healthy: false,
        latency: Date.now() - start,
      };
    }
  }
}