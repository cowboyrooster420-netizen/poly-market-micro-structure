import { advancedLogger as logger } from '../utils/AdvancedLogger';
import { BacktestTrade } from './SignalToOutcomeMatcher';

export interface TradeSimulatorConfig {
  initialCapital: number;
  maxPositionSizePct: number; // Max % of capital per trade
  useKellyCriterion: boolean;
  kellyFraction: number; // Fraction of Kelly to use (0.25 = quarter Kelly)
  slippageBps: number;
  feeBps: number;
  stopLossPct?: number; // Optional stop-loss percentage
  takeProfitPct?: number; // Optional take-profit percentage
  maxConcurrentPositions?: number;
  marketImpactModel?: 'none' | 'linear' | 'square_root';
}

export interface SimulatedTrade extends BacktestTrade {
  capitalAtEntry: number;
  positionSizeActual: number;
  riskAdjustedSize: number;
  stopLossPrice?: number;
  takeProfitPrice?: number;
  triggeredStopLoss: boolean;
  triggeredTakeProfit: boolean;
  marketImpactBps: number;
  totalCostsBps: number;
}

export interface PortfolioState {
  capital: number;
  openPositions: Map<string, SimulatedTrade>;
  closedTrades: SimulatedTrade[];
  totalPnL: number;
  totalFees: number;
  totalSlippage: number;
  winningTrades: number;
  losingTrades: number;
}

/**
 * Simulates realistic trade execution with slippage, fees, and risk management
 *
 * Features:
 * - Position sizing using Kelly criterion or fixed percentage
 * - Market impact modeling (larger trades = more slippage)
 * - Stop-loss and take-profit execution
 * - Portfolio management (max concurrent positions)
 * - Realistic cost modeling (fees + slippage + market impact)
 */
export class TradeSimulator {
  private config: TradeSimulatorConfig;
  private portfolio: PortfolioState;

  constructor(config: Partial<TradeSimulatorConfig> = {}) {
    this.config = {
      initialCapital: config.initialCapital || 10000,
      maxPositionSizePct: config.maxPositionSizePct || 10, // 10% max per trade
      useKellyCriterion: config.useKellyCriterion !== false,
      kellyFraction: config.kellyFraction || 0.25, // Quarter Kelly (conservative)
      slippageBps: config.slippageBps || 20, // 0.2%
      feeBps: config.feeBps || 200, // 2% Polymarket fees
      stopLossPct: config.stopLossPct,
      takeProfitPct: config.takeProfitPct,
      maxConcurrentPositions: config.maxConcurrentPositions || 10,
      marketImpactModel: config.marketImpactModel || 'square_root'
    };

    this.portfolio = this.initializePortfolio();
  }

  /**
   * Initialize portfolio state
   */
  private initializePortfolio(): PortfolioState {
    return {
      capital: this.config.initialCapital,
      openPositions: new Map(),
      closedTrades: [],
      totalPnL: 0,
      totalFees: 0,
      totalSlippage: 0,
      winningTrades: 0,
      losingTrades: 0
    };
  }

  /**
   * Simulate a sequence of trades
   */
  simulateTrades(trades: BacktestTrade[]): PortfolioState {
    logger.info(`Simulating ${trades.length} trades with $${this.config.initialCapital} initial capital`, {
      component: 'trade_simulator',
      operation: 'simulate_trades',
      metadata: {
        tradeCount: trades.length,
        initialCapital: this.config.initialCapital,
        config: this.config
      }
    });

    // Reset portfolio
    this.portfolio = this.initializePortfolio();

    // Sort trades by entry time
    const sortedTrades = [...trades].sort((a, b) => a.entryTime - b.entryTime);

    for (const trade of sortedTrades) {
      this.executeTrade(trade);
    }

    // Close any remaining open positions at final prices
    this.closeAllPositions();

    logger.info(`Simulation complete: ${this.portfolio.closedTrades.length} trades, ` +
      `P&L: $${this.portfolio.totalPnL.toFixed(2)}, ` +
      `Win rate: ${(this.portfolio.winningTrades / this.portfolio.closedTrades.length * 100).toFixed(1)}%`, {
      component: 'trade_simulator',
      operation: 'simulation_complete',
      metadata: {
        totalTrades: this.portfolio.closedTrades.length,
        totalPnL: this.portfolio.totalPnL,
        winRate: this.portfolio.winningTrades / this.portfolio.closedTrades.length,
        finalCapital: this.portfolio.capital
      }
    });

    return this.portfolio;
  }

  /**
   * Execute a single trade with risk management
   */
  private executeTrade(trade: BacktestTrade): void {
    // Check if we can open a new position
    if (this.portfolio.openPositions.size >= (this.config.maxConcurrentPositions || 10)) {
      // Can't open more positions, skip this trade
      return;
    }

    // Calculate position size
    const positionSize = this.calculatePositionSize(trade);

    if (positionSize <= 0 || positionSize > this.portfolio.capital) {
      // Not enough capital or invalid position size
      return;
    }

    // Calculate market impact based on position size
    const marketImpactBps = this.calculateMarketImpact(positionSize, trade.entryPrice);

    // Total costs = slippage + fees + market impact
    const totalCostsBps = this.config.slippageBps + this.config.feeBps + marketImpactBps;

    // Apply costs to entry price
    const effectiveEntryPrice = trade.direction === 'bullish'
      ? trade.entryPrice * (1 + totalCostsBps / 10000)
      : trade.entryPrice * (1 - totalCostsBps / 10000);

    // Calculate stop-loss and take-profit prices
    let stopLossPrice: number | undefined;
    let takeProfitPrice: number | undefined;

    if (this.config.stopLossPct) {
      stopLossPrice = trade.direction === 'bullish'
        ? effectiveEntryPrice * (1 - this.config.stopLossPct / 100)
        : effectiveEntryPrice * (1 + this.config.stopLossPct / 100);
    }

    if (this.config.takeProfitPct) {
      takeProfitPrice = trade.direction === 'bullish'
        ? effectiveEntryPrice * (1 + this.config.takeProfitPct / 100)
        : effectiveEntryPrice * (1 - this.config.takeProfitPct / 100);
    }

    // Check if stop-loss or take-profit would have been triggered
    const triggeredStopLoss = stopLossPrice !== undefined &&
      ((trade.direction === 'bullish' && trade.exitPrice <= stopLossPrice) ||
       (trade.direction === 'bearish' && trade.exitPrice >= stopLossPrice));

    const triggeredTakeProfit = takeProfitPrice !== undefined &&
      ((trade.direction === 'bullish' && trade.exitPrice >= takeProfitPrice) ||
       (trade.direction === 'bearish' && trade.exitPrice <= takeProfitPrice));

    // Determine actual exit price
    let actualExitPrice = trade.exitPrice;
    if (triggeredStopLoss && stopLossPrice) {
      actualExitPrice = stopLossPrice;
    } else if (triggeredTakeProfit && takeProfitPrice) {
      actualExitPrice = takeProfitPrice;
    }

    // Apply exit costs
    const effectiveExitPrice = trade.direction === 'bullish'
      ? actualExitPrice * (1 - totalCostsBps / 10000)
      : actualExitPrice * (1 + totalCostsBps / 10000);

    // Calculate P&L
    const priceChange = effectiveExitPrice - effectiveEntryPrice;
    const pnlPercent = (priceChange / effectiveEntryPrice) * 100;
    const dollarPnL = trade.direction === 'bullish'
      ? (positionSize * pnlPercent) / 100
      : (positionSize * -pnlPercent) / 100;

    // Calculate fees and slippage in dollars
    const fees = (positionSize * this.config.feeBps / 10000) * 2; // Entry + exit
    const slippage = (positionSize * this.config.slippageBps / 10000) * 2;
    const marketImpactCost = (positionSize * marketImpactBps / 10000) * 2;

    // Net P&L
    const netPnL = dollarPnL - fees - slippage - marketImpactCost;

    // Create simulated trade
    const simulatedTrade: SimulatedTrade = {
      ...trade,
      entryPrice: effectiveEntryPrice,
      exitPrice: effectiveExitPrice,
      capitalAtEntry: this.portfolio.capital,
      size: positionSize,
      positionSizeActual: positionSize,
      riskAdjustedSize: positionSize,
      stopLossPrice,
      takeProfitPrice,
      triggeredStopLoss,
      triggeredTakeProfit,
      marketImpactBps,
      totalCostsBps,
      pnl: dollarPnL,
      pnlPercent,
      fees,
      slippage: slippage + marketImpactCost,
      netPnL
    };

    // Update portfolio
    this.portfolio.capital += netPnL;
    this.portfolio.totalPnL += netPnL;
    this.portfolio.totalFees += fees;
    this.portfolio.totalSlippage += slippage + marketImpactCost;
    this.portfolio.closedTrades.push(simulatedTrade);

    if (netPnL > 0) {
      this.portfolio.winningTrades++;
    } else {
      this.portfolio.losingTrades++;
    }
  }

  /**
   * Calculate position size using Kelly criterion or fixed percentage
   */
  private calculatePositionSize(trade: BacktestTrade): number {
    if (this.config.useKellyCriterion) {
      return this.calculateKellyPositionSize(trade);
    } else {
      return this.calculateFixedPositionSize();
    }
  }

  /**
   * Calculate position size using Kelly criterion
   * Kelly = (winRate * avgWin - lossRate * avgLoss) / avgWin
   */
  private calculateKellyPositionSize(trade: BacktestTrade): number {
    // Use confidence as proxy for win probability
    const winProbability = trade.confidence;
    const lossProbability = 1 - winProbability;

    // Assume average win = 10%, average loss = 5% (simplified)
    const avgWinPct = 10;
    const avgLossPct = 5;

    // Kelly formula
    const kelly = (winProbability * avgWinPct - lossProbability * avgLossPct) / avgWinPct;

    // Apply Kelly fraction (quarter Kelly is more conservative)
    const kellyFraction = Math.max(0, kelly) * this.config.kellyFraction;

    // Position size as percentage of capital
    const positionSizePct = Math.min(kellyFraction * 100, this.config.maxPositionSizePct);

    return (this.portfolio.capital * positionSizePct) / 100;
  }

  /**
   * Calculate fixed position size as percentage of capital
   */
  private calculateFixedPositionSize(): number {
    return (this.portfolio.capital * this.config.maxPositionSizePct) / 100;
  }

  /**
   * Calculate market impact based on position size
   * Larger positions have higher market impact (slippage)
   */
  private calculateMarketImpact(positionSize: number, price: number): number {
    if (this.config.marketImpactModel === 'none') {
      return 0;
    }

    // Calculate position size as percentage of typical market liquidity
    // Assume typical market has $100k liquidity
    const typicalLiquidity = 100000;
    const sizeRatio = positionSize / typicalLiquidity;

    let impactBps: number;

    if (this.config.marketImpactModel === 'linear') {
      // Linear model: impact = k * size
      impactBps = sizeRatio * 100; // 1% impact per 1% of liquidity
    } else {
      // Square root model (more realistic): impact = k * sqrt(size)
      impactBps = Math.sqrt(sizeRatio) * 50;
    }

    // Cap at reasonable maximum (1%)
    return Math.min(impactBps, 100);
  }

  /**
   * Close all open positions (used at end of simulation)
   */
  private closeAllPositions(): void {
    // In this simplified version, all positions are closed immediately
    // In a more sophisticated version, we'd track open positions and close them at market prices
    this.portfolio.openPositions.clear();
  }

  /**
   * Get portfolio state
   */
  getPortfolio(): PortfolioState {
    return { ...this.portfolio };
  }

  /**
   * Calculate performance metrics
   */
  calculateMetrics(): {
    totalReturn: number;
    totalReturnPct: number;
    sharpeRatio: number;
    maxDrawdown: number;
    winRate: number;
    avgWin: number;
    avgLoss: number;
    profitFactor: number;
    totalTrades: number;
  } {
    const trades = this.portfolio.closedTrades;

    if (trades.length === 0) {
      return {
        totalReturn: 0,
        totalReturnPct: 0,
        sharpeRatio: 0,
        maxDrawdown: 0,
        winRate: 0,
        avgWin: 0,
        avgLoss: 0,
        profitFactor: 0,
        totalTrades: 0
      };
    }

    // Total return
    const totalReturn = this.portfolio.totalPnL;
    const totalReturnPct = (totalReturn / this.config.initialCapital) * 100;

    // Win rate
    const winRate = this.portfolio.winningTrades / trades.length;

    // Average win/loss
    const wins = trades.filter(t => t.netPnL > 0);
    const losses = trades.filter(t => t.netPnL <= 0);
    const avgWin = wins.length > 0 ? wins.reduce((sum, t) => sum + t.netPnL, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((sum, t) => sum + t.netPnL, 0) / losses.length : 0;

    // Profit factor
    const grossProfit = wins.reduce((sum, t) => sum + t.netPnL, 0);
    const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.netPnL, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : 0;

    // Sharpe ratio
    const returns = trades.map(t => (t.netPnL / t.size) * 100);
    const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
    const stdDev = Math.sqrt(variance);
    const sharpeRatio = stdDev > 0 ? avgReturn / stdDev : 0;

    // Max drawdown
    let maxDrawdown = 0;
    let peak = this.config.initialCapital;
    let runningCapital = this.config.initialCapital;

    for (const trade of trades) {
      runningCapital += trade.netPnL;
      if (runningCapital > peak) {
        peak = runningCapital;
      }
      const drawdown = ((peak - runningCapital) / peak) * 100;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }

    return {
      totalReturn,
      totalReturnPct,
      sharpeRatio,
      maxDrawdown,
      winRate,
      avgWin,
      avgLoss,
      profitFactor,
      totalTrades: trades.length
    };
  }

  /**
   * Reset simulator
   */
  reset(): void {
    this.portfolio = this.initializePortfolio();
  }

  /**
   * Get configuration
   */
  getConfig(): TradeSimulatorConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<TradeSimulatorConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }
}
