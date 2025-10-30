import { advancedLogger as logger } from '../utils/AdvancedLogger';
import { HistoricalSignalData, MarketResolution } from './HistoricalDataLoader';
import { SignalPerformanceRecord } from '../services/SignalPerformanceTracker';

export interface MatchedSignalOutcome {
  signalData: HistoricalSignalData;
  resolution: MarketResolution | null;
  wasCorrect: boolean;
  actualPnL: number;
  expectedPnL: number;
  timeToResolution?: number;
  priceAtExit: number;
  exitTime: number;
  holdPeriod: 'early' | 'short' | 'medium' | 'long';
}

export interface BacktestTrade {
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  direction: 'bullish' | 'bearish' | 'neutral';
  size: number;
  pnl: number;
  pnlPercent: number;
  signalType: string;
  confidence: number;
  marketId: string;
  wasCorrect: boolean;
  fees: number;
  slippage: number;
  netPnL: number;
}

export interface MatcherConfig {
  defaultExitWindowHours?: number;
  useActualResolutions?: boolean;
  slippageBps?: number;
  feeBps?: number;
}

/**
 * Matches signals with their actual outcomes to determine profitability
 *
 * This service analyzes historical signal data and determines:
 * - Whether the signal prediction was correct
 * - Actual P&L if we had traded the signal
 * - Optimal holding period for each signal type
 */
export class SignalToOutcomeMatcher {
  private config: Required<MatcherConfig>;

  constructor(config: MatcherConfig = {}) {
    this.config = {
      defaultExitWindowHours: config.defaultExitWindowHours || 24,
      useActualResolutions: config.useActualResolutions !== false,
      slippageBps: config.slippageBps || 20, // 0.2% slippage
      feeBps: config.feeBps || 200 // 2% Polymarket fees
    };
  }

  /**
   * Match signals with their outcomes and calculate profitability
   */
  async matchSignalsWithOutcomes(
    signals: HistoricalSignalData[],
    resolutions: Map<string, MarketResolution>
  ): Promise<MatchedSignalOutcome[]> {
    logger.info(`Matching ${signals.length} signals with market outcomes`, {
      component: 'signal_outcome_matcher',
      operation: 'match_signals',
      metadata: {
        signalCount: signals.length,
        resolutionCount: resolutions.size
      }
    });

    const matched: MatchedSignalOutcome[] = [];

    for (const signalData of signals) {
      const outcome = this.matchSingleSignal(signalData, resolutions);
      matched.push(outcome);
    }

    const correctCount = matched.filter(m => m.wasCorrect).length;
    const avgPnL = matched.reduce((sum, m) => sum + m.actualPnL, 0) / matched.length;

    logger.info(`Matched outcomes: ${correctCount}/${matched.length} correct (${(correctCount / matched.length * 100).toFixed(1)}%), avg P&L: ${avgPnL.toFixed(2)}%`, {
      component: 'signal_outcome_matcher',
      operation: 'match_complete',
      metadata: {
        totalMatched: matched.length,
        correctCount,
        accuracy: correctCount / matched.length,
        avgPnL
      }
    });

    return matched;
  }

  /**
   * Match a single signal with its outcome
   */
  private matchSingleSignal(
    signalData: HistoricalSignalData,
    resolutions: Map<string, MarketResolution>
  ): MatchedSignalOutcome {
    const { signal, market, performanceRecord } = signalData;
    const resolution = resolutions.get(market.id) || null;

    // Determine exit time and price
    const { exitTime, exitPrice, holdPeriod } = this.determineExit(performanceRecord, resolution);

    // Calculate actual P&L
    const actualPnL = this.calculatePnL(
      performanceRecord.entryPrice,
      exitPrice,
      performanceRecord.entryDirection
    );

    // Determine if signal was correct
    const wasCorrect = this.determineCorrectness(
      performanceRecord,
      resolution,
      actualPnL
    );

    // Calculate expected P&L based on confidence
    const expectedPnL = this.calculateExpectedPnL(
      performanceRecord.confidence,
      performanceRecord.entryDirection
    );

    // Calculate time to resolution
    const timeToResolution = resolution?.resolutionTime
      ? resolution.resolutionTime - performanceRecord.entryTime
      : undefined;

    return {
      signalData,
      resolution,
      wasCorrect,
      actualPnL,
      expectedPnL,
      timeToResolution,
      priceAtExit: exitPrice,
      exitTime,
      holdPeriod
    };
  }

  /**
   * Determine exit time and price for a signal
   * Uses performance record snapshots or resolution data
   */
  private determineExit(
    performanceRecord: SignalPerformanceRecord,
    resolution: MarketResolution | null
  ): { exitTime: number; exitPrice: number; holdPeriod: 'early' | 'short' | 'medium' | 'long' } {
    // Priority order:
    // 1. Actual resolution (if available and configured)
    // 2. 24hr snapshot
    // 3. 4hr snapshot
    // 4. 1hr snapshot
    // 5. 30min snapshot
    // 6. Entry price (no movement)

    if (this.config.useActualResolutions && resolution?.resolved && resolution.finalPrice) {
      return {
        exitTime: resolution.resolutionTime || performanceRecord.entryTime,
        exitPrice: resolution.finalPrice,
        holdPeriod: 'long'
      };
    }

    // Use 24hr snapshot if available (preferred for backtesting)
    if (performanceRecord.price24hr !== undefined) {
      return {
        exitTime: performanceRecord.entryTime + 24 * 60 * 60 * 1000,
        exitPrice: performanceRecord.price24hr,
        holdPeriod: 'medium'
      };
    }

    // Fall back to 4hr
    if (performanceRecord.price4hr !== undefined) {
      return {
        exitTime: performanceRecord.entryTime + 4 * 60 * 60 * 1000,
        exitPrice: performanceRecord.price4hr,
        holdPeriod: 'short'
      };
    }

    // Fall back to 1hr
    if (performanceRecord.price1hr !== undefined) {
      return {
        exitTime: performanceRecord.entryTime + 60 * 60 * 1000,
        exitPrice: performanceRecord.price1hr,
        holdPeriod: 'short'
      };
    }

    // Fall back to 30min
    if (performanceRecord.price30min !== undefined) {
      return {
        exitTime: performanceRecord.entryTime + 30 * 60 * 1000,
        exitPrice: performanceRecord.price30min,
        holdPeriod: 'early'
      };
    }

    // No price movement data available
    return {
      exitTime: performanceRecord.entryTime + this.config.defaultExitWindowHours * 60 * 60 * 1000,
      exitPrice: performanceRecord.entryPrice,
      holdPeriod: 'medium'
    };
  }

  /**
   * Calculate P&L as percentage return
   */
  private calculatePnL(entryPrice: number, exitPrice: number, direction: 'bullish' | 'bearish' | 'neutral'): number {
    if (entryPrice === 0) return 0;

    const priceChange = exitPrice - entryPrice;
    const percentChange = (priceChange / entryPrice) * 100;

    // If bullish, profit from price increase
    // If bearish, profit from price decrease
    // If neutral, no P&L
    if (direction === 'neutral') return 0;

    return direction === 'bullish' ? percentChange : -percentChange;
  }

  /**
   * Determine if signal prediction was correct
   */
  private determineCorrectness(
    performanceRecord: SignalPerformanceRecord,
    resolution: MarketResolution | null,
    actualPnL: number
  ): boolean {
    // If we have explicit wasCorrect field from performance tracker, use it
    if (performanceRecord.wasCorrect !== undefined) {
      return performanceRecord.wasCorrect;
    }

    // If market resolved and we know the winning outcome
    if (resolution?.resolved && resolution.winningOutcomeIndex !== undefined) {
      // Signal was correct if it predicted the winning outcome
      return performanceRecord.entryOutcomeIndex === resolution.winningOutcomeIndex;
    }

    // Otherwise, use P&L as proxy for correctness
    // Signal is correct if it made money (after accounting for fees)
    const netPnL = this.calculateNetPnL(actualPnL, performanceRecord.entryPrice);
    return netPnL > 0;
  }

  /**
   * Calculate expected P&L based on signal confidence
   * Higher confidence = higher expected return
   */
  private calculateExpectedPnL(confidence: number, direction: 'bullish' | 'bearish' | 'neutral'): number {
    if (direction === 'neutral') return 0;

    // Simple model: expected return scales with confidence
    // 50% confidence = 0% expected return (neutral)
    // 90% confidence = 10% expected return
    const baseReturn = (confidence - 0.5) * 25; // Scale factor of 25

    return baseReturn;
  }

  /**
   * Calculate net P&L after fees and slippage
   */
  private calculateNetPnL(grossPnL: number, entryPrice: number): number {
    // Convert basis points to percentage
    const slippagePct = this.config.slippageBps / 10000;
    const feePct = this.config.feeBps / 10000;

    // Total cost = slippage + fees (applied to entry price)
    const totalCostPct = slippagePct + feePct;

    // Net P&L = gross P&L - costs
    return grossPnL - (totalCostPct * 100);
  }

  /**
   * Convert matched outcomes to backtest trades
   * Applies realistic slippage and fees
   */
  convertToBacktestTrades(matched: MatchedSignalOutcome[], positionSize: number = 100): BacktestTrade[] {
    return matched.map(m => {
      const { signalData, actualPnL, priceAtExit, exitTime, wasCorrect } = m;
      const { performanceRecord } = signalData;

      // Apply slippage to entry (widens spread)
      const entrySlippage = performanceRecord.entryPrice * (this.config.slippageBps / 10000);
      const effectiveEntryPrice = performanceRecord.entryDirection === 'bullish'
        ? performanceRecord.entryPrice + entrySlippage
        : performanceRecord.entryPrice - entrySlippage;

      // Apply slippage to exit
      const exitSlippage = priceAtExit * (this.config.slippageBps / 10000);
      const effectiveExitPrice = performanceRecord.entryDirection === 'bullish'
        ? priceAtExit - exitSlippage
        : priceAtExit + exitSlippage;

      // Calculate P&L with slippage
      const pnlWithSlippage = this.calculatePnL(
        effectiveEntryPrice,
        effectiveExitPrice,
        performanceRecord.entryDirection
      );

      // Calculate fees (as percentage of position size)
      const fees = positionSize * (this.config.feeBps / 10000);

      // Calculate dollar P&L
      const dollarPnL = (positionSize * pnlWithSlippage) / 100;

      // Net P&L after fees
      const netPnL = dollarPnL - fees;

      return {
        entryTime: performanceRecord.entryTime,
        exitTime,
        entryPrice: effectiveEntryPrice,
        exitPrice: effectiveExitPrice,
        direction: performanceRecord.entryDirection,
        size: positionSize,
        pnl: dollarPnL,
        pnlPercent: pnlWithSlippage,
        signalType: performanceRecord.signalType,
        confidence: performanceRecord.confidence,
        marketId: performanceRecord.marketId,
        wasCorrect,
        fees,
        slippage: Math.abs(entrySlippage + exitSlippage) * positionSize,
        netPnL
      };
    });
  }

  /**
   * Analyze optimal holding period for each signal type
   */
  analyzeOptimalHoldingPeriods(matched: MatchedSignalOutcome[]): Map<string, {
    signalType: string;
    early: { count: number; avgPnL: number };
    short: { count: number; avgPnL: number };
    medium: { count: number; avgPnL: number };
    long: { count: number; avgPnL: number };
    optimalPeriod: 'early' | 'short' | 'medium' | 'long';
  }> {
    const bySignalType = new Map<string, MatchedSignalOutcome[]>();

    // Group by signal type
    for (const m of matched) {
      const signalType = m.signalData.performanceRecord.signalType;
      if (!bySignalType.has(signalType)) {
        bySignalType.set(signalType, []);
      }
      bySignalType.get(signalType)!.push(m);
    }

    const analysis = new Map();

    for (const [signalType, outcomes] of bySignalType.entries()) {
      const byPeriod = {
        early: outcomes.filter(o => o.holdPeriod === 'early'),
        short: outcomes.filter(o => o.holdPeriod === 'short'),
        medium: outcomes.filter(o => o.holdPeriod === 'medium'),
        long: outcomes.filter(o => o.holdPeriod === 'long')
      };

      const stats = {
        signalType,
        early: {
          count: byPeriod.early.length,
          avgPnL: byPeriod.early.length > 0
            ? byPeriod.early.reduce((sum, o) => sum + o.actualPnL, 0) / byPeriod.early.length
            : 0
        },
        short: {
          count: byPeriod.short.length,
          avgPnL: byPeriod.short.length > 0
            ? byPeriod.short.reduce((sum, o) => sum + o.actualPnL, 0) / byPeriod.short.length
            : 0
        },
        medium: {
          count: byPeriod.medium.length,
          avgPnL: byPeriod.medium.length > 0
            ? byPeriod.medium.reduce((sum, o) => sum + o.actualPnL, 0) / byPeriod.medium.length
            : 0
        },
        long: {
          count: byPeriod.long.length,
          avgPnL: byPeriod.long.length > 0
            ? byPeriod.long.reduce((sum, o) => sum + o.actualPnL, 0) / byPeriod.long.length
            : 0
        },
        optimalPeriod: 'medium' as 'early' | 'short' | 'medium' | 'long'
      };

      // Determine optimal period (highest avg P&L with sufficient sample size)
      let maxPnL = -Infinity;
      for (const [period, data] of Object.entries(stats)) {
        if (period === 'signalType' || period === 'optimalPeriod') continue;
        const periodData = data as { count: number; avgPnL: number };
        if (periodData.count >= 5 && periodData.avgPnL > maxPnL) {
          maxPnL = periodData.avgPnL;
          stats.optimalPeriod = period as 'early' | 'short' | 'medium' | 'long';
        }
      }

      analysis.set(signalType, stats);
    }

    return analysis;
  }

  /**
   * Get configuration
   */
  getConfig(): Required<MatcherConfig> {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<MatcherConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }
}
