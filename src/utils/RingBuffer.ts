import { TickData, OrderbookData } from '../types';

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