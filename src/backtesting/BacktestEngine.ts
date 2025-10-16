import { DatabaseManager } from '../data/database';
import { DataAccessLayer } from '../data/DataAccessLayer';
import { SignalDetector } from '../services/SignalDetector';
import { EnhancedMicrostructureAnalyzer } from '../services/EnhancedMicrostructureAnalyzer';
import { FrontRunningHeuristicEngine } from '../services/FrontRunningHeuristicEngine';
import { TopicClusteringEngine } from '../services/TopicClusteringEngine';
import { Market, EarlySignal, OrderbookData, EnhancedMicrostructureMetrics } from '../types';
import { BotConfig } from '../types';
import { logger } from '../utils/logger';

export interface BacktestConfig {
  startDate: Date;
  endDate: Date;
  initialCapital: number;
  maxPositionSize: number;
  transactionCosts: number; // in basis points
  slippageCosts: number; // in basis points
  holdingPeriodHours: number; // how long to hold positions
  confidenceThreshold: number; // minimum confidence to trade
  maxConcurrentPositions: number;
}

export interface BacktestResult {
  totalReturns: number;
  sharpeRatio: number;
  maxDrawdown: number;
  winRate: number;
  totalTrades: number;
  avgHoldingPeriod: number;
  signalAccuracy: number;
  dailyReturns: number[];
  trades: TradeRecord[];
  signalPerformance: SignalPerformanceStats[];
  marketStats: MarketBacktestStats;
}

export interface TradeRecord {
  signal: EarlySignal;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  position: 'long' | 'short';
  pnl: number;
  pnlPercent: number;
  holdingPeriodHours: number;
  transactionCosts: number;
}

export interface SignalPerformanceStats {
  signalType: string;
  count: number;
  accuracy: number;
  avgReturns: number;
  sharpeRatio: number;
  bestTrade: number;
  worstTrade: number;
}

export interface MarketBacktestStats {
  totalMarketsAnalyzed: number;
  marketsWithSignals: number;
  avgSignalsPerMarket: number;
  mostActiveMarket: string;
  mostProfitableMarket: string;
  leastProfitableMarket: string;
}

export interface NewsEventValidation {
  signalTime: number;
  newsTime: number;
  timeDiffMinutes: number;
  signalType: string;
  confidence: number;
  actualOutcome: boolean;
  priceImpact: number;
}

export class BacktestEngine {
  private dataLayer: DataAccessLayer;
  private signalDetector: SignalDetector;
  private microstructureAnalyzer: EnhancedMicrostructureAnalyzer;
  private frontRunningEngine: FrontRunningHeuristicEngine;
  private topicClustering: TopicClusteringEngine;
  private config: BotConfig;

  constructor(
    dataLayer: DataAccessLayer,
    config: BotConfig
  ) {
    this.dataLayer = dataLayer;
    this.config = config;
    
    // Initialize analysis engines
    this.signalDetector = new SignalDetector(config);
    this.microstructureAnalyzer = new EnhancedMicrostructureAnalyzer(config);
    this.frontRunningEngine = new FrontRunningHeuristicEngine(config);
    this.topicClustering = new TopicClusteringEngine();
  }

  async runBacktest(backtestConfig: BacktestConfig): Promise<BacktestResult> {
    logger.info('Starting comprehensive backtesting framework...');
    logger.info(`Period: ${backtestConfig.startDate.toISOString()} to ${backtestConfig.endDate.toISOString()}`);
    
    // Step 1: Load historical data
    const historicalData = await this.loadHistoricalData(backtestConfig.startDate, backtestConfig.endDate);
    logger.info(`Loaded historical data for ${historicalData.markets.length} markets`);
    
    // Step 2: Simulate signal generation
    const signals = await this.generateHistoricalSignals(historicalData);
    logger.info(`Generated ${signals.length} historical signals`);
    
    // Step 3: Execute trading simulation
    const trades = await this.simulateTrading(signals, historicalData, backtestConfig);
    logger.info(`Executed ${trades.length} simulated trades`);
    
    // Step 4: Calculate performance metrics
    const result = this.calculatePerformanceMetrics(trades, backtestConfig);
    
    // Step 5: Validate against news events (if available)
    await this.validateAgainstNewsEvents(signals, backtestConfig);
    
    logger.info('Backtesting completed successfully');
    return result;
  }

  private async loadHistoricalData(startDate: Date, endDate: Date): Promise<HistoricalDataSet> {
    const markets = await this.dataLayer.getActiveMarkets(1000);
    const historicalData: HistoricalDataSet = {
      markets: [],
      priceHistory: new Map(),
      orderbookHistory: new Map(),
      microstructureHistory: new Map()
    };

    for (const market of markets) {
      // Load price history
      const prices = await this.dataLayer.getPriceHistory(
        market.id, 
        Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60)) // hours
      );
      
      if (prices.length > 0) {
        historicalData.markets.push(market);
        historicalData.priceHistory.set(market.id, prices);
        
        // Load orderbook snapshots (sample every hour to avoid overwhelming data)
        const orderbookSnapshots = await this.loadOrderbookSnapshots(market.id, startDate, endDate);
        historicalData.orderbookHistory.set(market.id, orderbookSnapshots);
        
        // Load microstructure metrics if available
        const microstructureMetrics = await this.loadMicrostructureMetrics(market.id, startDate, endDate);
        historicalData.microstructureHistory.set(market.id, microstructureMetrics);
      }
    }

    return historicalData;
  }

  private async loadOrderbookSnapshots(marketId: string, startDate: Date, endDate: Date): Promise<OrderbookData[]> {
    // This would load from database - for now return empty array since we're just setting up the framework
    // In production, this would query orderbook_snapshots table with time range
    return [];
  }

  private async loadMicrostructureMetrics(marketId: string, startDate: Date, endDate: Date): Promise<EnhancedMicrostructureMetrics[]> {
    // This would load from database - for now return empty array
    // In production, this would query microstructure_metrics table with time range
    return [];
  }

  private async generateHistoricalSignals(historicalData: HistoricalDataSet): Promise<EarlySignal[]> {
    const signals: EarlySignal[] = [];

    // Classify markets into topic clusters for cross-market analysis
    this.topicClustering.classifyMarkets(historicalData.markets);

    for (const market of historicalData.markets) {
      const priceHistory = historicalData.priceHistory.get(market.id) || [];
      const orderbookHistory = historicalData.orderbookHistory.get(market.id) || [];
      const microstructureHistory = historicalData.microstructureHistory.get(market.id) || [];

      // Generate signals using different detection methods
      
      // 1. Price-based signals
      const priceSignals = await this.generatePriceBasedSignals(market, priceHistory);
      signals.push(...priceSignals);

      // 2. Microstructure signals (if data available)
      if (microstructureHistory.length > 0) {
        const microSignals = this.generateMicrostructureSignals(market, microstructureHistory);
        signals.push(...microSignals);
      }

      // 3. Front-running detection signals
      if (orderbookHistory.length > 0 && microstructureHistory.length > 0) {
        const frontRunSignals = this.generateFrontRunningSignals(market, orderbookHistory, microstructureHistory);
        signals.push(...frontRunSignals);
      }
    }

    // 4. Cross-market coordination signals
    const coordinationSignals = this.generateCrossMarketSignals(historicalData);
    signals.push(...coordinationSignals);

    return signals.sort((a, b) => a.timestamp - b.timestamp);
  }

  private async generatePriceBasedSignals(market: Market, priceHistory: any[]): Promise<EarlySignal[]> {
    const signals: EarlySignal[] = [];
    
    if (priceHistory.length < 10) return signals; // Need minimum data points

    // Simple momentum and mean reversion signals
    for (let i = 5; i < priceHistory.length - 1; i++) {
      const recentPrices = priceHistory.slice(i - 5, i).map(p => p.price);
      const currentPrice = priceHistory[i].price;
      const nextPrice = priceHistory[i + 1].price;
      
      // Calculate momentum
      const momentum = (currentPrice - recentPrices[0]) / recentPrices[0];
      
      // Calculate volatility
      const avgPrice = recentPrices.reduce((sum, p) => sum + p, 0) / recentPrices.length;
      const volatility = Math.sqrt(recentPrices.reduce((sum, p) => sum + Math.pow(p - avgPrice, 2), 0) / recentPrices.length);
      
      // Generate signal if significant momentum detected
      if (Math.abs(momentum) > 0.05) { // 5% threshold
        const confidence = Math.min(Math.abs(momentum) * 10, 1.0);
        
        signals.push({
          marketId: market.id,
          market: market,
          signalType: momentum > 0 ? 'bullish_momentum' : 'bearish_momentum',
          confidence: confidence,
          timestamp: priceHistory[i].timestamp,
          metadata: {
            momentum: momentum,
            volatility: volatility,
            priceImpact: nextPrice - currentPrice,
            actualOutcome: (momentum > 0 && nextPrice > currentPrice) || (momentum < 0 && nextPrice < currentPrice),
            signalSource: 'price_momentum_backtest'
          }
        });
      }
    }

    return signals;
  }

  private generateMicrostructureSignals(market: Market, microstructureHistory: EnhancedMicrostructureMetrics[]): EarlySignal[] {
    const signals: EarlySignal[] = [];

    for (const metrics of microstructureHistory) {
      // Detect anomalies in microstructure metrics
      if (metrics.liquidityVacuum && metrics.imbalanceZScore > 2.0) {
        signals.push({
          marketId: market.id,
          market: market,
          signalType: 'liquidity_vacuum',
          confidence: Math.min(metrics.imbalanceZScore / 3.0, 1.0),
          timestamp: metrics.timestamp,
          metadata: {
            liquidityVacuum: true,
            imbalanceZScore: metrics.imbalanceZScore,
            spreadBps: metrics.spreadBps,
            signalSource: 'microstructure_backtest'
          }
        });
      }

      // Detect orderbook imbalance signals
      if (Math.abs(metrics.orderBookImbalance) > 0.3) {
        signals.push({
          marketId: market.id,
          market: market,
          signalType: 'orderbook_imbalance',
          confidence: Math.min(Math.abs(metrics.orderBookImbalance), 1.0),
          timestamp: metrics.timestamp,
          metadata: {
            orderBookImbalance: metrics.orderBookImbalance,
            depth1Total: metrics.depth1Total,
            signalSource: 'microstructure_backtest'
          }
        });
      }
    }

    return signals;
  }

  private generateFrontRunningSignals(
    market: Market, 
    orderbookHistory: OrderbookData[], 
    microstructureHistory: EnhancedMicrostructureMetrics[]
  ): EarlySignal[] {
    const signals: EarlySignal[] = [];

    // Combine orderbook and microstructure data for front-running detection
    for (let i = 0; i < Math.min(orderbookHistory.length, microstructureHistory.length); i++) {
      const orderbook = orderbookHistory[i];
      const metrics = microstructureHistory[i];

      // Use front-running heuristic engine
      const frontRunScore = this.frontRunningEngine.calculateFrontRunScore(metrics, market);
      
      if (frontRunScore.score > 0.7) { // High confidence threshold
        signals.push({
          marketId: market.id,
          market: market,
          signalType: 'front_running_detected',
          confidence: frontRunScore.confidence,
          timestamp: metrics.timestamp,
          metadata: {
            frontRunScore: frontRunScore.score,
            leakProbability: frontRunScore.leakProbability,
            timeToNews: frontRunScore.timeToNews,
            components: frontRunScore.components,
            signalSource: 'front_running_backtest'
          }
        });
      }
    }

    return signals;
  }

  private generateCrossMarketSignals(historicalData: HistoricalDataSet): EarlySignal[] {
    const signals: EarlySignal[] = [];
    
    // Get entity clusters for cross-market analysis
    const entityClusters = this.topicClustering.getAllEntityClusters();
    
    for (const cluster of entityClusters) {
      if (cluster.marketCount < 2) continue;
      
      const clusterMarkets = this.topicClustering.getEntityMarkets(cluster.entity);
      
      // Analyze coordinated movements across time
      const timeWindows = this.createTimeWindows(historicalData, 60 * 60 * 1000); // 1-hour windows
      
      for (const window of timeWindows) {
        const priceChanges = new Map<string, number>();
        
        for (const market of clusterMarkets) {
          const priceData = historicalData.priceHistory.get(market.id);
          if (priceData) {
            const windowPrices = priceData.filter(p => 
              p.timestamp >= window.start && p.timestamp <= window.end
            );
            
            if (windowPrices.length >= 2) {
              const startPrice = windowPrices[0].price;
              const endPrice = windowPrices[windowPrices.length - 1].price;
              const change = (endPrice - startPrice) / startPrice;
              priceChanges.set(market.id, change);
            }
          }
        }
        
        if (priceChanges.size >= 2) {
          const coordinatedMove = this.topicClustering.detectCoordinatedMovements(
            cluster.entity,
            priceChanges,
            2.0 // 2 sigma threshold
          );
          
          if (coordinatedMove) {
            signals.push({
              marketId: coordinatedMove.markets[0].id,
              market: coordinatedMove.markets[0],
              signalType: 'coordinated_cross_market',
              confidence: coordinatedMove.correlationScore,
              timestamp: window.start,
              metadata: {
                entityCluster: cluster.entity,
                correlationScore: coordinatedMove.correlationScore,
                averageChange: coordinatedMove.averageChange,
                marketCount: coordinatedMove.markets.length,
                signalSource: 'cross_market_backtest'
              }
            });
          }
        }
      }
    }
    
    return signals;
  }

  private createTimeWindows(historicalData: HistoricalDataSet, windowSizeMs: number): TimeWindow[] {
    const allTimestamps: number[] = [];
    
    // Collect all timestamps from price history
    for (const priceHistory of historicalData.priceHistory.values()) {
      allTimestamps.push(...priceHistory.map(p => p.timestamp));
    }
    
    if (allTimestamps.length === 0) return [];
    
    allTimestamps.sort((a, b) => a - b);
    const startTime = allTimestamps[0];
    const endTime = allTimestamps[allTimestamps.length - 1];
    
    const windows: TimeWindow[] = [];
    for (let time = startTime; time < endTime; time += windowSizeMs) {
      windows.push({
        start: time,
        end: Math.min(time + windowSizeMs, endTime)
      });
    }
    
    return windows;
  }

  private async simulateTrading(
    signals: EarlySignal[], 
    historicalData: HistoricalDataSet, 
    backtestConfig: BacktestConfig
  ): Promise<TradeRecord[]> {
    const trades: TradeRecord[] = [];
    const openPositions = new Map<string, TradePosition>();
    let currentCapital = backtestConfig.initialCapital;

    for (const signal of signals) {
      // Check if we should filter this signal
      if (signal.confidence < backtestConfig.confidenceThreshold) continue;
      if (openPositions.size >= backtestConfig.maxConcurrentPositions) continue;

      const priceHistory = historicalData.priceHistory.get(signal.marketId);
      if (!priceHistory) continue;

      // Find entry price at signal time
      const entryPrice = this.findPriceAtTime(priceHistory, signal.timestamp);
      if (!entryPrice) continue;

      // Determine position direction
      const position = this.determinePositionDirection(signal);
      
      // Calculate position size
      const positionSize = Math.min(
        backtestConfig.maxPositionSize,
        currentCapital * 0.1 // Risk 10% per trade
      );

      // Record open position
      const tradePosition: TradePosition = {
        signal,
        entryTime: signal.timestamp,
        entryPrice: entryPrice.price,
        position,
        positionSize,
        exitTime: null,
        exitPrice: null
      };
      
      openPositions.set(signal.marketId, tradePosition);

      // Check for exit conditions on this and existing positions
      await this.checkExitConditions(
        openPositions, 
        historicalData, 
        backtestConfig, 
        signal.timestamp,
        trades
      );
    }

    // Close any remaining open positions at the end
    for (const [marketId, position] of openPositions) {
      const priceHistory = historicalData.priceHistory.get(marketId);
      if (priceHistory && priceHistory.length > 0) {
        const finalPrice = priceHistory[priceHistory.length - 1];
        const trade = this.closePosition(position, finalPrice.price, finalPrice.timestamp, backtestConfig);
        trades.push(trade);
      }
    }

    return trades;
  }

  private findPriceAtTime(priceHistory: any[], timestamp: number): any | null {
    // Find price closest to the signal timestamp
    let closest = null;
    let minDiff = Infinity;

    for (const price of priceHistory) {
      const diff = Math.abs(price.timestamp - timestamp);
      if (diff < minDiff) {
        minDiff = diff;
        closest = price;
      }
    }

    // Only return if within 30 minutes of signal
    return minDiff <= 30 * 60 * 1000 ? closest : null;
  }

  private determinePositionDirection(signal: EarlySignal): 'long' | 'short' {
    // Determine whether to go long or short based on signal type
    const bullishSignals = ['bullish_momentum', 'coordinated_buying', 'positive_leak'];
    const bearishSignals = ['bearish_momentum', 'coordinated_selling', 'negative_leak'];
    
    if (bullishSignals.some(type => signal.signalType.includes(type))) {
      return 'long';
    } else if (bearishSignals.some(type => signal.signalType.includes(type))) {
      return 'short';
    }
    
    // Default to long for neutral signals
    return 'long';
  }

  private async checkExitConditions(
    openPositions: Map<string, TradePosition>,
    historicalData: HistoricalDataSet,
    backtestConfig: BacktestConfig,
    currentTime: number,
    trades: TradeRecord[]
  ): Promise<void> {
    const positionsToClose: string[] = [];

    for (const [marketId, position] of openPositions) {
      const holdingPeriod = currentTime - position.entryTime;
      
      // Exit if holding period exceeded
      if (holdingPeriod >= backtestConfig.holdingPeriodHours * 60 * 60 * 1000) {
        const priceHistory = historicalData.priceHistory.get(marketId);
        if (priceHistory) {
          const exitPrice = this.findPriceAtTime(priceHistory, currentTime);
          if (exitPrice) {
            const trade = this.closePosition(position, exitPrice.price, currentTime, backtestConfig);
            trades.push(trade);
            positionsToClose.push(marketId);
          }
        }
      }
    }

    // Remove closed positions
    for (const marketId of positionsToClose) {
      openPositions.delete(marketId);
    }
  }

  private closePosition(
    position: TradePosition, 
    exitPrice: number, 
    exitTime: number, 
    backtestConfig: BacktestConfig
  ): TradeRecord {
    const pnl = position.position === 'long' 
      ? (exitPrice - position.entryPrice) * position.positionSize / position.entryPrice
      : (position.entryPrice - exitPrice) * position.positionSize / position.entryPrice;
    
    const pnlPercent = pnl / position.positionSize;
    const transactionCosts = position.positionSize * (backtestConfig.transactionCosts + backtestConfig.slippageCosts) / 10000;
    const netPnl = pnl - transactionCosts;

    return {
      signal: position.signal,
      entryTime: position.entryTime,
      exitTime: exitTime,
      entryPrice: position.entryPrice,
      exitPrice: exitPrice,
      position: position.position,
      pnl: netPnl,
      pnlPercent: netPnl / position.positionSize,
      holdingPeriodHours: (exitTime - position.entryTime) / (60 * 60 * 1000),
      transactionCosts: transactionCosts
    };
  }

  private calculatePerformanceMetrics(trades: TradeRecord[], backtestConfig: BacktestConfig): BacktestResult {
    if (trades.length === 0) {
      return this.createEmptyBacktestResult();
    }

    // Calculate basic metrics
    const totalReturns = trades.reduce((sum, trade) => sum + trade.pnl, 0) / backtestConfig.initialCapital;
    const winningTrades = trades.filter(trade => trade.pnl > 0);
    const winRate = winningTrades.length / trades.length;
    
    // Calculate daily returns for Sharpe ratio
    const dailyReturns = this.calculateDailyReturns(trades);
    const avgDailyReturn = dailyReturns.reduce((sum, ret) => sum + ret, 0) / dailyReturns.length;
    const dailyVolatility = Math.sqrt(
      dailyReturns.reduce((sum, ret) => sum + Math.pow(ret - avgDailyReturn, 2), 0) / dailyReturns.length
    );
    const sharpeRatio = dailyVolatility > 0 ? (avgDailyReturn / dailyVolatility) * Math.sqrt(252) : 0;

    // Calculate max drawdown
    const maxDrawdown = this.calculateMaxDrawdown(trades, backtestConfig.initialCapital);

    // Calculate signal performance
    const signalPerformance = this.calculateSignalPerformance(trades);

    // Calculate market stats
    const marketStats = this.calculateMarketStats(trades);

    // Calculate average holding period
    const avgHoldingPeriod = trades.reduce((sum, trade) => sum + trade.holdingPeriodHours, 0) / trades.length;

    // Calculate signal accuracy (percentage of trades that were profitable)
    const signalAccuracy = winRate;

    return {
      totalReturns,
      sharpeRatio,
      maxDrawdown,
      winRate,
      totalTrades: trades.length,
      avgHoldingPeriod,
      signalAccuracy,
      dailyReturns,
      trades,
      signalPerformance,
      marketStats
    };
  }

  private createEmptyBacktestResult(): BacktestResult {
    return {
      totalReturns: 0,
      sharpeRatio: 0,
      maxDrawdown: 0,
      winRate: 0,
      totalTrades: 0,
      avgHoldingPeriod: 0,
      signalAccuracy: 0,
      dailyReturns: [],
      trades: [],
      signalPerformance: [],
      marketStats: {
        totalMarketsAnalyzed: 0,
        marketsWithSignals: 0,
        avgSignalsPerMarket: 0,
        mostActiveMarket: '',
        mostProfitableMarket: '',
        leastProfitableMarket: ''
      }
    };
  }

  private calculateDailyReturns(trades: TradeRecord[]): number[] {
    const dailyPnL = new Map<string, number>();
    
    for (const trade of trades) {
      const day = new Date(trade.exitTime).toISOString().split('T')[0];
      dailyPnL.set(day, (dailyPnL.get(day) || 0) + trade.pnl);
    }
    
    return Array.from(dailyPnL.values());
  }

  private calculateMaxDrawdown(trades: TradeRecord[], initialCapital: number): number {
    let capital = initialCapital;
    let peak = initialCapital;
    let maxDrawdown = 0;

    for (const trade of trades) {
      capital += trade.pnl;
      if (capital > peak) {
        peak = capital;
      }
      const drawdown = (peak - capital) / peak;
      maxDrawdown = Math.max(maxDrawdown, drawdown);
    }

    return maxDrawdown;
  }

  private calculateSignalPerformance(trades: TradeRecord[]): SignalPerformanceStats[] {
    const signalStats = new Map<string, {
      trades: TradeRecord[];
      totalPnL: number;
      winningTrades: number;
    }>();

    // Group trades by signal type
    for (const trade of trades) {
      const signalType = trade.signal.signalType;
      if (!signalStats.has(signalType)) {
        signalStats.set(signalType, { trades: [], totalPnL: 0, winningTrades: 0 });
      }
      
      const stats = signalStats.get(signalType)!;
      stats.trades.push(trade);
      stats.totalPnL += trade.pnl;
      if (trade.pnl > 0) stats.winningTrades++;
    }

    // Calculate performance metrics for each signal type
    const performanceStats: SignalPerformanceStats[] = [];
    for (const [signalType, stats] of signalStats) {
      const count = stats.trades.length;
      const accuracy = stats.winningTrades / count;
      const avgReturns = stats.totalPnL / count;
      
      const returns = stats.trades.map(t => t.pnlPercent);
      const avgReturn = returns.reduce((sum, ret) => sum + ret, 0) / returns.length;
      const returnVolatility = Math.sqrt(
        returns.reduce((sum, ret) => sum + Math.pow(ret - avgReturn, 2), 0) / returns.length
      );
      const sharpeRatio = returnVolatility > 0 ? avgReturn / returnVolatility : 0;
      
      const bestTrade = Math.max(...returns);
      const worstTrade = Math.min(...returns);

      performanceStats.push({
        signalType,
        count,
        accuracy,
        avgReturns,
        sharpeRatio,
        bestTrade,
        worstTrade
      });
    }

    return performanceStats.sort((a, b) => b.avgReturns - a.avgReturns);
  }

  private calculateMarketStats(trades: TradeRecord[]): MarketBacktestStats {
    const marketPnL = new Map<string, number>();
    const marketTradeCount = new Map<string, number>();

    for (const trade of trades) {
      const marketId = trade.signal.marketId;
      marketPnL.set(marketId, (marketPnL.get(marketId) || 0) + trade.pnl);
      marketTradeCount.set(marketId, (marketTradeCount.get(marketId) || 0) + 1);
    }

    const totalMarketsAnalyzed = marketPnL.size;
    const marketsWithSignals = marketTradeCount.size;
    const avgSignalsPerMarket = marketsWithSignals > 0 ? 
      Array.from(marketTradeCount.values()).reduce((sum, count) => sum + count, 0) / marketsWithSignals : 0;

    let mostActiveMarket = '';
    let mostProfitableMarket = '';
    let leastProfitableMarket = '';
    let maxTrades = 0;
    let maxPnL = -Infinity;
    let minPnL = Infinity;

    for (const [marketId, count] of marketTradeCount) {
      if (count > maxTrades) {
        maxTrades = count;
        mostActiveMarket = marketId;
      }
    }

    for (const [marketId, pnl] of marketPnL) {
      if (pnl > maxPnL) {
        maxPnL = pnl;
        mostProfitableMarket = marketId;
      }
      if (pnl < minPnL) {
        minPnL = pnl;
        leastProfitableMarket = marketId;
      }
    }

    return {
      totalMarketsAnalyzed,
      marketsWithSignals,
      avgSignalsPerMarket,
      mostActiveMarket,
      mostProfitableMarket,
      leastProfitableMarket
    };
  }

  private async validateAgainstNewsEvents(signals: EarlySignal[], backtestConfig: BacktestConfig): Promise<NewsEventValidation[]> {
    // This would integrate with news APIs or manual event logs
    // For now, we'll create a placeholder framework
    logger.info('News event validation framework ready (requires news data integration)');
    
    const validations: NewsEventValidation[] = [];
    
    // TODO: Integrate with news APIs (e.g., NewsAPI, Bloomberg, Reuters)
    // TODO: Correlate signal timing with actual news announcements
    // TODO: Validate signal predictions against actual market outcomes
    
    return validations;
  }

  // Method to save backtest results to database
  async saveBacktestResults(result: BacktestResult, config: BacktestConfig): Promise<void> {
    try {
      await this.dataLayer.db.query(`
        INSERT INTO backtest_results (
          start_date, end_date, initial_capital, total_returns, sharpe_ratio, 
          max_drawdown, win_rate, total_trades, signal_accuracy, config, 
          results, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_TIMESTAMP)
      `, [
        config.startDate,
        config.endDate,
        config.initialCapital,
        result.totalReturns,
        result.sharpeRatio,
        result.maxDrawdown,
        result.winRate,
        result.totalTrades,
        result.signalAccuracy,
        JSON.stringify(config),
        JSON.stringify(result)
      ]);
      
      logger.info('Backtest results saved to database');
    } catch (error) {
      logger.error('Error saving backtest results:', error);
    }
  }
}

// Supporting interfaces
interface HistoricalDataSet {
  markets: Market[];
  priceHistory: Map<string, any[]>;
  orderbookHistory: Map<string, OrderbookData[]>;
  microstructureHistory: Map<string, EnhancedMicrostructureMetrics[]>;
}

interface TradePosition {
  signal: EarlySignal;
  entryTime: number;
  entryPrice: number;
  position: 'long' | 'short';
  positionSize: number;
  exitTime: number | null;
  exitPrice: number | null;
}

interface TimeWindow {
  start: number;
  end: number;
}