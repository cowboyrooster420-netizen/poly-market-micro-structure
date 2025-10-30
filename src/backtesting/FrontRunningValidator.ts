import { DatabaseManager } from '../data/database';
import { advancedLogger as logger } from '../utils/AdvancedLogger';
import { HistoricalDataLoader } from './HistoricalDataLoader';

export interface FrontRunningValidation {
  signalId: string;
  marketId: string;
  signalTime: number;
  signalScore: number;
  signalConfidence: number;

  // Price movement analysis
  priceAtSignal: number;
  price5min: number;
  price15min: number;
  price30min: number;
  price1hr: number;

  // Movement metrics
  movement5min: number;
  movement15min: number;
  movement30min: number;
  movement1hr: number;
  maxFavorableMove: number;
  maxAdverseMove: number;

  // Validation result
  wasCorrect: boolean;
  leadTime?: number; // Minutes before significant move
  confidence: 'high' | 'medium' | 'low';
  falsePositive: boolean;
}

export interface FrontRunningMetrics {
  // Overall performance
  totalSignals: number;
  correctPredictions: number;
  accuracy: number;
  falsePositiveRate: number;

  // Lead time analysis
  avgLeadTime: number;
  medianLeadTime: number;
  minLeadTime: number;
  maxLeadTime: number;

  // Movement analysis
  avgMovement5min: number;
  avgMovement15min: number;
  avgMovement30min: number;
  avgMovement1hr: number;

  // By score threshold
  byThreshold: Map<number, {
    threshold: number;
    signalsAbove: number;
    accuracy: number;
    falsePositiveRate: number;
    avgLeadTime: number;
  }>;

  // By confidence level
  byConfidence: {
    high: { count: number; accuracy: number; avgLeadTime: number };
    medium: { count: number; accuracy: number; avgLeadTime: number };
    low: { count: number; accuracy: number; avgLeadTime: number };
  };

  // Recommendations
  recommendations: {
    optimalThreshold: number;
    optimalConfidenceLevel: 'high' | 'medium' | 'low';
    expectedAccuracy: number;
    expectedLeadTime: number;
  };
}

/**
 * Validates front-running detection effectiveness using historical data
 *
 * Analyzes:
 * - Do signals predict price movements?
 * - How early do we detect them (lead time)?
 * - What's the false positive rate?
 * - What thresholds optimize performance?
 */
export class FrontRunningValidator {
  private database: DatabaseManager;
  private dataLoader: HistoricalDataLoader;

  constructor(database: DatabaseManager) {
    this.database = database;
    this.dataLoader = new HistoricalDataLoader(database);
  }

  /**
   * Validate front-running signals for a date range
   */
  async validateSignals(startDate: Date, endDate: Date): Promise<FrontRunningMetrics> {
    logger.info('Validating front-running signals', {
      component: 'front_running_validator',
      operation: 'validate_signals',
      metadata: {
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString()
      }
    });

    // Load all front-running signals from signal_performance table
    const signals = await this.loadFrontRunningSignals(startDate, endDate);

    if (signals.length === 0) {
      logger.warn('No front-running signals found in date range', {
        component: 'front_running_validator',
        operation: 'validate_signals'
      });

      return this.createEmptyMetrics();
    }

    logger.info(`Loaded ${signals.length} front-running signals for validation`, {
      component: 'front_running_validator',
      operation: 'validate_signals',
      metadata: { count: signals.length }
    });

    // Validate each signal
    const validations: FrontRunningValidation[] = [];
    for (const signal of signals) {
      const validation = await this.validateSingleSignal(signal);
      validations.push(validation);
    }

    // Calculate aggregate metrics
    const metrics = this.calculateMetrics(validations);

    logger.info('Front-running validation complete', {
      component: 'front_running_validator',
      operation: 'validate_complete',
      metadata: {
        totalSignals: metrics.totalSignals,
        accuracy: metrics.accuracy,
        avgLeadTime: metrics.avgLeadTime,
        falsePositiveRate: metrics.falsePositiveRate
      }
    });

    return metrics;
  }

  /**
   * Load front-running signals from database
   */
  private async loadFrontRunningSignals(startDate: Date, endDate: Date): Promise<any[]> {
    const sql = `
      SELECT
        sp.*,
        m.outcomes,
        m.outcome_prices
      FROM signal_performance sp
      LEFT JOIN markets m ON sp.market_id = m.id
      WHERE sp.signal_type = 'front_running_detected'
        AND sp.entry_time >= $1
        AND sp.entry_time <= $2
      ORDER BY sp.entry_time ASC
    `;

    return await this.database.query(sql, [startDate, endDate]);
  }

  /**
   * Validate a single front-running signal
   */
  private async validateSingleSignal(signal: any): Promise<FrontRunningValidation> {
    const signalTime = new Date(signal.entry_time).getTime();
    const marketId = signal.market_id;

    // Get price snapshots
    const priceAtSignal = parseFloat(signal.entry_price || 0);
    const price30min = parseFloat(signal.price_30min || signal.entry_price);
    const price1hr = parseFloat(signal.price_1hr || signal.price_30min || signal.entry_price);

    // Load intermediate price points (5min, 15min) from database if available
    const intermediatePrice = await this.loadIntermediatePrices(marketId, signalTime);
    const price5min = intermediatePrice.price5min || priceAtSignal;
    const price15min = intermediatePrice.price15min || price5min;

    // Calculate movements (as percentage)
    const movement5min = this.calculateMovement(priceAtSignal, price5min);
    const movement15min = this.calculateMovement(priceAtSignal, price15min);
    const movement30min = this.calculateMovement(priceAtSignal, price30min);
    const movement1hr = this.calculateMovement(priceAtSignal, price1hr);

    // Determine max favorable/adverse moves
    const allMovements = [movement5min, movement15min, movement30min, movement1hr];
    const maxFavorableMove = Math.max(...allMovements, 0);
    const maxAdverseMove = Math.min(...allMovements, 0);

    // Determine if signal was correct
    // Signal is correct if there was significant movement (>1%) in the predicted direction within 30min
    const significantMove = Math.abs(movement30min) > 1.0; // >1% movement
    const wasCorrect = significantMove && movement30min > 0; // Front-running predicts upward movement

    // Calculate lead time (time until significant movement)
    let leadTime: number | undefined;
    if (wasCorrect) {
      if (Math.abs(movement5min) > 1.0) leadTime = 5;
      else if (Math.abs(movement15min) > 1.0) leadTime = 15;
      else if (Math.abs(movement30min) > 1.0) leadTime = 30;
      else if (Math.abs(movement1hr) > 1.0) leadTime = 60;
    }

    // Determine confidence level from metadata
    const metadata = typeof signal.metadata === 'string'
      ? JSON.parse(signal.metadata)
      : signal.metadata || {};

    const signalScore = parseFloat(signal.confidence || 0);
    const signalConfidence = metadata.frontRunScore?.confidence || signalScore;

    let confidence: 'high' | 'medium' | 'low';
    if (signalConfidence >= 0.8) confidence = 'high';
    else if (signalConfidence >= 0.6) confidence = 'medium';
    else confidence = 'low';

    // False positive: signal fired but no significant movement
    const falsePositive = !significantMove;

    return {
      signalId: signal.id,
      marketId,
      signalTime,
      signalScore,
      signalConfidence,
      priceAtSignal,
      price5min,
      price15min,
      price30min,
      price1hr,
      movement5min,
      movement15min,
      movement30min,
      movement1hr,
      maxFavorableMove,
      maxAdverseMove,
      wasCorrect,
      leadTime,
      confidence,
      falsePositive
    };
  }

  /**
   * Load intermediate price points from database
   */
  private async loadIntermediatePrices(marketId: string, signalTime: number): Promise<{
    price5min: number | null;
    price15min: number | null;
  }> {
    // Query signal_performance table for any signals within the time windows
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
    const time20min = new Date(signalTime + 20 * 60 * 1000); // Buffer for 15min window

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

      // Find price closest to 5min mark
      if (elapsed >= 4 * 60 * 1000 && elapsed <= 6 * 60 * 1000 && !price5min) {
        price5min = parseFloat(row.entry_price);
      }

      // Find price closest to 15min mark
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
   * Calculate aggregate metrics from validations
   */
  private calculateMetrics(validations: FrontRunningValidation[]): FrontRunningMetrics {
    const totalSignals = validations.length;
    const correctPredictions = validations.filter(v => v.wasCorrect).length;
    const accuracy = correctPredictions / totalSignals;
    const falsePositives = validations.filter(v => v.falsePositive).length;
    const falsePositiveRate = falsePositives / totalSignals;

    // Lead time analysis (only for correct predictions)
    const leadTimes = validations
      .filter(v => v.leadTime !== undefined)
      .map(v => v.leadTime!);

    const avgLeadTime = leadTimes.length > 0
      ? leadTimes.reduce((sum, t) => sum + t, 0) / leadTimes.length
      : 0;

    const sortedLeadTimes = [...leadTimes].sort((a, b) => a - b);
    const medianLeadTime = sortedLeadTimes.length > 0
      ? sortedLeadTimes[Math.floor(sortedLeadTimes.length / 2)]
      : 0;

    const minLeadTime = leadTimes.length > 0 ? Math.min(...leadTimes) : 0;
    const maxLeadTime = leadTimes.length > 0 ? Math.max(...leadTimes) : 0;

    // Movement analysis
    const avgMovement5min = this.average(validations.map(v => Math.abs(v.movement5min)));
    const avgMovement15min = this.average(validations.map(v => Math.abs(v.movement15min)));
    const avgMovement30min = this.average(validations.map(v => Math.abs(v.movement30min)));
    const avgMovement1hr = this.average(validations.map(v => Math.abs(v.movement1hr)));

    // Analyze by score threshold
    const thresholds = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
    const byThreshold = new Map();

    for (const threshold of thresholds) {
      const aboveThreshold = validations.filter(v => v.signalScore >= threshold);
      const correctAboveThreshold = aboveThreshold.filter(v => v.wasCorrect).length;
      const falsePosAboveThreshold = aboveThreshold.filter(v => v.falsePositive).length;
      const leadTimesAbove = aboveThreshold.filter(v => v.leadTime !== undefined).map(v => v.leadTime!);

      byThreshold.set(threshold, {
        threshold,
        signalsAbove: aboveThreshold.length,
        accuracy: aboveThreshold.length > 0 ? correctAboveThreshold / aboveThreshold.length : 0,
        falsePositiveRate: aboveThreshold.length > 0 ? falsePosAboveThreshold / aboveThreshold.length : 0,
        avgLeadTime: leadTimesAbove.length > 0
          ? leadTimesAbove.reduce((sum, t) => sum + t, 0) / leadTimesAbove.length
          : 0
      });
    }

    // Analyze by confidence level
    const highConf = validations.filter(v => v.confidence === 'high');
    const medConf = validations.filter(v => v.confidence === 'medium');
    const lowConf = validations.filter(v => v.confidence === 'low');

    const byConfidence = {
      high: {
        count: highConf.length,
        accuracy: highConf.length > 0 ? highConf.filter(v => v.wasCorrect).length / highConf.length : 0,
        avgLeadTime: this.average(highConf.filter(v => v.leadTime).map(v => v.leadTime!))
      },
      medium: {
        count: medConf.length,
        accuracy: medConf.length > 0 ? medConf.filter(v => v.wasCorrect).length / medConf.length : 0,
        avgLeadTime: this.average(medConf.filter(v => v.leadTime).map(v => v.leadTime!))
      },
      low: {
        count: lowConf.length,
        accuracy: lowConf.length > 0 ? lowConf.filter(v => v.wasCorrect).length / lowConf.length : 0,
        avgLeadTime: this.average(lowConf.filter(v => v.leadTime).map(v => v.leadTime!))
      }
    };

    // Calculate recommendations
    const recommendations = this.calculateRecommendations(byThreshold, byConfidence);

    return {
      totalSignals,
      correctPredictions,
      accuracy,
      falsePositiveRate,
      avgLeadTime,
      medianLeadTime,
      minLeadTime,
      maxLeadTime,
      avgMovement5min,
      avgMovement15min,
      avgMovement30min,
      avgMovement1hr,
      byThreshold,
      byConfidence,
      recommendations
    };
  }

  /**
   * Calculate optimal thresholds and recommendations
   */
  private calculateRecommendations(
    byThreshold: Map<number, any>,
    byConfidence: any
  ): {
    optimalThreshold: number;
    optimalConfidenceLevel: 'high' | 'medium' | 'low';
    expectedAccuracy: number;
    expectedLeadTime: number;
  } {
    // Find threshold with best accuracy-to-signal-count ratio
    let optimalThreshold = 0.5;
    let bestScore = 0;

    for (const [threshold, stats] of byThreshold.entries()) {
      // Score = accuracy * log(signalsAbove) to balance accuracy with signal count
      const score = stats.accuracy * Math.log(Math.max(stats.signalsAbove, 1));
      if (score > bestScore) {
        bestScore = score;
        optimalThreshold = threshold;
      }
    }

    // Find optimal confidence level (highest accuracy)
    let optimalConfidenceLevel: 'high' | 'medium' | 'low' = 'high';
    let bestAccuracy = byConfidence.high.accuracy;

    if (byConfidence.medium.accuracy > bestAccuracy && byConfidence.medium.count > 10) {
      optimalConfidenceLevel = 'medium';
      bestAccuracy = byConfidence.medium.accuracy;
    }

    if (byConfidence.low.accuracy > bestAccuracy && byConfidence.low.count > 10) {
      optimalConfidenceLevel = 'low';
      bestAccuracy = byConfidence.low.accuracy;
    }

    const expectedAccuracy = byThreshold.get(optimalThreshold)?.accuracy || 0;
    const expectedLeadTime = byThreshold.get(optimalThreshold)?.avgLeadTime || 0;

    return {
      optimalThreshold,
      optimalConfidenceLevel,
      expectedAccuracy,
      expectedLeadTime
    };
  }

  /**
   * Create empty metrics when no signals found
   */
  private createEmptyMetrics(): FrontRunningMetrics {
    return {
      totalSignals: 0,
      correctPredictions: 0,
      accuracy: 0,
      falsePositiveRate: 0,
      avgLeadTime: 0,
      medianLeadTime: 0,
      minLeadTime: 0,
      maxLeadTime: 0,
      avgMovement5min: 0,
      avgMovement15min: 0,
      avgMovement30min: 0,
      avgMovement1hr: 0,
      byThreshold: new Map(),
      byConfidence: {
        high: { count: 0, accuracy: 0, avgLeadTime: 0 },
        medium: { count: 0, accuracy: 0, avgLeadTime: 0 },
        low: { count: 0, accuracy: 0, avgLeadTime: 0 }
      },
      recommendations: {
        optimalThreshold: 0.5,
        optimalConfidenceLevel: 'high',
        expectedAccuracy: 0,
        expectedLeadTime: 0
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
  generateReport(metrics: FrontRunningMetrics): string {
    const lines: string[] = [];

    lines.push('═'.repeat(100));
    lines.push('FRONT-RUNNING DETECTION VALIDATION REPORT');
    lines.push('═'.repeat(100));
    lines.push('');

    // Overall metrics
    lines.push('Overall Performance:');
    lines.push(`  Total Signals: ${metrics.totalSignals}`);
    lines.push(`  Correct Predictions: ${metrics.correctPredictions} (${(metrics.accuracy * 100).toFixed(1)}%)`);
    lines.push(`  False Positive Rate: ${(metrics.falsePositiveRate * 100).toFixed(1)}%`);
    lines.push('');

    // Lead time analysis
    lines.push('Lead Time Analysis:');
    lines.push(`  Average Lead Time: ${metrics.avgLeadTime.toFixed(1)} minutes`);
    lines.push(`  Median Lead Time: ${metrics.medianLeadTime.toFixed(1)} minutes`);
    lines.push(`  Min Lead Time: ${metrics.minLeadTime.toFixed(1)} minutes`);
    lines.push(`  Max Lead Time: ${metrics.maxLeadTime.toFixed(1)} minutes`);
    lines.push('');

    // Movement analysis
    lines.push('Average Price Movement After Signal:');
    lines.push(`  5 minutes: ${metrics.avgMovement5min.toFixed(2)}%`);
    lines.push(`  15 minutes: ${metrics.avgMovement15min.toFixed(2)}%`);
    lines.push(`  30 minutes: ${metrics.avgMovement30min.toFixed(2)}%`);
    lines.push(`  1 hour: ${metrics.avgMovement1hr.toFixed(2)}%`);
    lines.push('');

    // Threshold analysis
    lines.push('Performance by Score Threshold:');
    lines.push('-'.repeat(100));
    lines.push(
      'Threshold'.padEnd(12) +
      'Signals'.padEnd(10) +
      'Accuracy'.padEnd(12) +
      'False Pos Rate'.padEnd(18) +
      'Avg Lead Time'
    );
    lines.push('-'.repeat(100));

    const sortedThresholds = Array.from(metrics.byThreshold.entries())
      .sort((a, b) => a[0] - b[0]);

    for (const [threshold, stats] of sortedThresholds) {
      lines.push(
        `${threshold.toFixed(1)}`.padEnd(12) +
        stats.signalsAbove.toString().padEnd(10) +
        `${(stats.accuracy * 100).toFixed(1)}%`.padEnd(12) +
        `${(stats.falsePositiveRate * 100).toFixed(1)}%`.padEnd(18) +
        `${stats.avgLeadTime.toFixed(1)} min`
      );
    }

    lines.push('');

    // Confidence level analysis
    lines.push('Performance by Confidence Level:');
    lines.push('-'.repeat(100));
    for (const [level, stats] of Object.entries(metrics.byConfidence)) {
      lines.push(`  ${level.toUpperCase()}:`);
      lines.push(`    Signals: ${stats.count}`);
      lines.push(`    Accuracy: ${(stats.accuracy * 100).toFixed(1)}%`);
      lines.push(`    Avg Lead Time: ${stats.avgLeadTime.toFixed(1)} minutes`);
    }

    lines.push('');

    // Recommendations
    lines.push('═'.repeat(100));
    lines.push('RECOMMENDATIONS');
    lines.push('═'.repeat(100));
    lines.push(`  Optimal Score Threshold: ${metrics.recommendations.optimalThreshold}`);
    lines.push(`  Optimal Confidence Level: ${metrics.recommendations.optimalConfidenceLevel.toUpperCase()}`);
    lines.push(`  Expected Accuracy: ${(metrics.recommendations.expectedAccuracy * 100).toFixed(1)}%`);
    lines.push(`  Expected Lead Time: ${metrics.recommendations.expectedLeadTime.toFixed(1)} minutes`);
    lines.push('');

    const verdict = metrics.accuracy >= 0.7
      ? '✅ PASS: Front-running detection is working effectively'
      : metrics.accuracy >= 0.5
      ? '⚠️  MARGINAL: Front-running detection needs threshold tuning'
      : '❌ FAIL: Front-running detection needs significant improvement';

    lines.push(verdict);
    lines.push('═'.repeat(100));

    return lines.join('\n');
  }
}
