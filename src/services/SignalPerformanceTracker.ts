import { EarlySignal, Market } from '../types';
import { DatabaseManager } from '../data/database';
import { logger } from '../utils/logger';
import { advancedLogger } from '../utils/AdvancedLogger';
import { randomUUID } from 'crypto';

export interface SignalPerformanceRecord {
  id: string;
  signalId?: number;
  marketId: string;
  signalType: string;
  confidence: number;

  // Entry
  entryTime: number;
  entryOutcomeIndex: number;
  entryOutcomeName: string;
  entryPrice: number;
  entryDirection: 'bullish' | 'bearish' | 'neutral';

  // Market state
  marketVolume: number;
  marketActive: boolean;

  // Exit prices
  price30min?: number;
  price1hr?: number;
  price4hr?: number;
  price24hr?: number;
  price7day?: number;

  // P&L
  pnl30min?: number;
  pnl1hr?: number;
  pnl4hr?: number;
  pnl24hr?: number;
  pnl7day?: number;

  // Resolution
  marketResolved: boolean;
  resolutionTime?: number;
  winningOutcomeIndex?: number;
  finalPnL?: number;

  // Quality
  wasCorrect?: boolean;
  magnitude?: number;
  maxFavorableMove?: number;
  maxAdverseMove?: number;

  metadata?: Record<string, any>;
}

export interface SignalTypeStats {
  signalType: string;
  totalSignals: number;
  correctPredictions: number;
  accuracy: number;

  avgPnL30min: number;
  avgPnL1hr: number;
  avgPnL24hr: number;
  avgPnLFinal: number;

  sharpeRatio: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;

  expectedValue: number;
  kellyFraction: number;

  posteriorConfidence: number;
  sampleSize: number;
}

export class SignalPerformanceTracker {
  private database: DatabaseManager;
  private updateInterval: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(database: DatabaseManager) {
    this.database = database;
  }

  async initialize(): Promise<void> {
    advancedLogger.info('Initializing Signal Performance Tracker', {
      component: 'signal_performance_tracker',
      operation: 'initialize'
    });

    // Initialize signal type performance records for all known signal types
    const signalTypes = [
      'volume_spike',
      'price_movement',
      'unusual_activity',
      'new_market',
      'orderbook_imbalance',
      'spread_anomaly',
      'liquidity_shift',
      'market_maker_withdrawal',
      'liquidity_vacuum',
      'micro_price_drift',
      'front_running_detected'
    ];

    for (const type of signalTypes) {
      await this.initializeSignalTypeStats(type);
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) return;

    this.isRunning = true;

    // Update P&L for all open positions every 30 minutes
    this.updateInterval = setInterval(async () => {
      try {
        await this.updateAllSignalPerformance();
      } catch (error) {
        logger.error('Error updating signal performance:', error);
      }
    }, 30 * 60 * 1000);  // 30 minutes

    // Run initial update
    await this.updateAllSignalPerformance();

    advancedLogger.info('Signal Performance Tracker started', {
      component: 'signal_performance_tracker',
      operation: 'start'
    });
  }

  async stop(): Promise<void> {
    this.isRunning = false;

    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }

    advancedLogger.info('Signal Performance Tracker stopped', {
      component: 'signal_performance_tracker',
      operation: 'stop'
    });
  }

  /**
   * Track a new signal
   */
  async trackSignal(signal: EarlySignal, market: Market): Promise<string> {
    // Determine which outcome and direction
    const { outcomeIndex, outcomeName, direction } = this.extractSignalDirection(signal, market);

    const entryPrice = parseFloat(market.outcomePrices[outcomeIndex] || '0');

    const record: SignalPerformanceRecord = {
      id: randomUUID(),
      marketId: market.id,
      signalType: signal.signalType,
      confidence: signal.confidence,

      entryTime: signal.timestamp,
      entryOutcomeIndex: outcomeIndex,
      entryOutcomeName: outcomeName,
      entryPrice,
      entryDirection: direction,

      marketVolume: market.volumeNum,
      marketActive: market.active,

      marketResolved: false,

      metadata: {
        originalSignalMetadata: signal.metadata,
        marketQuestion: market.question,
        marketOutcomes: market.outcomes
      }
    };

    await this.savePerformanceRecord(record);

    advancedLogger.info('Signal tracked for performance monitoring', {
      component: 'signal_performance_tracker',
      operation: 'track_signal',
      metadata: {
        signalType: signal.signalType,
        marketId: market.id.substring(0, 8),
        direction,
        entryPrice
      }
    });

    return record.id;
  }

  /**
   * Update P&L for all open signals
   */
  private async updateAllSignalPerformance(): Promise<void> {
    const openSignals = await this.getOpenSignals();

    advancedLogger.info(`Updating performance for ${openSignals.length} open signals`, {
      component: 'signal_performance_tracker',
      operation: 'update_all_performance'
    });

    for (const record of openSignals) {
      try {
        await this.updateSignalPerformance(record);
      } catch (error) {
        logger.error(`Error updating signal ${record.id}:`, error);
      }
    }

    // Recalculate aggregate stats for all signal types
    await this.recalculateAllSignalTypeStats();
  }

  /**
   * Update P&L for a single signal
   */
  private async updateSignalPerformance(record: SignalPerformanceRecord): Promise<void> {
    // Fetch current market data
    const markets = await this.database.query(
      'SELECT * FROM markets WHERE id = $1 LIMIT 1',
      [record.marketId]
    );

    if (markets.length === 0) {
      logger.warn(`Market ${record.marketId} not found for signal ${record.id}`);
      return;
    }

    const market = markets[0];
    const currentPrice = this.extractPrice(market, record.entryOutcomeIndex);
    const now = Date.now();
    const elapsedMs = now - record.entryTime;

    // Calculate P&L based on time elapsed
    const pnl = this.calculatePnL(record.entryPrice, currentPrice, record.entryDirection);

    const updates: Partial<SignalPerformanceRecord> = {};

    // Update P&L at different time intervals
    if (elapsedMs >= 30 * 60 * 1000 && !record.price30min) {
      updates.price30min = currentPrice;
      updates.pnl30min = pnl;
    }

    if (elapsedMs >= 60 * 60 * 1000 && !record.price1hr) {
      updates.price1hr = currentPrice;
      updates.pnl1hr = pnl;
    }

    if (elapsedMs >= 4 * 60 * 60 * 1000 && !record.price4hr) {
      updates.price4hr = currentPrice;
      updates.pnl4hr = pnl;
    }

    if (elapsedMs >= 24 * 60 * 60 * 1000 && !record.price24hr) {
      updates.price24hr = currentPrice;
      updates.pnl24hr = pnl;
    }

    if (elapsedMs >= 7 * 24 * 60 * 60 * 1000 && !record.price7day) {
      updates.price7day = currentPrice;
      updates.pnl7day = pnl;
    }

    // Check if market is closed/resolved
    if (market.closed && !record.marketResolved) {
      updates.marketResolved = true;
      updates.resolutionTime = now;
      updates.finalPnL = pnl;

      // Determine if signal was correct
      updates.wasCorrect = pnl > 0;
      updates.magnitude = Math.abs(pnl);
    }

    // Track max favorable and adverse moves
    const currentMove = currentPrice - record.entryPrice;
    const favorableMove = record.entryDirection === 'bullish' ? currentMove : -currentMove;

    if (!record.maxFavorableMove || favorableMove > record.maxFavorableMove) {
      updates.maxFavorableMove = favorableMove;
    }

    if (!record.maxAdverseMove || favorableMove < (record.maxAdverseMove || 0)) {
      updates.maxAdverseMove = favorableMove;
    }

    if (Object.keys(updates).length > 0) {
      await this.updatePerformanceRecord(record.id, updates);
    }
  }

  /**
   * Extract price for a specific outcome from market data
   */
  private extractPrice(market: any, outcomeIndex: number): number {
    try {
      const prices = market.outcomes && typeof market.outcomes === 'string'
        ? JSON.parse(market.outcomes)
        : market.outcomes;

      if (Array.isArray(prices) && prices[outcomeIndex] !== undefined) {
        return parseFloat(prices[outcomeIndex]);
      }

      // Fallback: try metadata
      if (market.metadata) {
        const metadata = typeof market.metadata === 'string'
          ? JSON.parse(market.metadata)
          : market.metadata;

        if (metadata.outcomePrices && metadata.outcomePrices[outcomeIndex]) {
          return parseFloat(metadata.outcomePrices[outcomeIndex]);
        }
      }

      return 0;
    } catch (error) {
      logger.error(`Error extracting price for outcome ${outcomeIndex}:`, error);
      return 0;
    }
  }

  /**
   * Calculate P&L as percentage return
   */
  private calculatePnL(entryPrice: number, currentPrice: number, direction: string): number {
    if (entryPrice === 0) return 0;

    const priceChange = currentPrice - entryPrice;
    const percentChange = (priceChange / entryPrice) * 100;

    // If bullish, profit from price increase
    // If bearish, profit from price decrease
    return direction === 'bullish' ? percentChange : -percentChange;
  }

  /**
   * Extract which outcome and direction from signal
   */
  private extractSignalDirection(signal: EarlySignal, market: Market): {
    outcomeIndex: number;
    outcomeName: string;
    direction: 'bullish' | 'bearish' | 'neutral';
  } {
    let outcomeIndex = 0;
    let direction: 'bullish' | 'bearish' | 'neutral' = 'neutral';

    // Extract from metadata
    if (signal.metadata) {
      // Price movement signal
      if (signal.metadata.priceChanges) {
        let maxChange = 0;
        let maxIndex = 0;

        Object.entries(signal.metadata.priceChanges).forEach(([key, value]) => {
          const index = parseInt(key.replace('outcome_', ''));
          const change = value as number;

          if (Math.abs(change) > Math.abs(maxChange)) {
            maxChange = change;
            maxIndex = index;
          }
        });

        outcomeIndex = maxIndex;
        direction = maxChange > 0 ? 'bullish' : 'bearish';
      }

      // Orderbook imbalance
      if (signal.metadata.microstructureData?.context) {
        const bidVolume = signal.metadata.microstructureData.context.bidVolume || 0;
        const askVolume = signal.metadata.microstructureData.context.askVolume || 0;
        const ratio = askVolume > 0 ? bidVolume / askVolume : 0;

        direction = ratio > 1.5 ? 'bullish' : ratio < 0.67 ? 'bearish' : 'neutral';
        outcomeIndex = 0;  // Assume YES outcome for binary markets
      }
    }

    const outcomeName = market.outcomes?.[outcomeIndex] || `Outcome ${outcomeIndex}`;

    return { outcomeIndex, outcomeName, direction };
  }

  /**
   * Get all open (unresolved) signals
   */
  private async getOpenSignals(): Promise<SignalPerformanceRecord[]> {
    // Calculate 7 days ago in JavaScript for database-agnostic query
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const rows = await this.database.query(`
      SELECT * FROM signal_performance
      WHERE market_resolved = $1
      AND entry_time > $2
      ORDER BY entry_time DESC
      LIMIT 1000
    `, [false, sevenDaysAgo]);

    return rows.map((row: any) => this.rowToRecord(row));
  }

  /**
   * Get performance stats for a signal type
   */
  async getSignalTypeStats(signalType: string): Promise<SignalTypeStats | null> {
    const rows = await this.database.query(
      'SELECT * FROM signal_type_performance WHERE signal_type = $1',
      [signalType]
    );

    if (rows.length === 0) return null;

    const row = rows[0];
    return {
      signalType: row.signal_type,
      totalSignals: row.total_signals,
      correctPredictions: row.correct_predictions,
      accuracy: parseFloat(row.accuracy || 0),

      avgPnL30min: parseFloat(row.avg_pnl_30min || 0),
      avgPnL1hr: parseFloat(row.avg_pnl_1hr || 0),
      avgPnL24hr: parseFloat(row.avg_pnl_24hr || 0),
      avgPnLFinal: parseFloat(row.avg_pnl_final || 0),

      sharpeRatio: parseFloat(row.sharpe_ratio || 0),
      winRate: parseFloat(row.win_rate || 0),
      avgWin: parseFloat(row.avg_win || 0),
      avgLoss: parseFloat(row.avg_loss || 0),

      expectedValue: parseFloat(row.expected_value || 0),
      kellyFraction: parseFloat(row.kelly_fraction || 0),

      posteriorConfidence: parseFloat(row.posterior_confidence || 0.5),
      sampleSize: row.sample_size || 0
    };
  }

  /**
   * Recalculate stats for all signal types
   */
  private async recalculateAllSignalTypeStats(): Promise<void> {
    const signalTypes = await this.database.query(
      'SELECT DISTINCT signal_type FROM signal_performance'
    );

    for (const row of signalTypes) {
      await this.recalculateSignalTypeStats(row.signal_type);
    }
  }

  /**
   * Recalculate aggregated stats for a signal type
   */
  private async recalculateSignalTypeStats(signalType: string): Promise<void> {
    // Get all resolved signals for this type
    const signals = await this.database.query(`
      SELECT * FROM signal_performance
      WHERE signal_type = $1
      AND market_resolved = true
      ORDER BY entry_time DESC
      LIMIT 500
    `, [signalType]);

    if (signals.length === 0) return;

    const totalSignals = signals.length;
    const correctPredictions = signals.filter((s: any) => s.was_correct).length;
    const accuracy = correctPredictions / totalSignals;

    // Calculate average P&L
    const avgPnL30min = this.average(signals.map((s: any) => parseFloat(s.pnl_30min || 0)));
    const avgPnL1hr = this.average(signals.map((s: any) => parseFloat(s.pnl_1hr || 0)));
    const avgPnL24hr = this.average(signals.map((s: any) => parseFloat(s.pnl_24hr || 0)));
    const avgPnLFinal = this.average(signals.map((s: any) => parseFloat(s.final_pnl || 0)));

    // Calculate win/loss stats
    const wins = signals.filter((s: any) => parseFloat(s.final_pnl || 0) > 0);
    const losses = signals.filter((s: any) => parseFloat(s.final_pnl || 0) <= 0);

    const winRate = wins.length / totalSignals;
    const avgWin = wins.length > 0 ? this.average(wins.map((s: any) => parseFloat(s.final_pnl))) : 0;
    const avgLoss = losses.length > 0 ? this.average(losses.map((s: any) => parseFloat(s.final_pnl))) : 0;

    // Calculate Sharpe ratio
    const returns = signals.map((s: any) => parseFloat(s.final_pnl || 0));
    const sharpeRatio = this.calculateSharpeRatio(returns);

    // Calculate Expected Value
    const expectedValue = (winRate * avgWin) + ((1 - winRate) * avgLoss);

    // Calculate Kelly Criterion
    const kellyFraction = this.calculateKelly(winRate, avgWin, Math.abs(avgLoss));

    // Bayesian posterior confidence
    const posteriorConfidence = this.calculateBayesianConfidence(accuracy, totalSignals);

    // Save stats
    const now = new Date();
    await this.database.query(`
      INSERT INTO signal_type_performance (
        signal_type, total_signals, correct_predictions, accuracy,
        avg_pnl_30min, avg_pnl_1hr, avg_pnl_24hr, avg_pnl_final,
        sharpe_ratio, win_rate, avg_win, avg_loss,
        expected_value, kelly_fraction, posterior_confidence, sample_size,
        last_updated
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      ON CONFLICT (signal_type) DO UPDATE SET
        total_signals = EXCLUDED.total_signals,
        correct_predictions = EXCLUDED.correct_predictions,
        accuracy = EXCLUDED.accuracy,
        avg_pnl_30min = EXCLUDED.avg_pnl_30min,
        avg_pnl_1hr = EXCLUDED.avg_pnl_1hr,
        avg_pnl_24hr = EXCLUDED.avg_pnl_24hr,
        avg_pnl_final = EXCLUDED.avg_pnl_final,
        sharpe_ratio = EXCLUDED.sharpe_ratio,
        win_rate = EXCLUDED.win_rate,
        avg_win = EXCLUDED.avg_win,
        avg_loss = EXCLUDED.avg_loss,
        expected_value = EXCLUDED.expected_value,
        kelly_fraction = EXCLUDED.kelly_fraction,
        posterior_confidence = EXCLUDED.posterior_confidence,
        sample_size = EXCLUDED.sample_size,
        last_updated = $18
    `, [
      signalType, totalSignals, correctPredictions, accuracy,
      avgPnL30min, avgPnL1hr, avgPnL24hr, avgPnLFinal,
      sharpeRatio, winRate, avgWin, avgLoss,
      expectedValue, kellyFraction, posteriorConfidence, totalSignals,
      now, now
    ]);

    advancedLogger.info(`Updated stats for ${signalType}`, {
      component: 'signal_performance_tracker',
      operation: 'recalculate_stats',
      metadata: {
        signalType,
        sampleSize: totalSignals,
        accuracy,
        sharpeRatio,
        expectedValue
      }
    });
  }

  /**
   * Initialize stats record for a signal type
   */
  private async initializeSignalTypeStats(signalType: string): Promise<void> {
    await this.database.query(`
      INSERT INTO signal_type_performance (signal_type, sample_size)
      VALUES ($1, 0)
      ON CONFLICT (signal_type) DO NOTHING
    `, [signalType]);
  }

  // Helper functions

  private average(numbers: number[]): number {
    if (numbers.length === 0) return 0;
    return numbers.reduce((sum, n) => sum + n, 0) / numbers.length;
  }

  private calculateSharpeRatio(returns: number[]): number {
    if (returns.length < 2) return 0;

    const avgReturn = this.average(returns);
    const variance = this.average(returns.map(r => Math.pow(r - avgReturn, 2)));
    const stdDev = Math.sqrt(variance);

    if (stdDev === 0) return 0;
    return avgReturn / stdDev;
  }

  private calculateKelly(winRate: number, avgWin: number, avgLoss: number): number {
    if (avgLoss === 0) return 0;

    const odds = avgWin / avgLoss;
    const kelly = (winRate * odds - (1 - winRate)) / odds;

    // Cap at reasonable limits
    return Math.max(0, Math.min(kelly, 0.25));  // Max 25% of bankroll
  }

  private calculateBayesianConfidence(accuracy: number, sampleSize: number): number {
    // Bayesian update with uniform prior (0.5)
    const prior = 0.5;
    const priorWeight = 10;  // Equivalent to 10 samples

    const posterior = (accuracy * sampleSize + prior * priorWeight) / (sampleSize + priorWeight);
    return posterior;
  }

  // Database operations

  private async savePerformanceRecord(record: SignalPerformanceRecord): Promise<void> {
    await this.database.query(`
      INSERT INTO signal_performance (
        id, market_id, signal_type, confidence,
        entry_time, entry_outcome_index, entry_outcome_name, entry_price, entry_direction,
        market_volume, market_active, market_resolved, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    `, [
      record.id,
      record.marketId,
      record.signalType,
      record.confidence,
      new Date(record.entryTime),
      record.entryOutcomeIndex,
      record.entryOutcomeName,
      record.entryPrice,
      record.entryDirection,
      record.marketVolume,
      record.marketActive,
      record.marketResolved,
      JSON.stringify(record.metadata || {})
    ]);
  }

  private async updatePerformanceRecord(id: string, updates: Partial<SignalPerformanceRecord>): Promise<void> {
    // Whitelist of allowed column names to prevent SQL injection
    const ALLOWED_COLUMNS = new Set([
      'price_30min', 'price_1hr', 'price_4hr', 'price_24hr', 'price_7day',
      'pnl_30min', 'pnl_1hr', 'pnl_4hr', 'pnl_24hr', 'pnl_7day',
      'market_resolved', 'resolution_time', 'winning_outcome_index', 'final_pnl',
      'was_correct', 'magnitude', 'max_favorable_move', 'max_adverse_move',
      'metadata'
    ]);

    const setClauses: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    Object.entries(updates).forEach(([key, value]) => {
      // Convert camelCase to snake_case
      const columnName = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);

      // Validate column name against whitelist
      if (!ALLOWED_COLUMNS.has(columnName)) {
        logger.warn(`Attempted to update invalid column: ${columnName}`);
        return; // Skip this column
      }

      setClauses.push(`${columnName} = $${paramIndex++}`);
      values.push(value);
    });

    if (setClauses.length === 0) return;

    // Add updated_at timestamp
    setClauses.push(`updated_at = $${paramIndex++}`);
    values.push(new Date());

    values.push(id);
    const query = `
      UPDATE signal_performance
      SET ${setClauses.join(', ')}
      WHERE id = $${paramIndex}
    `;

    await this.database.query(query, values);
  }

  private rowToRecord(row: any): SignalPerformanceRecord {
    return {
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

      marketVolume: parseFloat(row.market_volume || 0),
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

      metadata: row.metadata ? (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) : undefined
    };
  }
}
