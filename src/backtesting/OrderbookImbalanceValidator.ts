import { DatabaseManager } from '../data/database';
import { advancedLogger as logger } from '../utils/AdvancedLogger';
import { HistoricalDataLoader } from './HistoricalDataLoader';

export interface ImbalanceValidation {
  signalId: string;
  marketId: string;
  signalTime: number;

  // Imbalance data
  imbalanceRatio: number;
  direction: 'bullish' | 'bearish' | 'neutral';
  bidVolume: number;
  askVolume: number;

  // Price movement
  priceAtSignal: number;
  price5min: number;
  price15min: number;
  price30min: number;
  price1hr: number;

  // Movement analysis
  movement5min: number;
  movement15min: number;
  movement30min: number;
  movement1hr: number;

  // Validation
  directionCorrect: boolean;
  significantMove: boolean;
  leadTime?: number;
  magnitude: number;

  // Market context
  marketVolume: number;
  marketSpread: number;
}

export interface ImbalanceMetrics {
  // Overall performance
  totalSignals: number;
  bullishSignals: number;
  bearishSignals: number;
  neutralSignals: number;

  // Directional accuracy
  bullishCorrect: number;
  bullishAccuracy: number;
  bearishCorrect: number;
  bearishAccuracy: number;
  overallAccuracy: number;

  // Movement analysis
  avgMovement5min: number;
  avgMovement15min: number;
  avgMovement30min: number;
  avgMovement1hr: number;
  avgMagnitude: number;

  // Lead time
  avgLeadTime: number;
  medianLeadTime: number;

  // By imbalance ratio threshold
  byRatioThreshold: Map<number, {
    threshold: number;
    signalsAbove: number;
    accuracy: number;
    avgMagnitude: number;
    avgLeadTime: number;
    winRate: number;
  }>;

  // By market size
  byMarketSize: {
    small: { count: number; accuracy: number; avgMagnitude: number };
    medium: { count: number; accuracy: number; avgMagnitude: number };
    large: { count: number; accuracy: number; avgMagnitude: number };
  };

  // By spread
  bySpread: {
    tight: { count: number; accuracy: number; avgMagnitude: number };
    normal: { count: number; accuracy: number; avgMagnitude: number };
    wide: { count: number; accuracy: number; avgMagnitude: number };
  };

  // Recommendations
  recommendations: {
    optimalRatioThreshold: number;
    expectedAccuracy: number;
    expectedMagnitude: number;
    expectedLeadTime: number;
    shouldUseImbalanceSignals: boolean;
    marketSizePreference: 'small' | 'medium' | 'large' | 'all';
    spreadPreference: 'tight' | 'normal' | 'wide' | 'all';
  };
}

/**
 * Validates orderbook imbalance signal effectiveness
 *
 * Key Questions:
 * - Do bid/ask imbalances predict price direction?
 * - What imbalance ratio threshold optimizes accuracy?
 * - How quickly do imbalances translate to price moves?
 * - Do imbalances work better on certain market types?
 */
export class OrderbookImbalanceValidator {
  private database: DatabaseManager;
  private dataLoader: HistoricalDataLoader;

  // Market size thresholds (volume)
  private readonly SMALL_MARKET_THRESHOLD = 100000; // < $100k
  private readonly MEDIUM_MARKET_THRESHOLD = 1000000; // < $1M

  // Spread thresholds (basis points)
  private readonly TIGHT_SPREAD_THRESHOLD = 50; // < 0.5%
  private readonly NORMAL_SPREAD_THRESHOLD = 200; // < 2%

  constructor(database: DatabaseManager) {
    this.database = database;
    this.dataLoader = new HistoricalDataLoader(database);
  }

  /**
   * Validate orderbook imbalance signals for a date range
   */
  async validateSignals(startDate: Date, endDate: Date): Promise<ImbalanceMetrics> {
    logger.info('Validating orderbook imbalance signals', {
      component: 'imbalance_validator',
      operation: 'validate_signals',
      metadata: {
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString()
      }
    });

    // Load all orderbook imbalance signals
    const signals = await this.loadImbalanceSignals(startDate, endDate);

    if (signals.length === 0) {
      logger.warn('No orderbook imbalance signals found in date range', {
        component: 'imbalance_validator',
        operation: 'validate_signals'
      });

      return this.createEmptyMetrics();
    }

    logger.info(`Loaded ${signals.length} orderbook imbalance signals for validation`, {
      component: 'imbalance_validator',
      operation: 'validate_signals',
      metadata: { count: signals.length }
    });

    // Validate each signal
    const validations: ImbalanceValidation[] = [];
    for (const signal of signals) {
      try {
        const validation = await this.validateSingleSignal(signal);
        validations.push(validation);
      } catch (error) {
        logger.error('Error validating signal:', error as Error, {
          component: 'imbalance_validator',
          operation: 'validate_single_signal',
          metadata: { signalId: signal.id }
        });
      }
    }

    // Calculate aggregate metrics
    const metrics = this.calculateMetrics(validations);

    logger.info('Orderbook imbalance validation complete', {
      component: 'imbalance_validator',
      operation: 'validate_complete',
      metadata: {
        totalSignals: metrics.totalSignals,
        overallAccuracy: metrics.overallAccuracy,
        avgLeadTime: metrics.avgLeadTime,
        optimalThreshold: metrics.recommendations.optimalRatioThreshold
      }
    });

    return metrics;
  }

  /**
   * Load orderbook imbalance signals from database
   */
  private async loadImbalanceSignals(startDate: Date, endDate: Date): Promise<any[]> {
    const sql = `
      SELECT
        sp.*,
        m.volume as market_volume,
        m.outcome_prices
      FROM signal_performance sp
      LEFT JOIN markets m ON sp.market_id = m.id
      WHERE sp.signal_type = 'orderbook_imbalance'
        AND sp.entry_time >= $1
        AND sp.entry_time <= $2
      ORDER BY sp.entry_time ASC
    `;

    return await this.database.query(sql, [startDate, endDate]);
  }

  /**
   * Validate a single orderbook imbalance signal
   */
  private async validateSingleSignal(signal: any): Promise<ImbalanceValidation> {
    const signalTime = new Date(signal.entry_time).getTime();
    const marketId = signal.market_id;

    // Parse metadata for imbalance data
    const metadata = typeof signal.metadata === 'string'
      ? JSON.parse(signal.metadata)
      : signal.metadata || {};

    const microstructureData = metadata.microstructureData || {};
    const context = microstructureData.context || {};

    // Extract imbalance information
    const bidVolume = context.bidVolume || 0;
    const askVolume = context.askVolume || 0;
    const imbalanceRatio = askVolume > 0 ? bidVolume / askVolume : 0;

    // Determine direction
    let direction: 'bullish' | 'bearish' | 'neutral';
    if (imbalanceRatio > 1.2) {
      direction = 'bullish'; // More bid volume = bullish
    } else if (imbalanceRatio < 0.8) {
      direction = 'bearish'; // More ask volume = bearish
    } else {
      direction = 'neutral';
    }

    // Get price snapshots
    const priceAtSignal = parseFloat(signal.entry_price || 0);
    const price30min = parseFloat(signal.price_30min || signal.entry_price);
    const price1hr = parseFloat(signal.price_1hr || signal.price_30min || signal.entry_price);

    // Load intermediate prices
    const intermediatePrice = await this.loadIntermediatePrices(marketId, signalTime);
    const price5min = intermediatePrice.price5min || priceAtSignal;
    const price15min = intermediatePrice.price15min || price5min;

    // Calculate movements
    const movement5min = this.calculateMovement(priceAtSignal, price5min);
    const movement15min = this.calculateMovement(priceAtSignal, price15min);
    const movement30min = this.calculateMovement(priceAtSignal, price30min);
    const movement1hr = this.calculateMovement(priceAtSignal, price1hr);

    // Check directional correctness
    const directionCorrect = this.isDirectionCorrect(direction, movement30min);

    // Determine if there was a significant move (>1%)
    const significantMove = Math.abs(movement30min) > 1.0;

    // Calculate lead time
    let leadTime: number | undefined;
    if (directionCorrect && significantMove) {
      if (this.isDirectionCorrect(direction, movement5min) && Math.abs(movement5min) > 1.0) {
        leadTime = 5;
      } else if (this.isDirectionCorrect(direction, movement15min) && Math.abs(movement15min) > 1.0) {
        leadTime = 15;
      } else if (Math.abs(movement30min) > 1.0) {
        leadTime = 30;
      } else if (this.isDirectionCorrect(direction, movement1hr) && Math.abs(movement1hr) > 1.0) {
        leadTime = 60;
      }
    }

    // Calculate magnitude (absolute move in predicted direction)
    const magnitude = directionCorrect ? Math.abs(movement30min) : 0;

    // Market context
    const marketVolume = parseFloat(signal.market_volume || 0);
    const marketSpread = context.spreadBps || metadata.spread || 0;

    return {
      signalId: signal.id,
      marketId,
      signalTime,
      imbalanceRatio,
      direction,
      bidVolume,
      askVolume,
      priceAtSignal,
      price5min,
      price15min,
      price30min,
      price1hr,
      movement5min,
      movement15min,
      movement30min,
      movement1hr,
      directionCorrect,
      significantMove,
      leadTime,
      magnitude,
      marketVolume,
      marketSpread
    };
  }

  /**
   * Load intermediate price points
   */
  private async loadIntermediatePrices(marketId: string, signalTime: number): Promise<{
    price5min: number | null;
    price15min: number | null;
  }> {
    const sql = `
      SELECT
        entry_time,
        entry_price
      FROM signal_performance
      WHERE market_id = $1
        AND entry_time >= $2
        AND entry_time <= $3
      ORDER BY entry_time ASC
    `;

    const time5min = new Date(signalTime + 5 * 60 * 1000);
    const time15min = new Date(signalTime + 15 * 60 * 1000);
    const time20min = new Date(signalTime + 20 * 60 * 1000);

    const rows = await this.database.query(sql, [
      marketId,
      new Date(signalTime),
      time20min
    ]);

    let price5min: number | null = null;
    let price15min: number | null = null;

    for (const row of rows) {
      const rowTime = new Date(row.entry_time).getTime();
      const elapsed = rowTime - signalTime;

      if (elapsed >= 4 * 60 * 1000 && elapsed <= 6 * 60 * 1000 && !price5min) {
        price5min = parseFloat(row.entry_price);
      }

      if (elapsed >= 14 * 60 * 1000 && elapsed <= 16 * 60 * 1000 && !price15min) {
        price15min = parseFloat(row.entry_price);
      }
    }

    return { price5min, price15min };
  }

  /**
   * Calculate percentage movement
   */
  private calculateMovement(startPrice: number, endPrice: number): number {
    if (startPrice === 0) return 0;
    return ((endPrice - startPrice) / startPrice) * 100;
  }

  /**
   * Check if price moved in the predicted direction
   */
  private isDirectionCorrect(direction: 'bullish' | 'bearish' | 'neutral', movement: number): boolean {
    if (direction === 'neutral') return Math.abs(movement) < 0.5; // Neutral = minimal movement
    if (direction === 'bullish') return movement > 0; // Bullish = price up
    if (direction === 'bearish') return movement < 0; // Bearish = price down
    return false;
  }

  /**
   * Calculate aggregate metrics
   */
  private calculateMetrics(validations: ImbalanceValidation[]): ImbalanceMetrics {
    const totalSignals = validations.length;

    // Count by direction
    const bullishSignals = validations.filter(v => v.direction === 'bullish').length;
    const bearishSignals = validations.filter(v => v.direction === 'bearish').length;
    const neutralSignals = validations.filter(v => v.direction === 'neutral').length;

    // Directional accuracy
    const bullishCorrect = validations.filter(v => v.direction === 'bullish' && v.directionCorrect).length;
    const bearishCorrect = validations.filter(v => v.direction === 'bearish' && v.directionCorrect).length;
    const totalCorrect = validations.filter(v => v.directionCorrect).length;

    const bullishAccuracy = bullishSignals > 0 ? bullishCorrect / bullishSignals : 0;
    const bearishAccuracy = bearishSignals > 0 ? bearishCorrect / bearishSignals : 0;
    const overallAccuracy = totalSignals > 0 ? totalCorrect / totalSignals : 0;

    // Movement analysis
    const avgMovement5min = this.average(validations.map(v => Math.abs(v.movement5min)));
    const avgMovement15min = this.average(validations.map(v => Math.abs(v.movement15min)));
    const avgMovement30min = this.average(validations.map(v => Math.abs(v.movement30min)));
    const avgMovement1hr = this.average(validations.map(v => Math.abs(v.movement1hr)));
    const avgMagnitude = this.average(validations.map(v => v.magnitude));

    // Lead time
    const leadTimes = validations.filter(v => v.leadTime !== undefined).map(v => v.leadTime!);
    const avgLeadTime = this.average(leadTimes);
    const sortedLeadTimes = [...leadTimes].sort((a, b) => a - b);
    const medianLeadTime = sortedLeadTimes.length > 0
      ? sortedLeadTimes[Math.floor(sortedLeadTimes.length / 2)]
      : 0;

    // By ratio threshold
    const ratioThresholds = [1.5, 2.0, 2.5, 3.0, 4.0, 5.0];
    const byRatioThreshold = new Map();

    for (const threshold of ratioThresholds) {
      const aboveThreshold = validations.filter(v =>
        v.imbalanceRatio >= threshold || v.imbalanceRatio <= (1 / threshold)
      );
      const correctAbove = aboveThreshold.filter(v => v.directionCorrect).length;
      const significantAbove = aboveThreshold.filter(v => v.significantMove && v.directionCorrect).length;
      const leadTimesAbove = aboveThreshold.filter(v => v.leadTime !== undefined).map(v => v.leadTime!);

      byRatioThreshold.set(threshold, {
        threshold,
        signalsAbove: aboveThreshold.length,
        accuracy: aboveThreshold.length > 0 ? correctAbove / aboveThreshold.length : 0,
        avgMagnitude: this.average(aboveThreshold.map(v => v.magnitude)),
        avgLeadTime: this.average(leadTimesAbove),
        winRate: aboveThreshold.length > 0 ? significantAbove / aboveThreshold.length : 0
      });
    }

    // By market size
    const smallMarkets = validations.filter(v => v.marketVolume < this.SMALL_MARKET_THRESHOLD);
    const mediumMarkets = validations.filter(v =>
      v.marketVolume >= this.SMALL_MARKET_THRESHOLD && v.marketVolume < this.MEDIUM_MARKET_THRESHOLD
    );
    const largeMarkets = validations.filter(v => v.marketVolume >= this.MEDIUM_MARKET_THRESHOLD);

    const byMarketSize = {
      small: {
        count: smallMarkets.length,
        accuracy: smallMarkets.length > 0
          ? smallMarkets.filter(v => v.directionCorrect).length / smallMarkets.length
          : 0,
        avgMagnitude: this.average(smallMarkets.map(v => v.magnitude))
      },
      medium: {
        count: mediumMarkets.length,
        accuracy: mediumMarkets.length > 0
          ? mediumMarkets.filter(v => v.directionCorrect).length / mediumMarkets.length
          : 0,
        avgMagnitude: this.average(mediumMarkets.map(v => v.magnitude))
      },
      large: {
        count: largeMarkets.length,
        accuracy: largeMarkets.length > 0
          ? largeMarkets.filter(v => v.directionCorrect).length / largeMarkets.length
          : 0,
        avgMagnitude: this.average(largeMarkets.map(v => v.magnitude))
      }
    };

    // By spread
    const tightSpread = validations.filter(v => v.marketSpread < this.TIGHT_SPREAD_THRESHOLD);
    const normalSpread = validations.filter(v =>
      v.marketSpread >= this.TIGHT_SPREAD_THRESHOLD && v.marketSpread < this.NORMAL_SPREAD_THRESHOLD
    );
    const wideSpread = validations.filter(v => v.marketSpread >= this.NORMAL_SPREAD_THRESHOLD);

    const bySpread = {
      tight: {
        count: tightSpread.length,
        accuracy: tightSpread.length > 0
          ? tightSpread.filter(v => v.directionCorrect).length / tightSpread.length
          : 0,
        avgMagnitude: this.average(tightSpread.map(v => v.magnitude))
      },
      normal: {
        count: normalSpread.length,
        accuracy: normalSpread.length > 0
          ? normalSpread.filter(v => v.directionCorrect).length / normalSpread.length
          : 0,
        avgMagnitude: this.average(normalSpread.map(v => v.magnitude))
      },
      wide: {
        count: wideSpread.length,
        accuracy: wideSpread.length > 0
          ? wideSpread.filter(v => v.directionCorrect).length / wideSpread.length
          : 0,
        avgMagnitude: this.average(wideSpread.map(v => v.magnitude))
      }
    };

    // Calculate recommendations
    const recommendations = this.calculateRecommendations(
      byRatioThreshold,
      byMarketSize,
      bySpread,
      overallAccuracy
    );

    return {
      totalSignals,
      bullishSignals,
      bearishSignals,
      neutralSignals,
      bullishCorrect,
      bullishAccuracy,
      bearishCorrect,
      bearishAccuracy,
      overallAccuracy,
      avgMovement5min,
      avgMovement15min,
      avgMovement30min,
      avgMovement1hr,
      avgMagnitude,
      avgLeadTime,
      medianLeadTime,
      byRatioThreshold,
      byMarketSize,
      bySpread,
      recommendations
    };
  }

  /**
   * Calculate recommendations
   */
  private calculateRecommendations(
    byRatioThreshold: Map<number, any>,
    byMarketSize: any,
    bySpread: any,
    overallAccuracy: number
  ): ImbalanceMetrics['recommendations'] {
    // Find optimal ratio threshold (best accuracy with sufficient signal count)
    let optimalRatioThreshold = 2.0;
    let bestScore = 0;

    for (const [threshold, stats] of byRatioThreshold.entries()) {
      // Score = accuracy * log(signals) to balance accuracy with signal count
      const score = stats.accuracy * Math.log(Math.max(stats.signalsAbove, 1));
      if (score > bestScore && stats.signalsAbove >= 10) {
        bestScore = score;
        optimalRatioThreshold = threshold;
      }
    }

    const optimalStats = byRatioThreshold.get(optimalRatioThreshold) || {};
    const expectedAccuracy = optimalStats.accuracy || overallAccuracy;
    const expectedMagnitude = optimalStats.avgMagnitude || 0;
    const expectedLeadTime = optimalStats.avgLeadTime || 0;

    // Should we use imbalance signals? (>60% accuracy threshold)
    const shouldUseImbalanceSignals = expectedAccuracy >= 0.6;

    // Market size preference (highest accuracy)
    let marketSizePreference: 'small' | 'medium' | 'large' | 'all' = 'all';
    const sizes = [
      { name: 'small' as const, accuracy: byMarketSize.small.accuracy, count: byMarketSize.small.count },
      { name: 'medium' as const, accuracy: byMarketSize.medium.accuracy, count: byMarketSize.medium.count },
      { name: 'large' as const, accuracy: byMarketSize.large.accuracy, count: byMarketSize.large.count }
    ];

    const bestSize = sizes
      .filter(s => s.count >= 10)
      .sort((a, b) => b.accuracy - a.accuracy)[0];

    if (bestSize && bestSize.accuracy > overallAccuracy + 0.05) {
      marketSizePreference = bestSize.name;
    }

    // Spread preference (highest accuracy)
    let spreadPreference: 'tight' | 'normal' | 'wide' | 'all' = 'all';
    const spreads = [
      { name: 'tight' as const, accuracy: bySpread.tight.accuracy, count: bySpread.tight.count },
      { name: 'normal' as const, accuracy: bySpread.normal.accuracy, count: bySpread.normal.count },
      { name: 'wide' as const, accuracy: bySpread.wide.accuracy, count: bySpread.wide.count }
    ];

    const bestSpread = spreads
      .filter(s => s.count >= 10)
      .sort((a, b) => b.accuracy - a.accuracy)[0];

    if (bestSpread && bestSpread.accuracy > overallAccuracy + 0.05) {
      spreadPreference = bestSpread.name;
    }

    return {
      optimalRatioThreshold,
      expectedAccuracy,
      expectedMagnitude,
      expectedLeadTime,
      shouldUseImbalanceSignals,
      marketSizePreference,
      spreadPreference
    };
  }

  /**
   * Create empty metrics
   */
  private createEmptyMetrics(): ImbalanceMetrics {
    return {
      totalSignals: 0,
      bullishSignals: 0,
      bearishSignals: 0,
      neutralSignals: 0,
      bullishCorrect: 0,
      bullishAccuracy: 0,
      bearishCorrect: 0,
      bearishAccuracy: 0,
      overallAccuracy: 0,
      avgMovement5min: 0,
      avgMovement15min: 0,
      avgMovement30min: 0,
      avgMovement1hr: 0,
      avgMagnitude: 0,
      avgLeadTime: 0,
      medianLeadTime: 0,
      byRatioThreshold: new Map(),
      byMarketSize: {
        small: { count: 0, accuracy: 0, avgMagnitude: 0 },
        medium: { count: 0, accuracy: 0, avgMagnitude: 0 },
        large: { count: 0, accuracy: 0, avgMagnitude: 0 }
      },
      bySpread: {
        tight: { count: 0, accuracy: 0, avgMagnitude: 0 },
        normal: { count: 0, accuracy: 0, avgMagnitude: 0 },
        wide: { count: 0, accuracy: 0, avgMagnitude: 0 }
      },
      recommendations: {
        optimalRatioThreshold: 2.0,
        expectedAccuracy: 0,
        expectedMagnitude: 0,
        expectedLeadTime: 0,
        shouldUseImbalanceSignals: false,
        marketSizePreference: 'all',
        spreadPreference: 'all'
      }
    };
  }

  /**
   * Helper: calculate average
   */
  private average(numbers: number[]): number {
    if (numbers.length === 0) return 0;
    return numbers.reduce((sum, n) => sum + n, 0) / numbers.length;
  }

  /**
   * Generate validation report
   */
  generateReport(metrics: ImbalanceMetrics): string {
    const lines: string[] = [];

    lines.push('═'.repeat(100));
    lines.push('ORDERBOOK IMBALANCE VALIDATION REPORT');
    lines.push('═'.repeat(100));
    lines.push('');

    // Overall metrics
    lines.push('Overall Performance:');
    lines.push(`  Total Signals: ${metrics.totalSignals}`);
    lines.push(`  Overall Accuracy: ${(metrics.overallAccuracy * 100).toFixed(1)}%`);
    lines.push('');

    // Directional accuracy
    lines.push('Directional Accuracy:');
    lines.push(`  Bullish Imbalances: ${metrics.bullishSignals} signals, ${metrics.bullishCorrect} correct (${(metrics.bullishAccuracy * 100).toFixed(1)}%)`);
    lines.push(`  Bearish Imbalances: ${metrics.bearishSignals} signals, ${metrics.bearishCorrect} correct (${(metrics.bearishAccuracy * 100).toFixed(1)}%)`);
    lines.push(`  Neutral Imbalances: ${metrics.neutralSignals} signals`);
    lines.push('');

    // Movement analysis
    lines.push('Average Price Movement After Signal:');
    lines.push(`  5 minutes: ${metrics.avgMovement5min.toFixed(2)}%`);
    lines.push(`  15 minutes: ${metrics.avgMovement15min.toFixed(2)}%`);
    lines.push(`  30 minutes: ${metrics.avgMovement30min.toFixed(2)}%`);
    lines.push(`  1 hour: ${metrics.avgMovement1hr.toFixed(2)}%`);
    lines.push(`  Average Magnitude: ${metrics.avgMagnitude.toFixed(2)}%`);
    lines.push('');

    // Lead time
    lines.push('Lead Time Analysis:');
    lines.push(`  Average Lead Time: ${metrics.avgLeadTime.toFixed(1)} minutes`);
    lines.push(`  Median Lead Time: ${metrics.medianLeadTime.toFixed(1)} minutes`);
    lines.push('');

    // By ratio threshold
    lines.push('Performance by Imbalance Ratio Threshold:');
    lines.push('-'.repeat(100));
    lines.push(
      'Threshold'.padEnd(12) +
      'Signals'.padEnd(10) +
      'Accuracy'.padEnd(12) +
      'Avg Magnitude'.padEnd(15) +
      'Win Rate'.padEnd(12) +
      'Lead Time'
    );
    lines.push('-'.repeat(100));

    const sortedThresholds = Array.from(metrics.byRatioThreshold.entries())
      .sort((a, b) => a[0] - b[0]);

    for (const [threshold, stats] of sortedThresholds) {
      lines.push(
        `${threshold.toFixed(1)}x`.padEnd(12) +
        stats.signalsAbove.toString().padEnd(10) +
        `${(stats.accuracy * 100).toFixed(1)}%`.padEnd(12) +
        `${stats.avgMagnitude.toFixed(2)}%`.padEnd(15) +
        `${(stats.winRate * 100).toFixed(1)}%`.padEnd(12) +
        `${stats.avgLeadTime.toFixed(1)} min`
      );
    }

    lines.push('');

    // By market size
    lines.push('Performance by Market Size:');
    lines.push('-'.repeat(100));
    for (const [size, stats] of Object.entries(metrics.byMarketSize)) {
      lines.push(`  ${size.toUpperCase()}:`);
      lines.push(`    Signals: ${stats.count}`);
      lines.push(`    Accuracy: ${(stats.accuracy * 100).toFixed(1)}%`);
      lines.push(`    Avg Magnitude: ${stats.avgMagnitude.toFixed(2)}%`);
    }

    lines.push('');

    // By spread
    lines.push('Performance by Spread:');
    lines.push('-'.repeat(100));
    for (const [spread, stats] of Object.entries(metrics.bySpread)) {
      lines.push(`  ${spread.toUpperCase()}:`);
      lines.push(`    Signals: ${stats.count}`);
      lines.push(`    Accuracy: ${(stats.accuracy * 100).toFixed(1)}%`);
      lines.push(`    Avg Magnitude: ${stats.avgMagnitude.toFixed(2)}%`);
    }

    lines.push('');

    // Recommendations
    lines.push('═'.repeat(100));
    lines.push('RECOMMENDATIONS');
    lines.push('═'.repeat(100));
    lines.push(`  Optimal Imbalance Ratio Threshold: ${metrics.recommendations.optimalRatioThreshold}x`);
    lines.push(`  Expected Accuracy: ${(metrics.recommendations.expectedAccuracy * 100).toFixed(1)}%`);
    lines.push(`  Expected Magnitude: ${metrics.recommendations.expectedMagnitude.toFixed(2)}%`);
    lines.push(`  Expected Lead Time: ${metrics.recommendations.expectedLeadTime.toFixed(1)} minutes`);
    lines.push(`  Should Use Imbalance Signals: ${metrics.recommendations.shouldUseImbalanceSignals ? 'YES' : 'NO'}`);
    lines.push(`  Market Size Preference: ${metrics.recommendations.marketSizePreference.toUpperCase()}`);
    lines.push(`  Spread Preference: ${metrics.recommendations.spreadPreference.toUpperCase()}`);
    lines.push('');

    const verdict = metrics.recommendations.shouldUseImbalanceSignals
      ? '✅ PASS: Orderbook imbalance signals are effective'
      : '❌ FAIL: Orderbook imbalance signals need improvement or should be disabled';

    lines.push(verdict);
    lines.push('═'.repeat(100));

    return lines.join('\n');
  }
}
