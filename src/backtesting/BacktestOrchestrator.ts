import { DatabaseManager } from '../data/database';
import { advancedLogger as logger } from '../utils/AdvancedLogger';
import { HistoricalDataLoader, HistoricalDataQuery } from './HistoricalDataLoader';
import { SignalToOutcomeMatcher, MatchedSignalOutcome } from './SignalToOutcomeMatcher';
import { TradeSimulator, SimulatedTrade, PortfolioState } from './TradeSimulator';

export interface BacktestConfig {
  // Data selection
  startDate: Date;
  endDate: Date;
  signalTypes?: string[];
  minConfidence?: number;
  resolvedOnly?: boolean;

  // Trading parameters
  initialCapital: number;
  maxPositionSizePct: number;
  useKellyCriterion: boolean;
  kellyFraction: number;

  // Cost model
  slippageBps: number;
  feeBps: number;
  marketImpactModel: 'none' | 'linear' | 'square_root';

  // Risk management
  stopLossPct?: number;
  takeProfitPct?: number;
  maxConcurrentPositions?: number;

  // Exit strategy
  defaultExitWindowHours: number;
  useActualResolutions: boolean;
}

export interface BacktestReport {
  config: BacktestConfig;
  summary: {
    totalSignals: number;
    signalsTraded: number;
    totalReturn: number;
    totalReturnPct: number;
    sharpeRatio: number;
    maxDrawdown: number;
    winRate: number;
    avgWin: number;
    avgLoss: number;
    profitFactor: number;
    totalFees: number;
    totalSlippage: number;
    finalCapital: number;
  };
  bySignalType: Map<string, {
    signalType: string;
    count: number;
    winRate: number;
    avgPnL: number;
    totalPnL: number;
    sharpeRatio: number;
  }>;
  trades: SimulatedTrade[];
  portfolio: PortfolioState;
  timestamp: number;
}

/**
 * Orchestrates the complete backtesting workflow
 *
 * Workflow:
 * 1. Load historical signals and market data from database
 * 2. Match signals with their actual outcomes
 * 3. Simulate realistic trading with costs and risk management
 * 4. Generate comprehensive performance report
 *
 * This is the main entry point for running backtests
 */
export class BacktestOrchestrator {
  private database: DatabaseManager;
  private dataLoader: HistoricalDataLoader;
  private matcher: SignalToOutcomeMatcher;
  private simulator: TradeSimulator;

  constructor(database: DatabaseManager) {
    this.database = database;
    this.dataLoader = new HistoricalDataLoader(database);
    this.matcher = new SignalToOutcomeMatcher();
    this.simulator = new TradeSimulator();
  }

  /**
   * Run a backtest with the specified configuration
   */
  async runBacktest(config: BacktestConfig): Promise<BacktestReport> {
    logger.info('Starting backtest', {
      component: 'backtest_orchestrator',
      operation: 'run_backtest',
      metadata: {
        startDate: config.startDate.toISOString(),
        endDate: config.endDate.toISOString(),
        initialCapital: config.initialCapital,
        signalTypes: config.signalTypes
      }
    });

    const startTime = Date.now();

    // Step 1: Load historical signals
    logger.info('Step 1/4: Loading historical signals...', {
      component: 'backtest_orchestrator',
      operation: 'load_signals'
    });

    const query: HistoricalDataQuery = {
      startDate: config.startDate,
      endDate: config.endDate,
      signalTypes: config.signalTypes,
      minConfidence: config.minConfidence,
      resolvedOnly: config.resolvedOnly
    };

    const historicalSignals = await this.dataLoader.loadHistoricalSignals(query);

    if (historicalSignals.length === 0) {
      logger.warn('No historical signals found for the specified date range', {
        component: 'backtest_orchestrator',
        operation: 'load_signals'
      });

      return this.createEmptyReport(config);
    }

    logger.info(`Loaded ${historicalSignals.length} historical signals`, {
      component: 'backtest_orchestrator',
      operation: 'load_signals',
      metadata: { count: historicalSignals.length }
    });

    // Step 2: Load market resolutions
    logger.info('Step 2/4: Loading market resolutions...', {
      component: 'backtest_orchestrator',
      operation: 'load_resolutions'
    });

    const marketIds = [...new Set(historicalSignals.map(s => s.market.id))];
    const resolutions = await this.dataLoader.loadMarketResolutions(marketIds);

    logger.info(`Loaded ${resolutions.size} market resolutions`, {
      component: 'backtest_orchestrator',
      operation: 'load_resolutions',
      metadata: { count: resolutions.size }
    });

    // Step 3: Match signals with outcomes
    logger.info('Step 3/4: Matching signals with outcomes...', {
      component: 'backtest_orchestrator',
      operation: 'match_outcomes'
    });

    // Configure matcher
    this.matcher.updateConfig({
      defaultExitWindowHours: config.defaultExitWindowHours,
      useActualResolutions: config.useActualResolutions,
      slippageBps: config.slippageBps,
      feeBps: config.feeBps
    });

    const matched = await this.matcher.matchSignalsWithOutcomes(historicalSignals, resolutions);

    logger.info(`Matched ${matched.length} signals with outcomes`, {
      component: 'backtest_orchestrator',
      operation: 'match_outcomes',
      metadata: { count: matched.length }
    });

    // Convert to backtest trades
    const trades = this.matcher.convertToBacktestTrades(matched, 100); // $100 base position

    // Step 4: Simulate trading
    logger.info('Step 4/4: Simulating trades...', {
      component: 'backtest_orchestrator',
      operation: 'simulate_trades'
    });

    // Configure simulator
    this.simulator.updateConfig({
      initialCapital: config.initialCapital,
      maxPositionSizePct: config.maxPositionSizePct,
      useKellyCriterion: config.useKellyCriterion,
      kellyFraction: config.kellyFraction,
      slippageBps: config.slippageBps,
      feeBps: config.feeBps,
      stopLossPct: config.stopLossPct,
      takeProfitPct: config.takeProfitPct,
      maxConcurrentPositions: config.maxConcurrentPositions,
      marketImpactModel: config.marketImpactModel
    });

    const portfolio = this.simulator.simulateTrades(trades);

    // Generate report
    const report = this.generateReport(config, matched, portfolio);

    const elapsed = Date.now() - startTime;

    logger.info(`Backtest complete in ${elapsed}ms`, {
      component: 'backtest_orchestrator',
      operation: 'backtest_complete',
      metadata: {
        elapsedMs: elapsed,
        totalReturn: report.summary.totalReturn,
        winRate: report.summary.winRate,
        sharpeRatio: report.summary.sharpeRatio
      }
    });

    return report;
  }

  /**
   * Generate comprehensive backtest report
   */
  private generateReport(
    config: BacktestConfig,
    matched: MatchedSignalOutcome[],
    portfolio: PortfolioState
  ): BacktestReport {
    const metrics = this.simulator.calculateMetrics();

    // Calculate per-signal-type statistics
    const bySignalType = new Map<string, {
      signalType: string;
      count: number;
      winRate: number;
      avgPnL: number;
      totalPnL: number;
      sharpeRatio: number;
    }>();

    // Group trades by signal type
    const tradesByType = new Map<string, SimulatedTrade[]>();
    for (const trade of portfolio.closedTrades) {
      if (!tradesByType.has(trade.signalType)) {
        tradesByType.set(trade.signalType, []);
      }
      tradesByType.get(trade.signalType)!.push(trade);
    }

    // Calculate stats for each signal type
    for (const [signalType, trades] of tradesByType.entries()) {
      const wins = trades.filter(t => t.netPnL > 0).length;
      const winRate = wins / trades.length;
      const totalPnL = trades.reduce((sum, t) => sum + t.netPnL, 0);
      const avgPnL = totalPnL / trades.length;

      // Calculate Sharpe ratio for this signal type
      const returns = trades.map(t => (t.netPnL / t.size) * 100);
      const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
      const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
      const stdDev = Math.sqrt(variance);
      const sharpeRatio = stdDev > 0 ? avgReturn / stdDev : 0;

      bySignalType.set(signalType, {
        signalType,
        count: trades.length,
        winRate,
        avgPnL,
        totalPnL,
        sharpeRatio
      });
    }

    return {
      config,
      summary: {
        totalSignals: matched.length,
        signalsTraded: portfolio.closedTrades.length,
        totalReturn: metrics.totalReturn,
        totalReturnPct: metrics.totalReturnPct,
        sharpeRatio: metrics.sharpeRatio,
        maxDrawdown: metrics.maxDrawdown,
        winRate: metrics.winRate,
        avgWin: metrics.avgWin,
        avgLoss: metrics.avgLoss,
        profitFactor: metrics.profitFactor,
        totalFees: portfolio.totalFees,
        totalSlippage: portfolio.totalSlippage,
        finalCapital: portfolio.capital
      },
      bySignalType,
      trades: portfolio.closedTrades,
      portfolio,
      timestamp: Date.now()
    };
  }

  /**
   * Create an empty report when no signals are found
   */
  private createEmptyReport(config: BacktestConfig): BacktestReport {
    return {
      config,
      summary: {
        totalSignals: 0,
        signalsTraded: 0,
        totalReturn: 0,
        totalReturnPct: 0,
        sharpeRatio: 0,
        maxDrawdown: 0,
        winRate: 0,
        avgWin: 0,
        avgLoss: 0,
        profitFactor: 0,
        totalFees: 0,
        totalSlippage: 0,
        finalCapital: config.initialCapital
      },
      bySignalType: new Map(),
      trades: [],
      portfolio: {
        capital: config.initialCapital,
        openPositions: new Map(),
        closedTrades: [],
        totalPnL: 0,
        totalFees: 0,
        totalSlippage: 0,
        winningTrades: 0,
        losingTrades: 0
      },
      timestamp: Date.now()
    };
  }

  /**
   * Run backtest for a specific signal type
   */
  async runSignalTypeBacktest(signalType: string, config: Omit<BacktestConfig, 'signalTypes'>): Promise<BacktestReport> {
    return this.runBacktest({
      ...config,
      signalTypes: [signalType]
    });
  }

  /**
   * Run backtests for all signal types and compare
   */
  async runComparativeBacktest(config: Omit<BacktestConfig, 'signalTypes'>): Promise<Map<string, BacktestReport>> {
    logger.info('Running comparative backtest for all signal types', {
      component: 'backtest_orchestrator',
      operation: 'comparative_backtest'
    });

    // Get all unique signal types from the database
    const stats = await this.dataLoader.getHistoricalStats(config.startDate, config.endDate);
    const signalTypes = Object.keys(stats.signalsByType);

    logger.info(`Found ${signalTypes.length} signal types to test`, {
      component: 'backtest_orchestrator',
      operation: 'comparative_backtest',
      metadata: { signalTypes }
    });

    const reports = new Map<string, BacktestReport>();

    // Run backtest for each signal type
    for (const signalType of signalTypes) {
      try {
        const report = await this.runSignalTypeBacktest(signalType, config);
        reports.set(signalType, report);

        logger.info(`${signalType}: Return=${report.summary.totalReturnPct.toFixed(2)}%, ` +
          `WinRate=${(report.summary.winRate * 100).toFixed(1)}%, ` +
          `Sharpe=${report.summary.sharpeRatio.toFixed(2)}`, {
          component: 'backtest_orchestrator',
          operation: 'signal_type_result',
          metadata: {
            signalType,
            return: report.summary.totalReturnPct,
            winRate: report.summary.winRate,
            sharpe: report.summary.sharpeRatio
          }
        });
      } catch (error) {
        logger.error(`Error backtesting ${signalType}:`, error as Error, {
          component: 'backtest_orchestrator',
          operation: 'signal_type_error',
          metadata: { signalType }
        });
      }
    }

    return reports;
  }

  /**
   * Generate a summary report comparing signal types
   */
  generateComparativeReport(reports: Map<string, BacktestReport>): string {
    const lines: string[] = [];

    lines.push('='.repeat(100));
    lines.push('COMPARATIVE BACKTEST REPORT');
    lines.push('='.repeat(100));
    lines.push('');

    // Sort by total return
    const sorted = Array.from(reports.entries())
      .sort((a, b) => b[1].summary.totalReturnPct - a[1].summary.totalReturnPct);

    lines.push('Signal Type Performance (sorted by return):');
    lines.push('-'.repeat(100));
    lines.push(
      'Signal Type'.padEnd(30) +
      'Trades'.padEnd(10) +
      'Win Rate'.padEnd(12) +
      'Avg Win'.padEnd(12) +
      'Avg Loss'.padEnd(12) +
      'Sharpe'.padEnd(10) +
      'Total Return'
    );
    lines.push('-'.repeat(100));

    for (const [signalType, report] of sorted) {
      const { summary } = report;

      lines.push(
        signalType.padEnd(30) +
        summary.signalsTraded.toString().padEnd(10) +
        `${(summary.winRate * 100).toFixed(1)}%`.padEnd(12) +
        `$${summary.avgWin.toFixed(2)}`.padEnd(12) +
        `$${summary.avgLoss.toFixed(2)}`.padEnd(12) +
        summary.sharpeRatio.toFixed(2).padEnd(10) +
        `$${summary.totalReturn.toFixed(2)} (${summary.totalReturnPct.toFixed(2)}%)`
      );
    }

    lines.push('='.repeat(100));
    lines.push('');

    // Overall statistics
    const allTrades = Array.from(reports.values()).reduce((sum, r) => sum + r.summary.signalsTraded, 0);
    const allReturn = Array.from(reports.values()).reduce((sum, r) => sum + r.summary.totalReturn, 0);
    const avgWinRate = Array.from(reports.values()).reduce((sum, r) => sum + r.summary.winRate, 0) / reports.size;

    lines.push('Overall Statistics:');
    lines.push(`  Total Signals Tested: ${allTrades}`);
    lines.push(`  Total Return: $${allReturn.toFixed(2)}`);
    lines.push(`  Average Win Rate: ${(avgWinRate * 100).toFixed(1)}%`);
    lines.push('');

    // Top 3 best performers
    lines.push('Top 3 Best Performers:');
    for (let i = 0; i < Math.min(3, sorted.length); i++) {
      const [signalType, report] = sorted[i];
      lines.push(`  ${i + 1}. ${signalType}: ${report.summary.totalReturnPct.toFixed(2)}% return, ${(report.summary.winRate * 100).toFixed(1)}% win rate`);
    }

    lines.push('');
    lines.push('='.repeat(100));

    return lines.join('\n');
  }

  /**
   * Get historical data statistics
   */
  async getDataStats(startDate: Date, endDate: Date): Promise<{
    totalSignals: number;
    signalsByType: Record<string, number>;
    resolvedMarkets: number;
    averageConfidence: number;
    dateRange: { start: Date; end: Date };
  }> {
    return this.dataLoader.getHistoricalStats(startDate, endDate);
  }
}
