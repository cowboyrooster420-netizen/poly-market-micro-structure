import { OrderbookData, OrderbookLevel, TickData, MicrostructureSignal, BotConfig } from '../types';
import { logger } from '../utils/logger';
import { calculateTightness } from '../utils/spreadHelpers';

interface OrderFlowMetrics {
  marketId: string;
  timestamp: number;
  
  // Multi-level imbalances
  bidAskImbalance: number;        // Traditional top-of-book
  level2Imbalance: number;        // 2-level deep imbalance
  level5Imbalance: number;        // 5-level deep imbalance
  weightedImbalance: number;      // Volume-weighted across all levels
  
  // Flow characteristics
  bidPressure: number;            // Cumulative bid strength
  askPressure: number;            // Cumulative ask strength
  liquidityRatio: number;         // Total liquidity concentration
  
  // Market maker behavior
  spreadTightness: number;        // How tight is the spread
  marketMakerPresence: number;    // Are MMs active or pulling?
  orderSizeDistribution: number;  // Are there unusually large orders?
  
  // Velocity metrics
  flowVelocity: number;           // How fast is order flow changing
  pressureAcceleration: number;   // Is pressure building or releasing
  
  // Edge detection
  icebergProbability: number;     // Likelihood of hidden large orders
  wallStrength: number;           // Strength of support/resistance levels
  liquidationRisk: number;       // Risk of forced selling/buying
}

interface FlowSignal {
  type: 'aggressive_buyer' | 'aggressive_seller' | 'iceberg_detected' | 'wall_break' | 'liquidity_vacuum' | 'smart_money' | 'stop_hunt';
  severity: 'low' | 'medium' | 'high' | 'critical';
  confidence: number;
  timeHorizon: 'immediate' | 'short' | 'medium'; // Expected signal duration
  details: any;
}

export class OrderFlowAnalyzer {
  private config: BotConfig;
  private flowHistory: Map<string, OrderFlowMetrics[]> = new Map();
  private orderbookSnapshots: Map<string, OrderbookData[]> = new Map();
  private recentTrades: Map<string, TickData[]> = new Map();
  
  // Configuration for flow analysis
  private readonly HISTORY_LENGTH = 100;      // Keep last 100 flow metrics
  private readonly ORDERBOOK_DEPTH = 10;      // Analyze 10 levels deep
  private readonly TRADE_WINDOW_MS = 30000;   // 30 second trade window
  
  constructor(config: BotConfig) {
    this.config = config;
  }

  // Main analysis entry point
  analyzeOrderFlow(orderbook: OrderbookData, recentTrades?: TickData[]): FlowSignal[] {
    const metrics = this.calculateFlowMetrics(orderbook, recentTrades);
    this.storeMetrics(metrics);
    
    if (recentTrades) {
      this.storeRecentTrades(orderbook.marketId, recentTrades);
    }
    
    return this.detectFlowSignals(metrics);
  }

  private calculateFlowMetrics(orderbook: OrderbookData, recentTrades?: TickData[]): OrderFlowMetrics {
    const { bids, asks, marketId, timestamp } = orderbook;
    
    // Multi-level imbalances
    const bidAskImbalance = this.calculateTopOfBookImbalance(bids, asks);
    const level2Imbalance = this.calculateLevelNImbalance(bids, asks, 2);
    const level5Imbalance = this.calculateLevelNImbalance(bids, asks, 5);
    const weightedImbalance = this.calculateWeightedImbalance(bids, asks);
    
    // Flow pressure analysis
    const { bidPressure, askPressure } = this.calculateFlowPressure(bids, asks);
    const liquidityRatio = this.calculateLiquidityConcentration(bids, asks);
    
    // Market maker behavior
    const spreadTightness = this.calculateSpreadTightness(orderbook);
    const marketMakerPresence = this.calculateMarketMakerPresence(bids, asks);
    const orderSizeDistribution = this.calculateOrderSizeDistribution(bids, asks);
    
    // Velocity and acceleration
    const flowVelocity = this.calculateFlowVelocity(marketId, bidAskImbalance);
    const pressureAcceleration = this.calculatePressureAcceleration(marketId, bidPressure, askPressure);
    
    // Advanced edge detection
    const icebergProbability = this.detectIcebergOrders(bids, asks, recentTrades);
    const wallStrength = this.calculateWallStrength(bids, asks);
    const liquidationRisk = this.calculateLiquidationRisk(orderbook, recentTrades);

    return {
      marketId,
      timestamp,
      bidAskImbalance,
      level2Imbalance,
      level5Imbalance,
      weightedImbalance,
      bidPressure,
      askPressure,
      liquidityRatio,
      spreadTightness,
      marketMakerPresence,
      orderSizeDistribution,
      flowVelocity,
      pressureAcceleration,
      icebergProbability,
      wallStrength,
      liquidationRisk,
    };
  }

  // Core imbalance calculations
  private calculateTopOfBookImbalance(bids: OrderbookLevel[], asks: OrderbookLevel[]): number {
    if (bids.length === 0 || asks.length === 0) return 0;
    
    const bidSize = bids[0].size;
    const askSize = asks[0].size;
    const totalSize = bidSize + askSize;
    
    return totalSize > 0 ? (bidSize - askSize) / totalSize : 0;
  }

  private calculateLevelNImbalance(bids: OrderbookLevel[], asks: OrderbookLevel[], levels: number): number {
    const bidLevels = bids.slice(0, levels);
    const askLevels = asks.slice(0, levels);
    
    const totalBidSize = bidLevels.reduce((sum, level) => sum + level.size, 0);
    const totalAskSize = askLevels.reduce((sum, level) => sum + level.size, 0);
    const totalSize = totalBidSize + totalAskSize;
    
    return totalSize > 0 ? (totalBidSize - totalAskSize) / totalSize : 0;
  }

  private calculateWeightedImbalance(bids: OrderbookLevel[], asks: OrderbookLevel[]): number {
    if (bids.length === 0 || asks.length === 0) return 0;
    
    const midPrice = (bids[0].price + asks[0].price) / 2;
    let weightedBidSize = 0;
    let weightedAskSize = 0;
    
    // Weight orders by distance from mid price (closer = higher weight)
    for (const bid of bids.slice(0, this.ORDERBOOK_DEPTH)) {
      const distance = Math.abs(bid.price - midPrice);
      const weight = 1 / (1 + distance * 100); // Exponential decay with distance
      weightedBidSize += bid.size * weight;
    }
    
    for (const ask of asks.slice(0, this.ORDERBOOK_DEPTH)) {
      const distance = Math.abs(ask.price - midPrice);
      const weight = 1 / (1 + distance * 100);
      weightedAskSize += ask.size * weight;
    }
    
    const totalWeightedSize = weightedBidSize + weightedAskSize;
    return totalWeightedSize > 0 ? (weightedBidSize - weightedAskSize) / totalWeightedSize : 0;
  }

  // Flow pressure analysis
  private calculateFlowPressure(bids: OrderbookLevel[], asks: OrderbookLevel[]): { bidPressure: number; askPressure: number } {
    // Calculate cumulative pressure at each level
    // For prediction markets, use SIZE only (not size × price) to avoid bias
    // toward high-probability markets. Price scaling would make the same order
    // size appear 9x stronger at 90% vs 10% probability.
    let bidPressure = 0;
    let askPressure = 0;

    // Bid pressure: larger orders deeper in book indicate strong support
    for (let i = 0; i < Math.min(bids.length, this.ORDERBOOK_DEPTH); i++) {
      const levelWeight = 1 / (i + 1); // Deeper levels have less weight
      bidPressure += bids[i].size * levelWeight;
    }

    for (let i = 0; i < Math.min(asks.length, this.ORDERBOOK_DEPTH); i++) {
      const levelWeight = 1 / (i + 1);
      askPressure += asks[i].size * levelWeight;
    }

    return { bidPressure, askPressure };
  }

  private calculateLiquidityConcentration(bids: OrderbookLevel[], asks: OrderbookLevel[]): number {
    // Measure how concentrated liquidity is (0 = spread out, 1 = concentrated at top)
    const totalBidLiquidity = bids.reduce((sum, level) => sum + level.size, 0);
    const totalAskLiquidity = asks.reduce((sum, level) => sum + level.size, 0);
    
    if (totalBidLiquidity === 0 || totalAskLiquidity === 0) return 0;
    
    const topBidRatio = bids.length > 0 ? bids[0].size / totalBidLiquidity : 0;
    const topAskRatio = asks.length > 0 ? asks[0].size / totalAskLiquidity : 0;
    
    return (topBidRatio + topAskRatio) / 2;
  }

  // Market maker behavior detection
  private calculateSpreadTightness(orderbook: OrderbookData): number {
    // Use helper function to calculate tightness (0-1 scale)
    // Default max of 1000 bps (10%) for prediction markets
    return calculateTightness(orderbook.spread, 1000);
  }

  private calculateMarketMakerPresence(bids: OrderbookLevel[], asks: OrderbookLevel[]): number {
    // Detect market maker characteristics:
    // - Similar sizes on both sides
    // - Regular price intervals
    // - Consistent presence across levels
    
    if (bids.length < 3 || asks.length < 3) return 0;
    
    let mmScore = 0;
    
    // Check for similar sizes (market makers often quote similar amounts)
    const bidSizes = bids.slice(0, 3).map(b => b.size);
    const askSizes = asks.slice(0, 3).map(a => a.size);
    
    const bidSizeVariance = this.calculateVariance(bidSizes);
    const askSizeVariance = this.calculateVariance(askSizes);
    const avgSize = (bidSizes.concat(askSizes).reduce((a, b) => a + b, 0)) / 6;
    
    // Low variance relative to average size suggests market maker
    if (avgSize > 0) {
      const bidConsistency = 1 - Math.min(1, bidSizeVariance / (avgSize * avgSize));
      const askConsistency = 1 - Math.min(1, askSizeVariance / (avgSize * avgSize));
      mmScore = (bidConsistency + askConsistency) / 2;
    }
    
    return mmScore;
  }

  private calculateOrderSizeDistribution(bids: OrderbookLevel[], asks: OrderbookLevel[]): number {
    // Detect unusual order sizes that might indicate large players
    const allSizes = bids.concat(asks).map(level => level.size);
    if (allSizes.length === 0) return 0;
    
    const avgSize = allSizes.reduce((a, b) => a + b, 0) / allSizes.length;
    const maxSize = Math.max(...allSizes);
    
    // Return ratio of max size to average (higher = more unusual distribution)
    return avgSize > 0 ? maxSize / avgSize : 0;
  }

  // Velocity and acceleration metrics
  private calculateFlowVelocity(marketId: string, currentImbalance: number): number {
    const history = this.flowHistory.get(marketId);
    if (!history || history.length < 2) return 0;
    
    const previousImbalance = history[history.length - 1].bidAskImbalance;
    return currentImbalance - previousImbalance; // Rate of change in imbalance
  }

  private calculatePressureAcceleration(marketId: string, bidPressure: number, askPressure: number): number {
    const history = this.flowHistory.get(marketId);
    if (!history || history.length < 2) return 0;
    
    const prev = history[history.length - 1];
    const currentPressureDiff = bidPressure - askPressure;
    const previousPressureDiff = prev.bidPressure - prev.askPressure;
    
    return currentPressureDiff - previousPressureDiff; // Acceleration in pressure
  }

  // Advanced edge detection algorithms
  private detectIcebergOrders(bids: OrderbookLevel[], asks: OrderbookLevel[], recentTrades?: TickData[]): number {
    // Detect hidden large orders by observing:
    // 1. Consistent replenishment at same price level
    // 2. Large trades without corresponding orderbook impact
    // 3. Unusual resistance at price levels
    
    let icebergScore = 0;
    
    if (recentTrades && recentTrades.length > 0) {
      // Check if recent large trades didn't move the market much
      const largeTrades = recentTrades.filter(trade => trade.size > this.getAverageTradeSize(recentTrades) * 3);
      
      if (largeTrades.length > 0) {
        const priceImpact = this.calculatePriceImpact(largeTrades, bids, asks);
        const expectedImpact = this.getExpectedPriceImpact(largeTrades, bids, asks);
        
        if (expectedImpact > 0 && priceImpact < expectedImpact * 0.5) {
          icebergScore += 0.5; // Large trades with minimal impact suggest hidden liquidity
        }
      }
    }
    
    // Look for unusual order book stability (iceberg orders maintain levels)
    const topLevelStability = this.calculateTopLevelStability(bids, asks);
    icebergScore += topLevelStability * 0.3;
    
    return Math.min(1, icebergScore);
  }

  private calculateWallStrength(bids: OrderbookLevel[], asks: OrderbookLevel[]): number {
    // Detect significant support/resistance levels in orderbook
    if (bids.length === 0 && asks.length === 0) return 0;
    
    let maxWallStrength = 0;
    
    // Check bid side for support walls
    for (let i = 0; i < Math.min(bids.length, 5); i++) {
      const level = bids[i];
      const relativeSizeToTop = bids.length > 0 ? level.size / bids[0].size : 0;
      
      if (relativeSizeToTop > 3) { // Order is 3x larger than top of book
        maxWallStrength = Math.max(maxWallStrength, Math.min(1, relativeSizeToTop / 10));
      }
    }
    
    // Check ask side for resistance walls
    for (let i = 0; i < Math.min(asks.length, 5); i++) {
      const level = asks[i];
      const relativeSizeToTop = asks.length > 0 ? level.size / asks[0].size : 0;
      
      if (relativeSizeToTop > 3) {
        maxWallStrength = Math.max(maxWallStrength, Math.min(1, relativeSizeToTop / 10));
      }
    }
    
    return maxWallStrength;
  }

  private calculateLiquidationRisk(orderbook: OrderbookData, recentTrades?: TickData[]): number {
    // Detect conditions that suggest forced buying/selling
    let liquidationRisk = 0;
    
    // Check for thin orderbook (low liquidity suggests high liquidation risk)
    const totalLiquidity = orderbook.bids.concat(orderbook.asks)
      .reduce((sum, level) => sum + level.size, 0);
    
    if (totalLiquidity < this.getAverageLiquidity(orderbook.marketId)) {
      liquidationRisk += 0.3;
    }
    
    // Check for unusual large trades (could be liquidations)
    if (recentTrades) {
      const avgTradeSize = this.getAverageTradeSize(recentTrades);
      const liquidationTrades = recentTrades.filter(trade => trade.size > avgTradeSize * 5);
      
      if (liquidationTrades.length > 0) {
        liquidationRisk += Math.min(0.5, liquidationTrades.length * 0.1);
      }
    }
    
    // Check for widening spreads (suggests stress)
    const spreadRatio = this.getRelativeSpread(orderbook);
    if (spreadRatio > this.getAverageSpread(orderbook.marketId) * 2) {
      liquidationRisk += 0.2;
    }
    
    return Math.min(1, liquidationRisk);
  }

  // Signal detection based on flow metrics
  private detectFlowSignals(metrics: OrderFlowMetrics): FlowSignal[] {
    const signals: FlowSignal[] = [];
    
    // Aggressive buyer/seller detection
    if (Math.abs(metrics.weightedImbalance) > 0.6) {
      signals.push({
        type: metrics.weightedImbalance > 0 ? 'aggressive_buyer' : 'aggressive_seller',
        severity: Math.abs(metrics.weightedImbalance) > 0.8 ? 'high' : 'medium',
        confidence: Math.abs(metrics.weightedImbalance),
        timeHorizon: 'immediate',
        details: {
          imbalance: metrics.weightedImbalance,
          pressure: metrics.weightedImbalance > 0 ? metrics.bidPressure : metrics.askPressure,
        },
      });
    }
    
    // Iceberg order detection
    if (metrics.icebergProbability > 0.7) {
      signals.push({
        type: 'iceberg_detected',
        severity: 'medium',
        confidence: metrics.icebergProbability,
        timeHorizon: 'short',
        details: {
          probability: metrics.icebergProbability,
          liquidityRatio: metrics.liquidityRatio,
        },
      });
    }
    
    // Wall break detection
    if (metrics.wallStrength > 0.6 && Math.abs(metrics.flowVelocity) > 0.3) {
      signals.push({
        type: 'wall_break',
        severity: 'high',
        confidence: Math.min(metrics.wallStrength, Math.abs(metrics.flowVelocity)),
        timeHorizon: 'short',
        details: {
          wallStrength: metrics.wallStrength,
          velocity: metrics.flowVelocity,
        },
      });
    }
    
    // Liquidity vacuum detection
    if (metrics.liquidityRatio < 0.2 && metrics.marketMakerPresence < 0.3) {
      signals.push({
        type: 'liquidity_vacuum',
        severity: 'critical',
        confidence: 1 - metrics.liquidityRatio,
        timeHorizon: 'immediate',
        details: {
          liquidityRatio: metrics.liquidityRatio,
          mmPresence: metrics.marketMakerPresence,
        },
      });
    }
    
    // Smart money detection (large imbalances with low market maker presence)
    if (Math.abs(metrics.level5Imbalance) > 0.5 && metrics.marketMakerPresence < 0.4 && metrics.orderSizeDistribution > 3) {
      signals.push({
        type: 'smart_money',
        severity: 'high',
        confidence: Math.abs(metrics.level5Imbalance) * (1 - metrics.marketMakerPresence),
        timeHorizon: 'medium',
        details: {
          deepImbalance: metrics.level5Imbalance,
          orderSizeDistrib: metrics.orderSizeDistribution,
          mmPresence: metrics.marketMakerPresence,
        },
      });
    }
    
    // Stop hunt detection (rapid pressure acceleration with liquidation risk)
    if (Math.abs(metrics.pressureAcceleration) > 0.4 && metrics.liquidationRisk > 0.6) {
      signals.push({
        type: 'stop_hunt',
        severity: 'high',
        confidence: Math.min(Math.abs(metrics.pressureAcceleration), metrics.liquidationRisk),
        timeHorizon: 'immediate',
        details: {
          acceleration: metrics.pressureAcceleration,
          liquidationRisk: metrics.liquidationRisk,
        },
      });
    }
    
    return signals;
  }

  // Helper methods
  private calculateVariance(numbers: number[]): number {
    if (numbers.length === 0) return 0;
    const mean = numbers.reduce((a, b) => a + b, 0) / numbers.length;
    const variance = numbers.reduce((sum, num) => sum + Math.pow(num - mean, 2), 0) / numbers.length;
    return variance;
  }

  private getAverageTradeSize(trades: TickData[]): number {
    if (trades.length === 0) return 0;
    return trades.reduce((sum, trade) => sum + trade.size, 0) / trades.length;
  }

  private calculatePriceImpact(largeTrades: TickData[], bids: OrderbookLevel[], asks: OrderbookLevel[]): number {
    // Calculate actual price movement from large trades
    // For prediction markets, use absolute probability change (not percentage)
    // since prices are probabilities (0-1), not unbounded prices
    if (largeTrades.length === 0) return 0;

    const firstTrade = largeTrades[0];
    const lastTrade = largeTrades[largeTrades.length - 1];

    // Return absolute probability change (e.g., 0.05 = 5 percentage points)
    return Math.abs(lastTrade.price - firstTrade.price);
  }

  private getExpectedPriceImpact(largeTrades: TickData[], bids: OrderbookLevel[], asks: OrderbookLevel[]): number {
    // Calculate expected price impact based on orderbook depth
    const totalTradeSize = largeTrades.reduce((sum, trade) => sum + trade.size, 0);
    
    // Simplified: assume impact proportional to trade size vs top level size
    const topLevelSize = bids.length > 0 && asks.length > 0 ? 
      Math.min(bids[0].size, asks[0].size) : 0;
    
    return topLevelSize > 0 ? totalTradeSize / topLevelSize * 0.01 : 0; // Rough approximation
  }

  private calculateTopLevelStability(bids: OrderbookLevel[], asks: OrderbookLevel[]): number {
    // This would need historical data to measure how stable top levels are
    // For now, return a placeholder
    return 0.2;
  }

  // Data management
  private storeMetrics(metrics: OrderFlowMetrics): void {
    if (!this.flowHistory.has(metrics.marketId)) {
      this.flowHistory.set(metrics.marketId, []);
    }
    
    const history = this.flowHistory.get(metrics.marketId)!;
    history.push(metrics);
    
    // Keep only recent history
    if (history.length > this.HISTORY_LENGTH) {
      history.shift();
    }
  }

  private storeRecentTrades(marketId: string, trades: TickData[]): void {
    if (!this.recentTrades.has(marketId)) {
      this.recentTrades.set(marketId, []);
    }
    
    const recentTrades = this.recentTrades.get(marketId)!;
    recentTrades.push(...trades);
    
    // Keep only trades within time window
    const cutoff = Date.now() - this.TRADE_WINDOW_MS;
    this.recentTrades.set(marketId, recentTrades.filter(trade => trade.timestamp > cutoff));
  }

  // Baseline calculations (would need more sophisticated implementations)
  private getAverageLiquidity(marketId: string): number {
    // Calculate average liquidity for this market over time
    const history = this.flowHistory.get(marketId);
    if (!history || history.length === 0) return 1000; // Default assumption
    
    return history.reduce((sum, metrics) => sum + metrics.liquidityRatio, 0) / history.length;
  }

  private getAverageSpread(marketId: string): number {
    const history = this.flowHistory.get(marketId);
    if (!history || history.length === 0) return 0.01; // Default 1% spread
    
    return history.reduce((sum, metrics) => sum + (1 - metrics.spreadTightness), 0) / history.length;
  }

  private getRelativeSpread(orderbook: OrderbookData): number {
    // For prediction markets, spread is already absolute (not relative to price)
    // Return spread directly - helper functions available if conversion needed
    return orderbook.spread;
  }

  // Cleanup methods
  clearMarketData(marketId: string): void {
    this.flowHistory.delete(marketId);
    this.orderbookSnapshots.delete(marketId);
    this.recentTrades.delete(marketId);
  }

  dispose(): void {
    this.flowHistory.clear();
    this.orderbookSnapshots.clear();
    this.recentTrades.clear();
  }
}