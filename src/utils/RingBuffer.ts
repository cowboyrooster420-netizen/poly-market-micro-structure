import { TickData, OrderbookData, PricePoint } from '../types';

export class RingBuffer<T> {
  private buffer: T[];
  private size: number;
  private head: number = 0;
  private tail: number = 0;
  private count: number = 0;

  constructor(size: number) {
    this.size = size;
    this.buffer = new Array(size);
  }

  push(item: T): void {
    // If buffer is full, we're about to overwrite an item - clear the old reference first
    if (this.count === this.size) {
      // Clear the reference that's about to be overwritten
      this.buffer[this.tail] = undefined as any;
      // Move head since we're overwriting the oldest item
      this.head = (this.head + 1) % this.size;
    } else {
      // Buffer not full yet, increment count
      this.count++;
    }
    
    // Add the new item
    this.buffer[this.tail] = item;
    this.tail = (this.tail + 1) % this.size;
  }

  getAll(): T[] {
    if (this.count === 0) return [];

    const result: T[] = [];
    for (let i = 0; i < this.count; i++) {
      const index = (this.head + i) % this.size;
      result.push(this.buffer[index]);
    }
    return result;
  }

  getLast(n: number): T[] {
    if (n <= 0 || this.count === 0) return [];
    
    const actualN = Math.min(n, this.count);
    const result: T[] = [];
    
    for (let i = 0; i < actualN; i++) {
      const index = (this.tail - 1 - i + this.size) % this.size;
      result.unshift(this.buffer[index]);
    }
    
    return result;
  }

  getLatest(): T | null {
    if (this.count === 0) return null;
    const index = (this.tail - 1 + this.size) % this.size;
    return this.buffer[index];
  }

  isEmpty(): boolean {
    return this.count === 0;
  }

  isFull(): boolean {
    return this.count === this.size;
  }

  length(): number {
    return this.count;
  }

  clear(): void {
    // Clear all references to prevent memory leaks
    for (let i = 0; i < this.size; i++) {
      this.buffer[i] = undefined as any;
    }
    this.head = 0;
    this.tail = 0;
    this.count = 0;
  }

  dispose(): void {
    this.clear();
    this.buffer.length = 0; // Clear the array properly
    this.buffer = undefined as any;
  }

  /**
   * Trim buffer to specified size (for aggressive memory cleanup)
   * Keeps the most recent items
   */
  trimToSize(newSize: number): void {
    if (newSize >= this.count) return; // Nothing to trim

    // Keep only the last newSize items
    const itemsToKeep = this.getLast(newSize);

    // Clear and recreate buffer
    this.clear();
    for (const item of itemsToKeep) {
      this.push(item);
    }
  }

  // Get items within a time window (for time-series data)
  getWithinTimeWindow(windowMs: number, timestampExtractor: (item: T) => number): T[] {
    if (this.count === 0) return [];

    const now = Date.now();
    const cutoff = now - windowMs;
    const result: T[] = [];

    for (let i = 0; i < this.count; i++) {
      const index = (this.head + i) % this.size;
      const item = this.buffer[index];
      if (timestampExtractor(item) >= cutoff) {
        result.push(item);
      }
    }

    return result;
  }
}

export class TickBuffer extends RingBuffer<TickData> {
  constructor(size: number = 10000) {
    super(size);
  }

  dispose(): void {
    super.dispose();
  }

  getTicksInWindow(windowMs: number): TickData[] {
    return this.getWithinTimeWindow(windowMs, (tick) => tick.timestamp);
  }

  getRecentTicks(count: number): TickData[] {
    return this.getLast(count);
  }

  calculateVWAP(windowMs?: number): number {
    const ticks = windowMs ? this.getTicksInWindow(windowMs) : this.getAll();
    if (ticks.length === 0) return 0;

    let totalValue = 0;
    let totalVolume = 0;

    for (const tick of ticks) {
      // Use tick.size (individual trade size) not tick.volume (cumulative volume)
      if (tick.size > 0) { // Add validation to prevent bad data
        totalValue += tick.price * tick.size;
        totalVolume += tick.size;
      }
    }

    return totalVolume > 0 ? totalValue / totalVolume : 0;
  }

  calculateMomentum(periods: number = 10): number {
    const recent = this.getLast(periods + 1);
    if (recent.length < periods + 1) return 0;

    const current = recent[recent.length - 1].price;
    const previous = recent[recent.length - 1 - periods].price;
    
    return previous > 0 ? ((current - previous) / previous) * 100 : 0;
  }
}

export class OrderbookBuffer extends RingBuffer<OrderbookData> {
  constructor(size: number = 1000) {
    super(size);
  }

  dispose(): void {
    super.dispose();
  }

  getOrderbooksInWindow(windowMs: number): OrderbookData[] {
    return this.getWithinTimeWindow(windowMs, (ob) => ob.timestamp);
  }

  getAverageSpread(windowMs?: number): number {
    const orderbooks = windowMs ? this.getOrderbooksInWindow(windowMs) : this.getAll();
    if (orderbooks.length === 0) return 0;

    const totalSpread = orderbooks.reduce((sum, ob) => sum + ob.spread, 0);
    return totalSpread / orderbooks.length;
  }

  getSpreadVolatility(windowMs?: number): number {
    const orderbooks = windowMs ? this.getOrderbooksInWindow(windowMs) : this.getAll();
    if (orderbooks.length < 2) return 0;

    const spreads = orderbooks.map(ob => ob.spread);
    const avg = spreads.reduce((sum, spread) => sum + spread, 0) / spreads.length;
    const variance = spreads.reduce((sum, spread) => sum + Math.pow(spread - avg, 2), 0) / spreads.length;

    return Math.sqrt(variance);
  }
}

/**
 * Circular buffer for storing historical price data with bounded memory
 * Used for cross-market correlation detection and price trend analysis
 */
export class PriceRingBuffer extends RingBuffer<PricePoint> {
  constructor(size: number = 1000) {
    super(size);
  }

  dispose(): void {
    super.dispose();
  }

  /**
   * Get price points within a time window
   */
  getPricesInWindow(windowMs: number): PricePoint[] {
    return this.getWithinTimeWindow(windowMs, (point) => point.timestamp);
  }

  /**
   * Get recent N price points
   */
  getRecentPrices(count: number): PricePoint[] {
    return this.getLast(count);
  }

  /**
   * Calculate price change percentage over a time window
   * Returns percentage change from oldest to newest price in window
   */
  calculatePriceChange(windowMs: number): number {
    const prices = this.getPricesInWindow(windowMs);
    if (prices.length < 2) return 0;

    const oldestPrice = prices[0].price;
    const newestPrice = prices[prices.length - 1].price;

    return oldestPrice > 0 ? ((newestPrice - oldestPrice) / oldestPrice) * 100 : 0;
  }

  /**
   * Calculate average price over a time window
   */
  getAveragePrice(windowMs?: number): number {
    const prices = windowMs ? this.getPricesInWindow(windowMs) : this.getAll();
    if (prices.length === 0) return 0;

    const sum = prices.reduce((acc, point) => acc + point.price, 0);
    return sum / prices.length;
  }

  /**
   * Calculate price volatility (standard deviation) over a time window
   */
  getPriceVolatility(windowMs?: number): number {
    const prices = windowMs ? this.getPricesInWindow(windowMs) : this.getAll();
    if (prices.length < 2) return 0;

    const avg = this.getAveragePrice(windowMs);
    const variance = prices.reduce((sum, point) => {
      return sum + Math.pow(point.price - avg, 2);
    }, 0) / prices.length;

    return Math.sqrt(variance);
  }

  /**
   * Get price at specific timestamp (or closest before it)
   */
  getPriceAtTime(timestamp: number): PricePoint | null {
    const all = this.getAll();
    if (all.length === 0) return null;

    // Find closest price point at or before timestamp
    let closest: PricePoint | null = null;
    let minDiff = Infinity;

    for (const point of all) {
      if (point.timestamp <= timestamp) {
        const diff = timestamp - point.timestamp;
        if (diff < minDiff) {
          minDiff = diff;
          closest = point;
        }
      }
    }

    return closest;
  }

  /**
   * Calculate rolling correlation with another price buffer
   * Returns Pearson correlation coefficient (-1 to 1)
   */
  calculateCorrelation(other: PriceRingBuffer, windowMs: number): number {
    const thisPrices = this.getPricesInWindow(windowMs);
    const otherPrices = other.getPricesInWindow(windowMs);

    if (thisPrices.length < 2 || otherPrices.length < 2) {
      return 0;
    }

    // Align timestamps - match up closest prices
    const pairs: Array<{ x: number; y: number }> = [];

    for (const thisPoint of thisPrices) {
      const otherPoint = other.getPriceAtTime(thisPoint.timestamp);
      if (otherPoint) {
        // Calculate returns instead of absolute prices for better correlation
        const thisReturn = thisPoint.price;
        const otherReturn = otherPoint.price;
        pairs.push({ x: thisReturn, y: otherReturn });
      }
    }

    if (pairs.length < 2) return 0;

    // Calculate Pearson correlation
    const n = pairs.length;
    const sumX = pairs.reduce((sum, p) => sum + p.x, 0);
    const sumY = pairs.reduce((sum, p) => sum + p.y, 0);
    const sumXY = pairs.reduce((sum, p) => sum + p.x * p.y, 0);
    const sumX2 = pairs.reduce((sum, p) => sum + p.x * p.x, 0);
    const sumY2 = pairs.reduce((sum, p) => sum + p.y * p.y, 0);

    const numerator = (n * sumXY) - (sumX * sumY);
    const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

    if (denominator === 0) return 0;

    return numerator / denominator;
  }

  /**
   * Calculate price returns (percentage changes between consecutive points)
   */
  calculateReturns(windowMs?: number): number[] {
    const prices = windowMs ? this.getPricesInWindow(windowMs) : this.getAll();
    if (prices.length < 2) return [];

    const returns: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      const prevPrice = prices[i - 1].price;
      const currPrice = prices[i].price;
      if (prevPrice > 0) {
        returns.push(((currPrice - prevPrice) / prevPrice) * 100);
      }
    }

    return returns;
  }
}