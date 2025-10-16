import { DatabaseManager } from './database';
import { 
  Market, 
  OrderbookData, 
  TickData, 
  EarlySignal, 
  EnhancedMicrostructureMetrics
} from '../types';
import { logger } from '../utils/logger';

interface HistoricalPrice {
  marketId: string;
  timestamp: number;
  outcomeIndex: number;
  price: number;
  volume?: number;
}

interface SignalRecord {
  id: number;
  marketId: string;
  signalType: string;
  confidence: number;
  timestamp: number;
  metadata: any;
  validated: boolean;
  validationTime?: number;
  outcome?: boolean;
}

export class DataAccessLayer {
  public db: DatabaseManager; // Made public for external access in some cases
  private cacheEnabled: boolean = true;
  private readonly CACHE_TTL = {
    MARKETS: 300, // 5 minutes
    PRICES: 60,   // 1 minute
    ORDERBOOK: 30, // 30 seconds
    METRICS: 120,  // 2 minutes
  };

  constructor(db: DatabaseManager) {
    this.db = db;
  }

  // Market operations
  async saveMarket(market: Market): Promise<void> {
    try {
      await this.db.query(`
        INSERT INTO markets (id, condition_id, question, description, outcomes, volume, active, closed, end_date, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (id) DO UPDATE SET
          question = EXCLUDED.question,
          description = EXCLUDED.description,
          outcomes = EXCLUDED.outcomes,
          volume = EXCLUDED.volume,
          active = EXCLUDED.active,
          closed = EXCLUDED.closed,
          end_date = EXCLUDED.end_date,
          metadata = EXCLUDED.metadata,
          updated_at = CURRENT_TIMESTAMP
      `, [
        market.id,
        market.metadata?.conditionId,
        market.question,
        market.description,
        JSON.stringify(market.outcomes),
        market.volumeNum,
        market.active,
        market.closed,
        market.endDate ? new Date(market.endDate) : null,
        JSON.stringify(market.metadata || {})
      ]);

      // Invalidate cache
      await this.db.deleteCache(`market:${market.id}`);
      
      logger.debug(`Market saved: ${market.id}`);
    } catch (error) {
      logger.error(`Error saving market ${market.id}:`, error);
      throw error;
    }
  }

  async getMarket(marketId: string): Promise<Market | null> {
    try {
      // Check cache first
      const cacheKey = `market:${marketId}`;
      if (this.cacheEnabled) {
        const cached = await this.db.getCache(cacheKey);
        if (cached) {
          return cached;
        }
      }

      const result = await this.db.query(`
        SELECT * FROM markets WHERE id = $1
      `, [marketId]);

      if (result.length === 0) return null;

      const row = result[0];
      const market: Market = {
        id: row.id,
        question: row.question,
        description: row.description,
        outcomes: row.outcomes ? JSON.parse(row.outcomes) : [],
        outcomePrices: [], // Will be populated from latest prices
        volume: row.volume?.toString() || '0',
        volumeNum: parseFloat(row.volume) || 0,
        active: row.active,
        closed: row.closed,
        endDate: row.end_date?.toISOString(),
        createdAt: row.created_at?.toISOString(),
        updatedAt: row.updated_at?.toISOString(),
        metadata: row.metadata ? JSON.parse(row.metadata) : {}
      };

      // Get latest prices
      market.outcomePrices = await this.getLatestPrices(marketId);

      // Cache the result
      if (this.cacheEnabled) {
        await this.db.setCache(cacheKey, market, this.CACHE_TTL.MARKETS);
      }

      return market;
    } catch (error) {
      logger.error(`Error getting market ${marketId}:`, error);
      return null;
    }
  }

  async getActiveMarkets(limit: number = 1000): Promise<Market[]> {
    try {
      const cacheKey = `active_markets:${limit}`;
      if (this.cacheEnabled) {
        const cached = await this.db.getCache(cacheKey);
        if (cached) {
          return cached;
        }
      }

      const result = await this.db.query(`
        SELECT * FROM markets 
        WHERE active = true AND closed = false 
        ORDER BY volume DESC 
        LIMIT $1
      `, [limit]);

      const markets: Market[] = [];
      for (const row of result) {
        const market: Market = {
          id: row.id,
          question: row.question,
          description: row.description,
          outcomes: row.outcomes ? JSON.parse(row.outcomes) : [],
          outcomePrices: await this.getLatestPrices(row.id),
          volume: row.volume?.toString() || '0',
          volumeNum: parseFloat(row.volume) || 0,
          active: row.active,
          closed: row.closed,
          endDate: row.end_date?.toISOString(),
          createdAt: row.created_at?.toISOString(),
          updatedAt: row.updated_at?.toISOString(),
          metadata: row.metadata ? JSON.parse(row.metadata) : {}
        };
        markets.push(market);
      }

      // Cache the result
      if (this.cacheEnabled) {
        await this.db.setCache(cacheKey, markets, this.CACHE_TTL.MARKETS);
      }

      return markets;
    } catch (error) {
      logger.error('Error getting active markets:', error);
      return [];
    }
  }

  // Price operations
  async savePrice(marketId: string, outcomeIndex: number, price: number, volume?: number): Promise<void> {
    try {
      await this.db.query(`
        INSERT INTO market_prices (market_id, timestamp, outcome_index, price, volume)
        VALUES ($1, CURRENT_TIMESTAMP, $2, $3, $4)
      `, [marketId, outcomeIndex, price, volume]);

      // Invalidate cache
      await this.db.deleteCache(`prices:${marketId}`);
    } catch (error) {
      logger.error(`Error saving price for market ${marketId}:`, error);
      throw error;
    }
  }

  async getLatestPrices(marketId: string): Promise<string[]> {
    try {
      const cacheKey = `prices:${marketId}`;
      if (this.cacheEnabled) {
        const cached = await this.db.getCache(cacheKey);
        if (cached) {
          return cached;
        }
      }

      const result = await this.db.query(`
        SELECT DISTINCT ON (outcome_index) outcome_index, price 
        FROM market_prices 
        WHERE market_id = $1 
        ORDER BY outcome_index, timestamp DESC
      `, [marketId]);

      const prices = new Array(2).fill('0');
      for (const row of result) {
        if (row.outcome_index < prices.length) {
          prices[row.outcome_index] = row.price.toString();
        }
      }

      // Cache the result
      if (this.cacheEnabled) {
        await this.db.setCache(cacheKey, prices, this.CACHE_TTL.PRICES);
      }

      return prices;
    } catch (error) {
      logger.error(`Error getting latest prices for market ${marketId}:`, error);
      return ['0', '0'];
    }
  }

  async getPriceHistory(marketId: string, hours: number = 24): Promise<HistoricalPrice[]> {
    try {
      const result = await this.db.query(`
        SELECT market_id, EXTRACT(EPOCH FROM timestamp) * 1000 as timestamp, outcome_index, price, volume
        FROM market_prices 
        WHERE market_id = $1 AND timestamp > (CURRENT_TIMESTAMP - INTERVAL '${hours} hours')
        ORDER BY timestamp DESC
      `, [marketId]);

      return result.map((row: any) => ({
        marketId: row.market_id,
        timestamp: parseInt(row.timestamp),
        outcomeIndex: row.outcome_index,
        price: parseFloat(row.price),
        volume: row.volume ? parseFloat(row.volume) : undefined
      }));
    } catch (error) {
      logger.error(`Error getting price history for market ${marketId}:`, error);
      return [];
    }
  }

  // Orderbook operations
  async saveOrderbook(orderbook: OrderbookData): Promise<void> {
    try {
      await this.db.query(`
        INSERT INTO orderbook_snapshots (market_id, timestamp, bids, asks, spread, mid_price, best_bid, best_ask)
        VALUES ($1, TO_TIMESTAMP($2 / 1000), $3, $4, $5, $6, $7, $8)
      `, [
        orderbook.marketId,
        orderbook.timestamp,
        JSON.stringify(orderbook.bids),
        JSON.stringify(orderbook.asks),
        orderbook.spread,
        orderbook.midPrice,
        orderbook.bestBid,
        orderbook.bestAsk
      ]);

      // Update latest prices from orderbook
      if (orderbook.midPrice > 0) {
        await this.savePrice(orderbook.marketId, 0, orderbook.midPrice);
        await this.savePrice(orderbook.marketId, 1, 1 - orderbook.midPrice);
      }

      logger.debug(`Orderbook saved for market: ${orderbook.marketId}`);
    } catch (error) {
      logger.error(`Error saving orderbook for market ${orderbook.marketId}:`, error);
      throw error;
    }
  }

  async getLatestOrderbook(marketId: string): Promise<OrderbookData | null> {
    try {
      const cacheKey = `orderbook:${marketId}`;
      if (this.cacheEnabled) {
        const cached = await this.db.getCache(cacheKey);
        if (cached) {
          return cached;
        }
      }

      const result = await this.db.query(`
        SELECT * FROM orderbook_snapshots 
        WHERE market_id = $1 
        ORDER BY timestamp DESC 
        LIMIT 1
      `, [marketId]);

      if (result.length === 0) return null;

      const row = result[0];
      const orderbook: OrderbookData = {
        marketId: row.market_id,
        timestamp: new Date(row.timestamp).getTime(),
        bids: JSON.parse(row.bids),
        asks: JSON.parse(row.asks),
        spread: parseFloat(row.spread),
        midPrice: parseFloat(row.mid_price),
        bestBid: parseFloat(row.best_bid),
        bestAsk: parseFloat(row.best_ask)
      };

      // Cache the result
      if (this.cacheEnabled) {
        await this.db.setCache(cacheKey, orderbook, this.CACHE_TTL.ORDERBOOK);
      }

      return orderbook;
    } catch (error) {
      logger.error(`Error getting latest orderbook for market ${marketId}:`, error);
      return null;
    }
  }

  // Trade tick operations
  async saveTradeTick(tick: TickData): Promise<void> {
    try {
      await this.db.query(`
        INSERT INTO trade_ticks (market_id, timestamp, price, size, side)
        VALUES ($1, TO_TIMESTAMP($2 / 1000), $3, $4, $5)
      `, [
        tick.marketId,
        tick.timestamp,
        tick.price,
        tick.size,
        tick.side
      ]);

      logger.debug(`Trade tick saved for market: ${tick.marketId}`);
    } catch (error) {
      logger.error(`Error saving trade tick for market ${tick.marketId}:`, error);
      throw error;
    }
  }

  async getTradeTicks(marketId: string, limit: number = 100): Promise<TickData[]> {
    try {
      const result = await this.db.query(`
        SELECT market_id, EXTRACT(EPOCH FROM timestamp) * 1000 as timestamp, price, size, side
        FROM trade_ticks 
        WHERE market_id = $1 
        ORDER BY timestamp DESC 
        LIMIT $2
      `, [marketId, limit]);

      return result.map((row: any) => ({
        marketId: row.market_id,
        timestamp: parseInt(row.timestamp),
        price: parseFloat(row.price),
        volume: parseFloat(row.size), // Volume = size in this context
        size: parseFloat(row.size),
        side: row.side as 'buy' | 'sell'
      }));
    } catch (error) {
      logger.error(`Error getting trade ticks for market ${marketId}:`, error);
      return [];
    }
  }

  // Signal operations
  async saveSignal(signal: EarlySignal): Promise<number> {
    try {
      const result = await this.db.query(`
        INSERT INTO signals (market_id, signal_type, confidence, timestamp, metadata)
        VALUES ($1, $2, $3, TO_TIMESTAMP($4 / 1000), $5)
        RETURNING id
      `, [
        signal.marketId,
        signal.signalType,
        signal.confidence,
        signal.timestamp,
        JSON.stringify(signal.metadata || {})
      ]);

      const signalId = result[0].id;
      logger.info(`Signal saved with ID ${signalId}: ${signal.signalType} for market ${signal.marketId}`);
      return signalId;
    } catch (error) {
      logger.error(`Error saving signal for market ${signal.marketId}:`, error);
      throw error;
    }
  }

  async getSignals(marketId?: string, signalType?: string, hours: number = 24): Promise<SignalRecord[]> {
    try {
      let query = `
        SELECT id, market_id, signal_type, confidence, 
               EXTRACT(EPOCH FROM timestamp) * 1000 as timestamp,
               metadata, validated, 
               EXTRACT(EPOCH FROM validation_time) * 1000 as validation_time,
               outcome
        FROM signals 
        WHERE timestamp > (CURRENT_TIMESTAMP - INTERVAL '${hours} hours')
      `;
      const params: any[] = [];
      let paramIndex = 1;

      if (marketId) {
        query += ` AND market_id = $${paramIndex++}`;
        params.push(marketId);
      }

      if (signalType) {
        query += ` AND signal_type = $${paramIndex++}`;
        params.push(signalType);
      }

      query += ' ORDER BY timestamp DESC';

      const result = await this.db.query(query, params);

      return result.map((row: any) => ({
        id: row.id,
        marketId: row.market_id,
        signalType: row.signal_type,
        confidence: parseFloat(row.confidence),
        timestamp: parseInt(row.timestamp),
        metadata: row.metadata ? JSON.parse(row.metadata) : {},
        validated: row.validated,
        validationTime: row.validation_time ? parseInt(row.validation_time) : undefined,
        outcome: row.outcome
      }));
    } catch (error) {
      logger.error('Error getting signals:', error);
      return [];
    }
  }

  async validateSignal(signalId: number, outcome: boolean): Promise<void> {
    try {
      await this.db.query(`
        UPDATE signals 
        SET validated = true, validation_time = CURRENT_TIMESTAMP, outcome = $2
        WHERE id = $1
      `, [signalId, outcome]);

      logger.info(`Signal ${signalId} validated with outcome: ${outcome}`);
    } catch (error) {
      logger.error(`Error validating signal ${signalId}:`, error);
      throw error;
    }
  }

  // Microstructure metrics operations
  async saveMicrostructureMetrics(metrics: EnhancedMicrostructureMetrics): Promise<void> {
    try {
      await this.db.query(`
        INSERT INTO microstructure_metrics (
          market_id, timestamp, depth_1_bid, depth_1_ask, depth_1_total,
          micro_price, micro_price_slope, micro_price_drift,
          orderbook_imbalance, spread_bps, liquidity_vacuum,
          volume_z_score, depth_z_score, spread_z_score, imbalance_z_score
        ) VALUES ($1, TO_TIMESTAMP($2 / 1000), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      `, [
        metrics.marketId,
        metrics.timestamp,
        metrics.depth1Bid,
        metrics.depth1Ask,
        metrics.depth1Total,
        metrics.microPrice,
        metrics.microPriceSlope,
        metrics.microPriceDrift,
        metrics.orderBookImbalance,
        metrics.spreadBps,
        metrics.liquidityVacuum,
        metrics.volumeZScore,
        metrics.depthZScore,
        metrics.spreadZScore,
        metrics.imbalanceZScore
      ]);

      logger.debug(`Microstructure metrics saved for market: ${metrics.marketId}`);
    } catch (error) {
      logger.error(`Error saving microstructure metrics for market ${metrics.marketId}:`, error);
      throw error;
    }
  }

  // Anomaly score operations
  async saveAnomalyScore(anomalyScore: any): Promise<void> {
    try {
      await this.db.query(`
        INSERT INTO anomaly_scores (
          market_id, timestamp, volume_anomaly, depth_anomaly, spread_anomaly,
          imbalance_anomaly, price_anomaly, mahalanobis_distance, 
          isolation_forest_score, combined_score, is_anomalous, 
          anomaly_type, confidence
        ) VALUES ($1, TO_TIMESTAMP($2 / 1000), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      `, [
        anomalyScore.marketId,
        anomalyScore.timestamp,
        anomalyScore.volumeAnomaly,
        anomalyScore.depthAnomaly,
        anomalyScore.spreadAnomaly,
        anomalyScore.imbalanceAnomaly,
        anomalyScore.priceAnomaly,
        anomalyScore.mahalanobisDistance,
        anomalyScore.isolationForestScore,
        anomalyScore.combinedScore,
        anomalyScore.isAnomalous,
        JSON.stringify(anomalyScore.anomalyType),
        anomalyScore.confidence
      ]);

      logger.debug(`Anomaly score saved for market: ${anomalyScore.marketId}`);
    } catch (error) {
      logger.error(`Error saving anomaly score for market ${anomalyScore.marketId}:`, error);
      throw error;
    }
  }

  async getRecentAnomalies(marketId?: string, hours: number = 24): Promise<any[]> {
    try {
      let query = `
        SELECT market_id, EXTRACT(EPOCH FROM timestamp) * 1000 as timestamp,
               volume_anomaly, depth_anomaly, spread_anomaly, imbalance_anomaly,
               price_anomaly, combined_score, is_anomalous, anomaly_type, confidence
        FROM anomaly_scores 
        WHERE timestamp > (CURRENT_TIMESTAMP - INTERVAL '${hours} hours')
      `;
      const params: any[] = [];

      if (marketId) {
        query += ' AND market_id = $1';
        params.push(marketId);
      }

      query += ' ORDER BY timestamp DESC LIMIT 100';

      const result = await this.db.query(query, params);

      return result.map((row: any) => ({
        marketId: row.market_id,
        timestamp: parseInt(row.timestamp),
        volumeAnomaly: parseFloat(row.volume_anomaly),
        depthAnomaly: parseFloat(row.depth_anomaly),
        spreadAnomaly: parseFloat(row.spread_anomaly),
        imbalanceAnomaly: parseFloat(row.imbalance_anomaly),
        priceAnomaly: parseFloat(row.price_anomaly),
        combinedScore: parseFloat(row.combined_score),
        isAnomalous: row.is_anomalous,
        anomalyType: row.anomaly_type ? JSON.parse(row.anomaly_type) : [],
        confidence: parseFloat(row.confidence)
      }));
    } catch (error) {
      logger.error('Error getting recent anomalies:', error);
      return [];
    }
  }

  // Front-running score operations
  async saveFrontRunningScore(score: any): Promise<void> { // Using any for FrontRunningScore since it's from another module
    try {
      await this.db.query(`
        INSERT INTO front_running_scores (
          market_id, timestamp, score, confidence, leak_probability, 
          time_to_news, components, metadata
        ) VALUES ($1, CURRENT_TIMESTAMP, $2, $3, $4, $5, $6, $7)
      `, [
        score.marketId,
        score.score,
        score.confidence,
        score.leakProbability,
        score.timeToNews,
        JSON.stringify(score.components),
        JSON.stringify(score.metadata)
      ]);

      logger.debug(`Front-running score saved for market: ${score.marketId}`);
    } catch (error) {
      logger.error(`Error saving front-running score for market ${score.marketId}:`, error);
      throw error;
    }
  }

  // Analytics operations
  async getSignalAccuracy(signalType?: string, days: number = 30): Promise<{ total: number; validated: number; accuracy: number }> {
    try {
      let query = `
        SELECT 
          COUNT(*) as total,
          COUNT(CASE WHEN validated = true AND outcome = true THEN 1 END) as validated
        FROM signals 
        WHERE timestamp > (CURRENT_TIMESTAMP - INTERVAL '${days} days')
      `;
      const params: any[] = [];

      if (signalType) {
        query += ' AND signal_type = $1';
        params.push(signalType);
      }

      const result = await this.db.query(query, params);
      const row = result[0];
      
      const total = parseInt(row.total);
      const validated = parseInt(row.validated);
      const accuracy = total > 0 ? validated / total : 0;

      return { total, validated, accuracy };
    } catch (error) {
      logger.error('Error calculating signal accuracy:', error);
      return { total: 0, validated: 0, accuracy: 0 };
    }
  }

  // Cleanup operations
  async cleanupOldData(days: number = 7): Promise<void> {
    try {
      const tables = [
        'orderbook_snapshots',
        'trade_ticks',
        'microstructure_metrics',
        'front_running_scores'
      ];

      for (const table of tables) {
        const result = await this.db.query(`
          DELETE FROM ${table} 
          WHERE timestamp < (CURRENT_TIMESTAMP - INTERVAL '${days} days')
        `);
        
        logger.info(`Cleaned up ${result.length || 'unknown'} old records from ${table}`);
      }
    } catch (error) {
      logger.error('Error cleaning up old data:', error);
      throw error;
    }
  }

  // Configuration
  setCacheEnabled(enabled: boolean): void {
    this.cacheEnabled = enabled;
    logger.info(`Cache ${enabled ? 'enabled' : 'disabled'}`);
  }

  // Health check
  async healthCheck(): Promise<{ healthy: boolean; details: any }> {
    try {
      const dbHealth = await this.db.healthCheck();
      
      // Test basic operations
      const testMarkets = await this.db.query('SELECT COUNT(*) as count FROM markets');
      const marketCount = parseInt(testMarkets[0].count);

      return {
        healthy: dbHealth.healthy,
        details: {
          ...dbHealth.details,
          marketCount,
          cacheEnabled: this.cacheEnabled,
        }
      };
    } catch (error) {
      logger.error('Data access layer health check failed:', error);
      return {
        healthy: false,
        details: { error: error instanceof Error ? error.message : 'Unknown error' }
      };
    }
  }
}