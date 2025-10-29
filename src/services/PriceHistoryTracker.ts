import { PriceRingBuffer } from '../utils/RingBuffer';
import { PricePoint, Market } from '../types';
import { advancedLogger as logger } from '../utils/Logger';

/**
 * Tracks historical price data for markets with bounded memory
 * Used for cross-market correlation detection and price trend analysis
 *
 * Memory management:
 * - Each market stores up to 1000 price points (configurable)
 * - At 30-second intervals, this represents ~8.3 hours of history
 * - With 500 markets: ~500KB of memory (very efficient)
 * - LRU eviction for inactive markets
 */
export class PriceHistoryTracker {
  private priceBuffers: Map<string, PriceRingBuffer>;
  private maxMarketsTracked: number;
  private bufferSize: number;
  private minUpdateIntervalMs: number;
  private lastUpdateTime: Map<string, number>;

  constructor(options: {
    maxMarketsTracked?: number;
    bufferSize?: number;
    minUpdateIntervalMs?: number;
  } = {}) {
    this.priceBuffers = new Map();
    this.lastUpdateTime = new Map();
    this.maxMarketsTracked = options.maxMarketsTracked || 500;
    this.bufferSize = options.bufferSize || 1000;
    this.minUpdateIntervalMs = options.minUpdateIntervalMs || 30000; // 30 seconds default
  }

  /**
   * Record a price update for a market
   * Implements rate limiting to avoid storing too many updates
   */
  recordPriceUpdate(marketId: string, price: number, volume: number, spread?: number): void {
    const now = Date.now();

    // Rate limit updates - don't store updates more frequently than minUpdateIntervalMs
    const lastUpdate = this.lastUpdateTime.get(marketId);
    if (lastUpdate && (now - lastUpdate) < this.minUpdateIntervalMs) {
      return; // Skip this update, too soon
    }

    // Get or create price buffer for this market
    let buffer = this.priceBuffers.get(marketId);
    if (!buffer) {
      // Check if we need to evict old markets (LRU policy)
      if (this.priceBuffers.size >= this.maxMarketsTracked) {
        this.evictOldestMarket();
      }

      buffer = new PriceRingBuffer(this.bufferSize);
      this.priceBuffers.set(marketId, buffer);

      logger.debug(`Created price history buffer for market ${marketId.substring(0, 8)}...`);
    }

    // Add price point
    const pricePoint: PricePoint = {
      timestamp: now,
      price,
      volume,
      spread
    };

    buffer.push(pricePoint);
    this.lastUpdateTime.set(marketId, now);
  }

  /**
   * Record price update from Market object
   */
  recordMarketUpdate(market: Market): void {
    // Extract current price from outcomePrices (use first outcome as representative)
    const price = market.outcomePrices && market.outcomePrices.length > 0
      ? parseFloat(market.outcomePrices[0])
      : 0.5; // Default to 0.5 if no price available

    if (price > 0) {
      this.recordPriceUpdate(
        market.id,
        price,
        market.volumeNum || 0,
        market.spread
      );
    }
  }

  /**
   * Get price history for a market
   */
  getPriceHistory(marketId: string, windowMs?: number): PricePoint[] {
    const buffer = this.priceBuffers.get(marketId);
    if (!buffer) return [];

    return windowMs ? buffer.getPricesInWindow(windowMs) : buffer.getAll();
  }

  /**
   * Get price buffer for direct access (for correlation calculations)
   */
  getPriceBuffer(marketId: string): PriceRingBuffer | undefined {
    return this.priceBuffers.get(marketId);
  }

  /**
   * Calculate price change percentage over a time window
   */
  calculatePriceChange(marketId: string, windowMs: number): number {
    const buffer = this.priceBuffers.get(marketId);
    if (!buffer) return 0;

    return buffer.calculatePriceChange(windowMs);
  }

  /**
   * Calculate price volatility over a time window
   */
  calculateVolatility(marketId: string, windowMs?: number): number {
    const buffer = this.priceBuffers.get(marketId);
    if (!buffer) return 0;

    return buffer.getPriceVolatility(windowMs);
  }

  /**
   * Calculate correlation between two markets
   * Returns Pearson correlation coefficient (-1 to 1)
   */
  calculateCorrelation(marketId1: string, marketId2: string, windowMs: number): number {
    const buffer1 = this.priceBuffers.get(marketId1);
    const buffer2 = this.priceBuffers.get(marketId2);

    if (!buffer1 || !buffer2) return 0;

    return buffer1.calculateCorrelation(buffer2, windowMs);
  }

  /**
   * Get all markets with price history
   */
  getTrackedMarkets(): string[] {
    return Array.from(this.priceBuffers.keys());
  }

  /**
   * Check if market has sufficient price history for analysis
   */
  hasSufficientHistory(marketId: string, minPoints: number = 10): boolean {
    const buffer = this.priceBuffers.get(marketId);
    if (!buffer) return false;

    return buffer.length() >= minPoints;
  }

  /**
   * Get memory usage statistics
   */
  getMemoryStats(): {
    marketsTracked: number;
    totalPricePoints: number;
    estimatedMemoryMB: number;
  } {
    let totalPoints = 0;
    for (const buffer of this.priceBuffers.values()) {
      totalPoints += buffer.length();
    }

    // Rough estimate: each price point ~50 bytes (timestamp + price + volume + spread + overhead)
    const estimatedMemoryMB = (totalPoints * 50) / (1024 * 1024);

    return {
      marketsTracked: this.priceBuffers.size,
      totalPricePoints: totalPoints,
      estimatedMemoryMB: Math.round(estimatedMemoryMB * 100) / 100
    };
  }

  /**
   * Evict oldest market (LRU policy)
   */
  private evictOldestMarket(): void {
    let oldestMarketId: string | null = null;
    let oldestTime = Infinity;

    for (const [marketId, lastUpdate] of this.lastUpdateTime.entries()) {
      if (lastUpdate < oldestTime) {
        oldestTime = lastUpdate;
        oldestMarketId = marketId;
      }
    }

    if (oldestMarketId) {
      const buffer = this.priceBuffers.get(oldestMarketId);
      if (buffer) {
        buffer.dispose(); // Clean up memory
      }
      this.priceBuffers.delete(oldestMarketId);
      this.lastUpdateTime.delete(oldestMarketId);

      logger.debug(`Evicted price history for market ${oldestMarketId.substring(0, 8)}... (LRU policy)`);
    }
  }

  /**
   * Clear price history for a specific market
   */
  clearMarket(marketId: string): void {
    const buffer = this.priceBuffers.get(marketId);
    if (buffer) {
      buffer.dispose();
      this.priceBuffers.delete(marketId);
      this.lastUpdateTime.delete(marketId);
    }
  }

  /**
   * Clear all price history (use sparingly)
   */
  clearAll(): void {
    for (const buffer of this.priceBuffers.values()) {
      buffer.dispose();
    }
    this.priceBuffers.clear();
    this.lastUpdateTime.clear();

    logger.info('Cleared all price history');
  }

  /**
   * Remove markets that haven't been updated recently (cleanup)
   */
  cleanupStaleMarkets(maxAgeMs: number = 86400000): number {
    const now = Date.now();
    const staleMarkets: string[] = [];

    for (const [marketId, lastUpdate] of this.lastUpdateTime.entries()) {
      if (now - lastUpdate > maxAgeMs) {
        staleMarkets.push(marketId);
      }
    }

    for (const marketId of staleMarkets) {
      this.clearMarket(marketId);
    }

    if (staleMarkets.length > 0) {
      logger.info(`Cleaned up ${staleMarkets.length} stale market price histories (older than ${maxAgeMs / 3600000}h)`);
    }

    return staleMarkets.length;
  }

  /**
   * Get current price for a market (most recent price point)
   */
  getCurrentPrice(marketId: string): number | null {
    const buffer = this.priceBuffers.get(marketId);
    if (!buffer) return null;

    const latest = buffer.getLatest();
    return latest ? latest.price : null;
  }

  /**
   * Get price at specific time (or closest before it)
   */
  getPriceAtTime(marketId: string, timestamp: number): number | null {
    const buffer = this.priceBuffers.get(marketId);
    if (!buffer) return null;

    const pricePoint = buffer.getPriceAtTime(timestamp);
    return pricePoint ? pricePoint.price : null;
  }

  /**
   * Calculate average price over time window
   */
  getAveragePrice(marketId: string, windowMs?: number): number {
    const buffer = this.priceBuffers.get(marketId);
    if (!buffer) return 0;

    return buffer.getAveragePrice(windowMs);
  }

  /**
   * Dispose and clean up resources
   */
  dispose(): void {
    this.clearAll();
    logger.info('PriceHistoryTracker disposed');
  }
}
