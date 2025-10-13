import { OrderbookData, OrderbookLevel, OrderbookMetrics, MicrostructureSignal, BotConfig } from '../types';
import { OrderbookBuffer } from '../utils/RingBuffer';
import { logger } from '../utils/logger';

export class OrderbookAnalyzer {
  private config: BotConfig;
  private orderbookBuffers: Map<string, OrderbookBuffer> = new Map();

  constructor(config: BotConfig) {
    this.config = config;
  }

  analyzeOrderbook(orderbook: OrderbookData): OrderbookMetrics {
    // Store orderbook for historical analysis
    this.storeOrderbook(orderbook);

    // Calculate basic metrics
    const totalBidVolume = this.calculateTotalVolume(orderbook.bids);
    const totalAskVolume = this.calculateTotalVolume(orderbook.asks);
    const bidAskRatio = totalAskVolume > 0 ? totalBidVolume / totalAskVolume : 0;
    const spreadPercent = orderbook.bestAsk > 0 ? (orderbook.spread / orderbook.bestAsk) * 100 : 0;
    
    // Calculate depth imbalance (weighted by price levels)
    const depthImbalance = this.calculateDepthImbalance(orderbook.bids, orderbook.asks);
    
    // Calculate liquidity score
    const liquidityScore = this.calculateLiquidityScore(orderbook);

    return {
      marketId: orderbook.marketId,
      timestamp: orderbook.timestamp,
      bidAskRatio,
      spreadPercent,
      totalBidVolume,
      totalAskVolume,
      depthImbalance,
      liquidityScore,
    };
  }

  detectOrderbookSignals(orderbook: OrderbookData): MicrostructureSignal[] {
    const signals: MicrostructureSignal[] = [];
    const metrics = this.analyzeOrderbook(orderbook);
    const buffer = this.orderbookBuffers.get(orderbook.marketId);
    
    if (!buffer || buffer.length() < 10) {
      return signals; // Need historical data for comparison
    }

    // Get historical baseline
    const historical = buffer.getOrderbooksInWindow(5 * 60 * 1000); // 5 minutes
    if (historical.length < 5) return signals;

    // Check for orderbook imbalance
    const imbalanceSignal = this.detectOrderbookImbalance(metrics, historical);
    if (imbalanceSignal) signals.push(imbalanceSignal);

    // Check for spread anomalies
    const spreadSignal = this.detectSpreadAnomaly(orderbook, buffer);
    if (spreadSignal) signals.push(spreadSignal);

    // Check for market maker withdrawal
    const withdrawalSignal = this.detectMarketMakerWithdrawal(orderbook, historical);
    if (withdrawalSignal) signals.push(withdrawalSignal);

    // Check for liquidity shifts
    const liquiditySignal = this.detectLiquidityShift(metrics, historical);
    if (liquiditySignal) signals.push(liquiditySignal);

    return signals;
  }

  private storeOrderbook(orderbook: OrderbookData): void {
    if (!this.orderbookBuffers.has(orderbook.marketId)) {
      this.orderbookBuffers.set(orderbook.marketId, new OrderbookBuffer(this.config.microstructure.tickBufferSize));
    }
    
    this.orderbookBuffers.get(orderbook.marketId)!.push(orderbook);
  }

  private calculateTotalVolume(levels: OrderbookLevel[]): number {
    return levels.reduce((total, level) => total + level.volume, 0);
  }

  private calculateDepthImbalance(bids: OrderbookLevel[], asks: OrderbookLevel[]): number {
    if (bids.length === 0 || asks.length === 0) return 0;

    // Calculate weighted depth (closer to best price = higher weight)
    const bidDepth = this.calculateWeightedDepth(bids, true);
    const askDepth = this.calculateWeightedDepth(asks, false);
    
    const totalDepth = bidDepth + askDepth;
    return totalDepth > 0 ? (bidDepth - askDepth) / totalDepth : 0;
  }

  private calculateWeightedDepth(levels: OrderbookLevel[], isBid: boolean): number {
    if (levels.length === 0) return 0;

    const bestPrice = levels[0].price;
    let weightedDepth = 0;

    levels.forEach((level, index) => {
      // Weight decreases with distance from best price
      const weight = 1 / (index + 1);
      weightedDepth += level.volume * weight;
    });

    return weightedDepth;
  }

  private calculateLiquidityScore(orderbook: OrderbookData): number {
    const totalVolume = this.calculateTotalVolume(orderbook.bids) + this.calculateTotalVolume(orderbook.asks);
    const depth = Math.min(orderbook.bids.length, orderbook.asks.length);
    const spreadPenalty = orderbook.bestAsk > 0 ? (orderbook.spread / orderbook.bestAsk) * 100 : 0;

    // Score based on volume, depth, and tight spread
    let score = Math.min(100, (totalVolume / 1000) + (depth * 2));
    score = Math.max(0, score - (spreadPenalty * 10)); // Penalize wide spreads

    return score;
  }

  private detectOrderbookImbalance(
    current: OrderbookMetrics,
    historical: OrderbookData[]
  ): MicrostructureSignal | null {
    const avgBidAskRatio = historical
      .map(ob => {
        const bidVol = this.calculateTotalVolume(ob.bids);
        const askVol = this.calculateTotalVolume(ob.asks);
        return askVol > 0 ? bidVol / askVol : 0;
      })
      .reduce((sum, ratio) => sum + ratio, 0) / historical.length;

    const imbalanceChange = Math.abs(current.bidAskRatio - avgBidAskRatio);
    const threshold = this.config.microstructure.orderbookImbalanceThreshold;

    if (imbalanceChange > threshold) {
      const severity = imbalanceChange > threshold * 2 ? 'critical' :
                      imbalanceChange > threshold * 1.5 ? 'high' : 'medium';

      return {
        type: 'orderbook_imbalance',
        marketId: current.marketId,
        timestamp: current.timestamp,
        confidence: Math.min(0.95, imbalanceChange / threshold),
        severity,
        data: {
          current: current.bidAskRatio,
          baseline: avgBidAskRatio,
          change: imbalanceChange,
          context: {
            bidVolume: current.totalBidVolume,
            askVolume: current.totalAskVolume,
          },
        },
      };
    }

    return null;
  }

  private detectSpreadAnomaly(
    orderbook: OrderbookData,
    buffer: OrderbookBuffer
  ): MicrostructureSignal | null {
    const avgSpread = buffer.getAverageSpread(5 * 60 * 1000); // 5 minutes
    const spreadVolatility = buffer.getSpreadVolatility(5 * 60 * 1000);
    
    if (avgSpread === 0) return null;

    const spreadChange = Math.abs(orderbook.spread - avgSpread);
    const normalizedChange = spreadVolatility > 0 ? spreadChange / spreadVolatility : 0;
    const threshold = this.config.microstructure.spreadAnomalyThreshold;

    if (normalizedChange > threshold) {
      const severity = normalizedChange > threshold * 2 ? 'critical' :
                      normalizedChange > threshold * 1.5 ? 'high' : 'medium';

      return {
        type: 'spread_anomaly',
        marketId: orderbook.marketId,
        timestamp: orderbook.timestamp,
        confidence: Math.min(0.95, normalizedChange / threshold),
        severity,
        data: {
          current: orderbook.spread,
          baseline: avgSpread,
          change: spreadChange,
          context: {
            spreadPercent: (orderbook.spread / orderbook.bestAsk) * 100,
            volatility: spreadVolatility,
          },
        },
      };
    }

    return null;
  }

  private detectMarketMakerWithdrawal(
    orderbook: OrderbookData,
    historical: OrderbookData[]
  ): MicrostructureSignal | null {
    const avgDepth = historical.reduce((sum, ob) => {
      return sum + Math.min(ob.bids.length, ob.asks.length);
    }, 0) / historical.length;

    const currentDepth = Math.min(orderbook.bids.length, orderbook.asks.length);
    const depthReduction = (avgDepth - currentDepth) / avgDepth;

    // Also check for volume reduction
    const avgVolume = historical.reduce((sum, ob) => {
      return sum + this.calculateTotalVolume(ob.bids) + this.calculateTotalVolume(ob.asks);
    }, 0) / historical.length;

    const currentVolume = this.calculateTotalVolume(orderbook.bids) + this.calculateTotalVolume(orderbook.asks);
    const volumeReduction = avgVolume > 0 ? (avgVolume - currentVolume) / avgVolume : 0;

    // Market maker withdrawal if both depth and volume decrease significantly
    if (depthReduction > 0.3 && volumeReduction > 0.3) {
      const combinedReduction = (depthReduction + volumeReduction) / 2;
      const severity = combinedReduction > 0.7 ? 'critical' :
                      combinedReduction > 0.5 ? 'high' : 'medium';

      return {
        type: 'market_maker_withdrawal',
        marketId: orderbook.marketId,
        timestamp: orderbook.timestamp,
        confidence: Math.min(0.9, combinedReduction),
        severity,
        data: {
          current: currentDepth,
          baseline: avgDepth,
          change: depthReduction,
          context: {
            volumeReduction,
            currentVolume,
            avgVolume,
          },
        },
      };
    }

    return null;
  }

  private detectLiquidityShift(
    current: OrderbookMetrics,
    historical: OrderbookData[]
  ): MicrostructureSignal | null {
    const avgLiquidity = historical.reduce((sum, ob) => {
      const liquidity = this.calculateLiquidityScore(ob);
      return sum + liquidity;
    }, 0) / historical.length;

    const liquidityChange = Math.abs(current.liquidityScore - avgLiquidity);
    const threshold = this.config.microstructure.liquidityShiftThreshold;

    if (liquidityChange > threshold) {
      const severity = liquidityChange > threshold * 2 ? 'critical' :
                      liquidityChange > threshold * 1.5 ? 'high' : 'medium';

      return {
        type: 'liquidity_shift',
        marketId: current.marketId,
        timestamp: current.timestamp,
        confidence: Math.min(0.9, liquidityChange / threshold),
        severity,
        data: {
          current: current.liquidityScore,
          baseline: avgLiquidity,
          change: liquidityChange,
          context: {
            direction: current.liquidityScore > avgLiquidity ? 'increase' : 'decrease',
          },
        },
      };
    }

    return null;
  }

  // Utility method to get orderbook metrics for a market
  getMarketMetrics(marketId: string): OrderbookMetrics | null {
    const buffer = this.orderbookBuffers.get(marketId);
    if (!buffer || buffer.isEmpty()) return null;

    const latest = buffer.getLatest();
    return latest ? this.analyzeOrderbook(latest) : null;
  }

  // Cleanup methods to prevent memory leaks
  clearMarketData(marketId: string): void {
    const buffer = this.orderbookBuffers.get(marketId);
    if (buffer) {
      buffer.dispose();
      this.orderbookBuffers.delete(marketId);
    }
  }

  clearAllData(): void {
    for (const [marketId, buffer] of this.orderbookBuffers) {
      buffer.dispose();
    }
    this.orderbookBuffers.clear();
  }

  dispose(): void {
    this.clearAllData();
  }

  // Utility method to clean up old market data
  cleanupStaleMarkets(maxAgeMs: number = 24 * 60 * 60 * 1000): void {
    const now = Date.now();
    const marketsToRemove: string[] = [];

    // Age-based cleanup
    for (const [marketId, buffer] of this.orderbookBuffers) {
      const latest = buffer.getLatest();
      if (!latest || (now - latest.timestamp) > maxAgeMs) {
        marketsToRemove.push(marketId);
      }
    }

    for (const marketId of marketsToRemove) {
      this.clearMarketData(marketId);
      logger.debug(`Cleaned up stale orderbook data for ${marketId}`);
    }

    // Size-based cleanup - if we have too many markets, remove oldest ones
    const maxMarkets = 500; // Same limit as TechnicalIndicators
    if (this.orderbookBuffers.size > maxMarkets) {
      const sortedMarkets = Array.from(this.orderbookBuffers.entries())
        .map(([marketId, buffer]) => ({
          marketId,
          lastUpdate: buffer.getLatest()?.timestamp || 0
        }))
        .sort((a, b) => a.lastUpdate - b.lastUpdate); // Oldest first

      const marketsToRemoveCount = this.orderbookBuffers.size - maxMarkets;
      for (let i = 0; i < marketsToRemoveCount; i++) {
        this.clearMarketData(sortedMarkets[i].marketId);
        logger.debug(`Removed orderbook market ${sortedMarkets[i].marketId} due to size limit`);
      }
    }
  }
}