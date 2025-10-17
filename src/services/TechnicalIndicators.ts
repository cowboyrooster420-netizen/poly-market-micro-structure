import { TickData, TechnicalIndicators, MicrostructureSignal, BotConfig } from '../types';
import { TickBuffer } from '../utils/RingBuffer';
import { logger } from '../utils/logger';

export class TechnicalIndicatorCalculator {
  private config: BotConfig;
  private tickBuffers: Map<string, TickBuffer> = new Map();
  private macdHistory: Map<string, number[]> = new Map(); // Store MACD line history for signal calculation
  
  // RSI Wilder's smoothing storage
  private rsiAvgGain: Map<string, number> = new Map();
  private rsiAvgLoss: Map<string, number> = new Map();
  private rsiInitialized: Map<string, boolean> = new Map();
  
  // MACD signal line EMA storage (to prevent lookahead bias)
  private macdSignalEMA: Map<string, number> = new Map();
  private macdSignalInitialized: Map<string, boolean> = new Map();

  constructor(config: BotConfig) {
    this.config = config;
  }

  calculateIndicators(marketId: string, tick: TickData): TechnicalIndicators | null {
    // Store tick data
    this.storeTick(tick);
    
    const buffer = this.tickBuffers.get(marketId);
    if (!buffer || buffer.length() < 50) {
      return null; // Need sufficient data for indicators
    }

    const recentTicks = buffer.getAll();
    const prices = recentTicks.map(t => t.price);
    
    return {
      marketId,
      timestamp: tick.timestamp,
      rsi: this.calculateRSI(prices, marketId),
      macd: this.calculateMACD(prices, marketId),
      momentum: this.calculateMomentum(prices),
      vwap: buffer.calculateVWAP(60 * 60 * 1000), // 1 hour VWAP
      priceDeviation: this.calculatePriceDeviation(tick.price, buffer),
    };
  }

  detectMomentumSignals(indicators: TechnicalIndicators): MicrostructureSignal[] {
    const signals: MicrostructureSignal[] = [];

    // RSI oversold/overbought with momentum
    const rsiSignal = this.detectRSISignal(indicators);
    if (rsiSignal) signals.push(rsiSignal);

    // MACD crossover
    const macdSignal = this.detectMACDSignal(indicators);
    if (macdSignal) signals.push(macdSignal);

    // Momentum breakout
    const momentumSignal = this.detectMomentumBreakout(indicators);
    if (momentumSignal) signals.push(momentumSignal);

    // VWAP deviation
    const vwapSignal = this.detectVWAPDeviation(indicators);
    if (vwapSignal) signals.push(vwapSignal);

    return signals;
  }

  private storeTick(tick: TickData): void {
    if (!this.tickBuffers.has(tick.marketId)) {
      this.tickBuffers.set(tick.marketId, new TickBuffer(this.config.microstructure.tickBufferSize));
    }
    
    this.tickBuffers.get(tick.marketId)!.push(tick);
  }

  private calculateRSI(prices: number[], marketId?: string, period: number = 14): number {
    if (prices.length < 2) return 50; // Neutral RSI
    
    // Get the current price change
    const currentChange = prices[prices.length - 1] - prices[prices.length - 2];
    const currentGain = currentChange > 0 ? currentChange : 0;
    const currentLoss = currentChange < 0 ? -currentChange : 0;
    
    // Use market ID for persistent storage, fallback to generic key
    const key = marketId || 'default';
    
    if (!this.rsiInitialized.get(key)) {
      // Initialize with SMA for first calculation
      if (prices.length < period + 1) return 50;
      
      const recentPrices = prices.slice(-period - 1);
      let totalGains = 0;
      let totalLosses = 0;
      
      for (let i = 1; i < recentPrices.length; i++) {
        const change = recentPrices[i] - recentPrices[i - 1];
        if (change > 0) {
          totalGains += change;
        } else {
          totalLosses -= change;
        }
      }
      
      this.rsiAvgGain.set(key, totalGains / period);
      this.rsiAvgLoss.set(key, totalLosses / period);
      this.rsiInitialized.set(key, true);
    } else {
      // Use Wilder's smoothing (EMA with alpha = 1/period)
      const alpha = 1 / period;
      const prevAvgGain = this.rsiAvgGain.get(key) || 0;
      const prevAvgLoss = this.rsiAvgLoss.get(key) || 0;
      
      // Wilder's smoothing formula: new_avg = ((period-1) * prev_avg + current_value) / period
      // Which is equivalent to: new_avg = prev_avg + alpha * (current_value - prev_avg)
      const newAvgGain = prevAvgGain + alpha * (currentGain - prevAvgGain);
      const newAvgLoss = prevAvgLoss + alpha * (currentLoss - prevAvgLoss);
      
      this.rsiAvgGain.set(key, newAvgGain);
      this.rsiAvgLoss.set(key, newAvgLoss);
    }
    
    const avgGain = this.rsiAvgGain.get(key) || 0;
    const avgLoss = this.rsiAvgLoss.get(key) || 0;
    
    if (avgLoss === 0) return avgGain > 0 ? 100 : 50;
    
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  private calculateMACD(prices: number[], marketId: string): { line: number; signal: number; histogram: number } {
    if (prices.length < 26) {
      return { line: 0, signal: 0, histogram: 0 };
    }

    const ema12 = this.calculateEMA(prices, 12);
    const ema26 = this.calculateEMA(prices, 26);
    const macdLine = ema12 - ema26;

    // Store MACD line in history for reference (but don't use for signal calculation)
    if (!this.macdHistory.has(marketId)) {
      this.macdHistory.set(marketId, []);
    }
    
    const history = this.macdHistory.get(marketId)!;
    history.push(macdLine);
    
    // Keep only last 50 MACD values to prevent memory bloat
    if (history.length > 50) {
      history.shift();
    }

    // Calculate signal line incrementally to avoid lookahead bias
    let signalLine: number;
    
    if (!this.macdSignalInitialized.get(marketId)) {
      // Initialize signal line with SMA of first 9 MACD values
      if (history.length >= 9) {
        const initial9 = history.slice(-9);
        signalLine = initial9.reduce((sum, val) => sum + val, 0) / 9;
        this.macdSignalEMA.set(marketId, signalLine);
        this.macdSignalInitialized.set(marketId, true);
      } else {
        signalLine = macdLine; // Use MACD line until we have enough data
      }
    } else {
      // Use EMA formula: new_ema = prev_ema + alpha * (current_value - prev_ema)
      const alpha = 2 / (9 + 1); // 9-period EMA smoothing factor
      const prevSignal = this.macdSignalEMA.get(marketId) || macdLine;
      signalLine = prevSignal + alpha * (macdLine - prevSignal);
      this.macdSignalEMA.set(marketId, signalLine);
    }

    return {
      line: macdLine,
      signal: signalLine,
      histogram: macdLine - signalLine,
    };
  }

  private calculateEMA(prices: number[], period: number): number {
    if (prices.length < period) return prices[prices.length - 1] || 0;

    const multiplier = 2 / (period + 1);
    let ema = prices.slice(0, period).reduce((sum, price) => sum + price, 0) / period;

    for (let i = period; i < prices.length; i++) {
      ema = (prices[i] - ema) * multiplier + ema;
    }

    return ema;
  }

  private calculateMomentum(prices: number[], periods: number = 10): number {
    if (prices.length < periods + 1) return 0;

    const current = prices[prices.length - 1];
    const previous = prices[prices.length - 1 - periods];
    
    return previous > 0 ? ((current - previous) / previous) * 100 : 0;
  }

  private calculatePriceDeviation(currentPrice: number, buffer: TickBuffer): number {
    const vwap = buffer.calculateVWAP(60 * 60 * 1000); // 1 hour VWAP
    return vwap > 0 ? ((currentPrice - vwap) / vwap) * 100 : 0;
  }

  private detectRSISignal(indicators: TechnicalIndicators): MicrostructureSignal | null {
    const { rsi, momentum } = indicators;
    
    // RSI oversold with positive momentum or overbought with negative momentum
    const isOversoldBounce = rsi < 30 && momentum > 2;
    const isOverboughtDrop = rsi > 70 && momentum < -2;

    if (isOversoldBounce || isOverboughtDrop) {
      const severity = (rsi < 20 || rsi > 80) ? 'high' : 'medium';
      const confidence = Math.min(0.9, Math.abs(momentum) / 5);

      return {
        type: 'momentum_breakout',
        marketId: indicators.marketId,
        timestamp: indicators.timestamp,
        confidence,
        severity,
        data: {
          current: rsi,
          baseline: 50,
          change: Math.abs(rsi - 50),
          context: {
            type: isOversoldBounce ? 'oversold_bounce' : 'overbought_drop',
            momentum,
          },
        },
      };
    }

    return null;
  }

  private detectMACDSignal(indicators: TechnicalIndicators): MicrostructureSignal | null {
    const { macd } = indicators;
    
    // MACD line crossing above signal line (bullish) or below (bearish)
    const isBullishCrossover = macd.line > macd.signal && macd.histogram > 0.001;
    const isBearishCrossover = macd.line < macd.signal && macd.histogram < -0.001;

    if (isBullishCrossover || isBearishCrossover) {
      const severity = Math.abs(macd.histogram) > 0.005 ? 'high' : 'medium';
      const confidence = Math.min(0.85, Math.abs(macd.histogram) * 100);

      return {
        type: 'momentum_breakout',
        marketId: indicators.marketId,
        timestamp: indicators.timestamp,
        confidence,
        severity,
        data: {
          current: macd.line,
          baseline: macd.signal,
          change: Math.abs(macd.histogram),
          context: {
            type: isBullishCrossover ? 'macd_bullish' : 'macd_bearish',
            histogram: macd.histogram,
          },
        },
      };
    }

    return null;
  }

  private detectMomentumBreakout(indicators: TechnicalIndicators): MicrostructureSignal | null {
    const { momentum } = indicators;
    const threshold = this.config.microstructure.momentumThreshold;

    if (Math.abs(momentum) > threshold) {
      const severity = Math.abs(momentum) > threshold * 2 ? 'critical' :
                      Math.abs(momentum) > threshold * 1.5 ? 'high' : 'medium';
      const confidence = Math.min(0.95, Math.abs(momentum) / (threshold * 2));

      return {
        type: 'momentum_breakout',
        marketId: indicators.marketId,
        timestamp: indicators.timestamp,
        confidence,
        severity,
        data: {
          current: momentum,
          baseline: 0,
          change: Math.abs(momentum),
          context: {
            direction: momentum > 0 ? 'bullish' : 'bearish',
            type: 'momentum_breakout',
          },
        },
      };
    }

    return null;
  }

  private detectVWAPDeviation(indicators: TechnicalIndicators): MicrostructureSignal | null {
    const { priceDeviation } = indicators;
    const threshold = 2; // 2% deviation threshold

    if (Math.abs(priceDeviation) > threshold) {
      const severity = Math.abs(priceDeviation) > threshold * 2 ? 'high' : 'medium';
      const confidence = Math.min(0.9, Math.abs(priceDeviation) / (threshold * 2));

      return {
        type: 'momentum_breakout',
        marketId: indicators.marketId,
        timestamp: indicators.timestamp,
        confidence,
        severity,
        data: {
          current: indicators.vwap,
          baseline: indicators.vwap * (1 - priceDeviation / 100),
          change: Math.abs(priceDeviation),
          context: {
            type: 'vwap_deviation',
            deviation: priceDeviation,
            direction: priceDeviation > 0 ? 'above' : 'below',
          },
        },
      };
    }

    return null;
  }

  // Utility methods
  getMarketIndicators(marketId: string): TechnicalIndicators | null {
    const buffer = this.tickBuffers.get(marketId);
    if (!buffer || buffer.isEmpty()) return null;

    const latest = buffer.getLatest();
    return latest ? this.calculateIndicators(marketId, latest) : null;
  }

  getMarketMomentum(marketId: string, periods: number = 10): number {
    const buffer = this.tickBuffers.get(marketId);
    return buffer ? buffer.calculateMomentum(periods) : 0;
  }

  getMarketVWAP(marketId: string, windowMs: number = 60 * 60 * 1000): number {
    const buffer = this.tickBuffers.get(marketId);
    return buffer ? buffer.calculateVWAP(windowMs) : 0;
  }

  // Cleanup methods to prevent memory leaks
  clearMarketData(marketId: string): void {
    const buffer = this.tickBuffers.get(marketId);
    if (buffer) {
      buffer.dispose();
      this.tickBuffers.delete(marketId);
    }
    
    // Also clear MACD history
    this.macdHistory.delete(marketId);
  }

  clearAllData(): void {
    for (const [marketId, buffer] of this.tickBuffers) {
      buffer.dispose();
    }
    this.tickBuffers.clear();
    this.macdHistory.clear();
  }

  dispose(): void {
    this.clearAllData();
  }

  // Utility method to clean up old market data
  cleanupStaleMarkets(maxAgeMs: number = 24 * 60 * 60 * 1000): void {
    const now = Date.now();
    const marketsToRemove: string[] = [];

    // Age-based cleanup
    for (const [marketId, buffer] of this.tickBuffers) {
      const latest = buffer.getLatest();
      if (!latest || (now - latest.timestamp) > maxAgeMs) {
        marketsToRemove.push(marketId);
      }
    }

    for (const marketId of marketsToRemove) {
      this.clearMarketData(marketId);
      logger.debug(`Cleaned up stale market data for ${marketId}`);
    }

    // Size-based cleanup - if we have too many markets, remove oldest ones
    const maxMarkets = 500; // Reasonable limit for personal use
    if (this.tickBuffers.size > maxMarkets) {
      const sortedMarkets = Array.from(this.tickBuffers.entries())
        .map(([marketId, buffer]) => ({
          marketId,
          lastUpdate: buffer.getLatest()?.timestamp || 0
        }))
        .sort((a, b) => a.lastUpdate - b.lastUpdate); // Oldest first

      const marketsToRemoveCount = this.tickBuffers.size - maxMarkets;
      for (let i = 0; i < marketsToRemoveCount; i++) {
        this.clearMarketData(sortedMarkets[i].marketId);
        logger.debug(`Removed market ${sortedMarkets[i].marketId} due to size limit`);
      }
    }

    // Also cleanup MACD history for markets not in tick buffers
    for (const marketId of this.macdHistory.keys()) {
      if (!this.tickBuffers.has(marketId)) {
        this.macdHistory.delete(marketId);
      }
    }
  }
}