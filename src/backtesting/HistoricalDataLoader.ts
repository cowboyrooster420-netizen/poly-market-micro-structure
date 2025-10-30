import { DatabaseManager } from '../data/database';
import { Market, EarlySignal } from '../types';
import { advancedLogger as logger } from '../utils/AdvancedLogger';
import { SignalPerformanceRecord } from '../services/SignalPerformanceTracker';

export interface HistoricalSignalData {
  signal: EarlySignal;
  market: Market;
  performanceRecord: SignalPerformanceRecord;
}

export interface MarketResolution {
  marketId: string;
  resolved: boolean;
  resolutionTime?: number;
  winningOutcomeIndex?: number;
  finalPrice?: number;
}

export interface HistoricalDataQuery {
  startDate: Date;
  endDate: Date;
  signalTypes?: string[];
  minConfidence?: number;
  resolvedOnly?: boolean;
  limit?: number;
}

/**
 * Loads historical signal and market data from the database for backtesting
 *
 * This service queries the signal_performance table to retrieve past signals
 * along with their outcomes, allowing us to validate signal profitability
 */
export class HistoricalDataLoader {
  private database: DatabaseManager;

  constructor(database: DatabaseManager) {
    this.database = database;
  }

  /**
   * Load historical signals with their performance records
   */
  async loadHistoricalSignals(query: HistoricalDataQuery): Promise<HistoricalSignalData[]> {
    const {
      startDate,
      endDate,
      signalTypes,
      minConfidence = 0,
      resolvedOnly = false,
      limit = 10000
    } = query;

    logger.info('Loading historical signals for backtesting', {
      component: 'historical_data_loader',
      operation: 'load_signals',
      metadata: {
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        signalTypes,
        minConfidence,
        resolvedOnly,
        limit
      }
    });

    // Build SQL query
    let sql = `
      SELECT
        sp.*,
        m.question as market_question,
        m.outcomes as market_outcomes,
        m.outcome_prices as market_outcome_prices,
        m.volume as market_volume,
        m.active as market_active,
        m.closed as market_closed,
        m.end_date as market_end_date,
        m.category as market_category,
        m.metadata as market_metadata
      FROM signal_performance sp
      LEFT JOIN markets m ON sp.market_id = m.id
      WHERE sp.entry_time >= $1
        AND sp.entry_time <= $2
        AND sp.confidence >= $3
    `;

    const params: any[] = [startDate, endDate, minConfidence];
    let paramIndex = 4;

    if (signalTypes && signalTypes.length > 0) {
      const placeholders = signalTypes.map((_, i) => `$${paramIndex + i}`).join(', ');
      sql += ` AND sp.signal_type IN (${placeholders})`;
      params.push(...signalTypes);
      paramIndex += signalTypes.length;
    }

    if (resolvedOnly) {
      sql += ` AND sp.market_resolved = true`;
    }

    sql += ` ORDER BY sp.entry_time ASC LIMIT $${paramIndex}`;
    params.push(limit);

    const rows = await this.database.query(sql, params);

    logger.info(`Loaded ${rows.length} historical signals`, {
      component: 'historical_data_loader',
      operation: 'load_signals',
      metadata: { count: rows.length }
    });

    // Convert rows to HistoricalSignalData
    return rows.map((row: any) => this.rowToHistoricalSignalData(row));
  }

  /**
   * Load market resolutions for a set of market IDs
   */
  async loadMarketResolutions(marketIds: string[]): Promise<Map<string, MarketResolution>> {
    if (marketIds.length === 0) {
      return new Map();
    }

    logger.info(`Loading market resolutions for ${marketIds.length} markets`, {
      component: 'historical_data_loader',
      operation: 'load_resolutions'
    });

    const placeholders = marketIds.map((_, i) => `$${i + 1}`).join(', ');
    const sql = `
      SELECT
        id,
        closed,
        end_date,
        outcome_prices,
        metadata
      FROM markets
      WHERE id IN (${placeholders})
    `;

    const rows = await this.database.query(sql, marketIds);

    const resolutions = new Map<string, MarketResolution>();

    for (const row of rows) {
      // Determine winning outcome from final prices
      let winningOutcomeIndex: number | undefined;
      let finalPrice: number | undefined;

      if (row.outcome_prices) {
        const prices = typeof row.outcome_prices === 'string'
          ? JSON.parse(row.outcome_prices)
          : row.outcome_prices;

        if (Array.isArray(prices) && prices.length > 0) {
          // Find outcome with highest price (closest to 1.0)
          let maxPrice = 0;
          prices.forEach((price: string | number, index: number) => {
            const priceNum = typeof price === 'string' ? parseFloat(price) : price;
            if (priceNum > maxPrice) {
              maxPrice = priceNum;
              winningOutcomeIndex = index;
              finalPrice = priceNum;
            }
          });
        }
      }

      resolutions.set(row.id, {
        marketId: row.id,
        resolved: row.closed || false,
        resolutionTime: row.end_date ? new Date(row.end_date).getTime() : undefined,
        winningOutcomeIndex,
        finalPrice
      });
    }

    logger.info(`Loaded ${resolutions.size} market resolutions`, {
      component: 'historical_data_loader',
      operation: 'load_resolutions',
      metadata: {
        count: resolutions.size,
        resolvedCount: Array.from(resolutions.values()).filter(r => r.resolved).length
      }
    });

    return resolutions;
  }

  /**
   * Load price history for a market within a time range
   * Uses signal_performance table snapshots
   */
  async loadPriceHistory(marketId: string, startTime: number, endTime: number): Promise<Array<{
    timestamp: number;
    price: number;
    outcomeIndex: number;
  }>> {
    const sql = `
      SELECT
        entry_time,
        entry_outcome_index,
        entry_price,
        price_30min,
        price_1hr,
        price_4hr,
        price_24hr
      FROM signal_performance
      WHERE market_id = $1
        AND entry_time >= $2
        AND entry_time <= $3
      ORDER BY entry_time ASC
    `;

    const rows = await this.database.query(sql, [
      marketId,
      new Date(startTime),
      new Date(endTime)
    ]);

    const priceHistory: Array<{ timestamp: number; price: number; outcomeIndex: number }> = [];

    for (const row of rows) {
      const entryTime = new Date(row.entry_time).getTime();
      const outcomeIndex = row.entry_outcome_index;

      // Add entry price
      if (row.entry_price) {
        priceHistory.push({
          timestamp: entryTime,
          price: parseFloat(row.entry_price),
          outcomeIndex
        });
      }

      // Add intermediate prices if available
      if (row.price_30min) {
        priceHistory.push({
          timestamp: entryTime + 30 * 60 * 1000,
          price: parseFloat(row.price_30min),
          outcomeIndex
        });
      }

      if (row.price_1hr) {
        priceHistory.push({
          timestamp: entryTime + 60 * 60 * 1000,
          price: parseFloat(row.price_1hr),
          outcomeIndex
        });
      }

      if (row.price_4hr) {
        priceHistory.push({
          timestamp: entryTime + 4 * 60 * 60 * 1000,
          price: parseFloat(row.price_4hr),
          outcomeIndex
        });
      }

      if (row.price_24hr) {
        priceHistory.push({
          timestamp: entryTime + 24 * 60 * 60 * 1000,
          price: parseFloat(row.price_24hr),
          outcomeIndex
        });
      }
    }

    // Sort by timestamp
    priceHistory.sort((a, b) => a.timestamp - b.timestamp);

    return priceHistory;
  }

  /**
   * Get aggregate statistics for historical data
   */
  async getHistoricalStats(startDate: Date, endDate: Date): Promise<{
    totalSignals: number;
    signalsByType: Record<string, number>;
    resolvedMarkets: number;
    averageConfidence: number;
    dateRange: { start: Date; end: Date };
  }> {
    const sql = `
      SELECT
        COUNT(*) as total_signals,
        signal_type,
        AVG(confidence) as avg_confidence,
        COUNT(DISTINCT CASE WHEN market_resolved = true THEN market_id END) as resolved_markets
      FROM signal_performance
      WHERE entry_time >= $1 AND entry_time <= $2
      GROUP BY signal_type
    `;

    const rows = await this.database.query(sql, [startDate, endDate]);

    const signalsByType: Record<string, number> = {};
    let totalSignals = 0;
    let totalConfidence = 0;
    let resolvedMarkets = 0;

    for (const row of rows) {
      const count = parseInt(row.total_signals || '0');
      signalsByType[row.signal_type] = count;
      totalSignals += count;
      totalConfidence += parseFloat(row.avg_confidence || '0') * count;
      resolvedMarkets += parseInt(row.resolved_markets || '0');
    }

    const averageConfidence = totalSignals > 0 ? totalConfidence / totalSignals : 0;

    return {
      totalSignals,
      signalsByType,
      resolvedMarkets,
      averageConfidence,
      dateRange: { start: startDate, end: endDate }
    };
  }

  /**
   * Convert database row to HistoricalSignalData
   */
  private rowToHistoricalSignalData(row: any): HistoricalSignalData {
    // Build Market object from joined data
    const market: Market = {
      id: row.market_id,
      question: row.market_question || '',
      outcomes: this.parseJSON(row.market_outcomes) || [],
      outcomePrices: this.parseJSON(row.market_outcome_prices) || [],
      volume: row.market_volume || '0',
      volumeNum: parseFloat(row.market_volume || '0'),
      active: row.market_active || false,
      closed: row.market_closed || false,
      endDate: row.market_end_date,
      category: row.market_category,
      spread: 0
    };

    // Build EarlySignal from signal_performance data
    const signal: EarlySignal = {
      marketId: row.market_id,
      market: market,
      signalType: row.signal_type,
      timestamp: new Date(row.entry_time).getTime(),
      confidence: parseFloat(row.confidence),
      metadata: this.parseJSON(row.metadata) || {}
    };

    // Build SignalPerformanceRecord
    const performanceRecord: SignalPerformanceRecord = {
      id: row.id,
      signalId: row.signal_id,
      marketId: row.market_id,
      signalType: row.signal_type,
      confidence: parseFloat(row.confidence),

      entryTime: new Date(row.entry_time).getTime(),
      entryOutcomeIndex: row.entry_outcome_index,
      entryOutcomeName: row.entry_outcome_name,
      entryPrice: parseFloat(row.entry_price),
      entryDirection: row.entry_direction,

      marketVolume: parseFloat(row.market_volume || '0'),
      marketActive: row.market_active,

      price30min: row.price_30min ? parseFloat(row.price_30min) : undefined,
      price1hr: row.price_1hr ? parseFloat(row.price_1hr) : undefined,
      price4hr: row.price_4hr ? parseFloat(row.price_4hr) : undefined,
      price24hr: row.price_24hr ? parseFloat(row.price_24hr) : undefined,
      price7day: row.price_7day ? parseFloat(row.price_7day) : undefined,

      pnl30min: row.pnl_30min ? parseFloat(row.pnl_30min) : undefined,
      pnl1hr: row.pnl_1hr ? parseFloat(row.pnl_1hr) : undefined,
      pnl4hr: row.pnl_4hr ? parseFloat(row.pnl_4hr) : undefined,
      pnl24hr: row.pnl_24hr ? parseFloat(row.pnl_24hr) : undefined,
      pnl7day: row.pnl_7day ? parseFloat(row.pnl_7day) : undefined,

      marketResolved: row.market_resolved,
      resolutionTime: row.resolution_time ? new Date(row.resolution_time).getTime() : undefined,
      winningOutcomeIndex: row.winning_outcome_index,
      finalPnL: row.final_pnl ? parseFloat(row.final_pnl) : undefined,

      wasCorrect: row.was_correct,
      magnitude: row.magnitude ? parseFloat(row.magnitude) : undefined,
      maxFavorableMove: row.max_favorable_move ? parseFloat(row.max_favorable_move) : undefined,
      maxAdverseMove: row.max_adverse_move ? parseFloat(row.max_adverse_move) : undefined,

      metadata: this.parseJSON(row.metadata)
    };

    return {
      signal,
      market,
      performanceRecord
    };
  }

  /**
   * Safely parse JSON strings
   */
  private parseJSON(value: any): any {
    if (!value) return null;
    if (typeof value === 'object') return value;
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    }
    return null;
  }
}
