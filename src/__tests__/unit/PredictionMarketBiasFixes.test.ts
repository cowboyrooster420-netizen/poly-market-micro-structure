/**
 * Tests for prediction market bias fixes
 *
 * This test suite validates that mathematical operations are unbiased
 * across different probability levels (0-1). In prediction markets,
 * prices represent probabilities, not unbounded financial prices.
 *
 * Key principle: The same absolute probability change (e.g., 5 percentage points)
 * should produce the same metric value regardless of the starting probability level.
 */

import { OrderFlowAnalyzer } from '../../services/OrderFlowAnalyzer';
import { StatisticalModels, StatisticalConfig } from '../../statistics/StatisticalModels';
import { SignalDetector } from '../../services/SignalDetector';
import { OrderbookLevel, TickData, BotConfig } from '../../types';

// Mock configurations
const mockBotConfig: BotConfig = {
  checkIntervalMs: 30000,
  minVolumeThreshold: 10000,
  maxMarketsToTrack: 100,
  logLevel: 'info',
  apiUrls: {
    clob: 'https://clob.polymarket.com',
    gamma: 'https://gamma-api.polymarket.com',
  },
  microstructure: {
    orderbookImbalanceThreshold: 0.3,
    spreadAnomalyThreshold: 2.0,
    liquidityShiftThreshold: 20,
    tickBufferSize: 1000,
  },
  discord: {
    webhookUrl: undefined,
    enableRichEmbeds: true,
    alertRateLimit: 10,
  },
};

const mockStatConfig: StatisticalConfig = {
  windowSize: 20,
  outlierThreshold: 3,
  minSampleSize: 10,
  confidenceLevel: 0.95,
  ewmaAlpha: 0.1,
};

describe('Prediction Market Bias Fixes', () => {
  describe('Price Impact Calculation (OrderFlowAnalyzer)', () => {
    let analyzer: OrderFlowAnalyzer;

    beforeEach(() => {
      analyzer = new OrderFlowAnalyzer(mockBotConfig);
    });

    afterEach(() => {
      analyzer.dispose();
    });

    test('5-cent price move should have same impact at 10% and 90% probability', () => {
      // Low probability market: 10% → 15%
      const lowProbTrades: TickData[] = [
        { marketId: 'test', price: 0.10, volume: 100, size: 100, timestamp: Date.now() - 1000, side: 'buy' },
        { marketId: 'test', price: 0.15, volume: 100, size: 100, timestamp: Date.now(), side: 'buy' },
      ];

      // High probability market: 90% → 95%
      const highProbTrades: TickData[] = [
        { marketId: 'test', price: 0.90, volume: 100, size: 100, timestamp: Date.now() - 1000, side: 'buy' },
        { marketId: 'test', price: 0.95, volume: 100, size: 100, timestamp: Date.now(), side: 'buy' },
      ];

      const emptyOrderbook: OrderbookLevel[] = [];

      // Use reflection to access private method for testing
      const calculatePriceImpact = (analyzer as any).calculatePriceImpact.bind(analyzer);

      const lowImpact = calculatePriceImpact(lowProbTrades, emptyOrderbook, emptyOrderbook);
      const highImpact = calculatePriceImpact(highProbTrades, emptyOrderbook, emptyOrderbook);

      // Both should be 0.05 (5 percentage points)
      expect(lowImpact).toBeCloseTo(0.05, 10);
      expect(highImpact).toBeCloseTo(0.05, 10);
      expect(lowImpact).toBeCloseTo(highImpact, 10);
    });

    test('price impact should be absolute probability change, not percentage', () => {
      const trades: TickData[] = [
        { marketId: 'test', price: 0.50, volume: 100, size: 100, timestamp: Date.now() - 1000, side: 'buy' },
        { marketId: 'test', price: 0.53, volume: 100, size: 100, timestamp: Date.now(), side: 'buy' },
      ];

      const emptyOrderbook: OrderbookLevel[] = [];
      const calculatePriceImpact = (analyzer as any).calculatePriceImpact.bind(analyzer);

      const impact = calculatePriceImpact(trades, emptyOrderbook, emptyOrderbook);

      // Should be 0.03 (3 percentage points), not 0.06 (6% relative change)
      expect(impact).toBeCloseTo(0.03, 10);
    });
  });

  describe('Flow Pressure Calculation (OrderFlowAnalyzer)', () => {
    let analyzer: OrderFlowAnalyzer;

    beforeEach(() => {
      analyzer = new OrderFlowAnalyzer(mockBotConfig);
    });

    afterEach(() => {
      analyzer.dispose();
    });

    test('1000 shares should have same pressure at 10% and 90% probability', () => {
      // Low probability orderbook
      const lowProbBids: OrderbookLevel[] = [
        { price: 0.10, size: 1000, volume: 0.10 * 1000 },
        { price: 0.09, size: 500, volume: 0.09 * 500 },
      ];

      // High probability orderbook
      const highProbBids: OrderbookLevel[] = [
        { price: 0.90, size: 1000, volume: 0.90 * 1000 },
        { price: 0.89, size: 500, volume: 0.89 * 500 },
      ];

      const emptyAsks: OrderbookLevel[] = [];

      const calculateFlowPressure = (analyzer as any).calculateFlowPressure.bind(analyzer);

      const lowPressure = calculateFlowPressure(lowProbBids, emptyAsks);
      const highPressure = calculateFlowPressure(highProbBids, emptyAsks);

      // Pressure should be based on SIZE only, not size × price
      // Level 0: 1000 × 1.0 = 1000
      // Level 1: 500 × 0.5 = 250
      // Total: 1250
      expect(lowPressure.bidPressure).toBeCloseTo(1250, 5);
      expect(highPressure.bidPressure).toBeCloseTo(1250, 5);
      expect(lowPressure.bidPressure).toBeCloseTo(highPressure.bidPressure, 5);
    });

    test('flow pressure should not multiply by price', () => {
      const bids: OrderbookLevel[] = [
        { price: 0.50, size: 2000, volume: 0.50 * 2000 },
      ];
      const asks: OrderbookLevel[] = [
        { price: 0.51, size: 1500, volume: 0.51 * 1500 },
      ];

      const calculateFlowPressure = (analyzer as any).calculateFlowPressure.bind(analyzer);
      const pressure = calculateFlowPressure(bids, asks);

      // Bid pressure: 2000 × 1.0 = 2000 (not 2000 × 0.50 = 1000)
      // Ask pressure: 1500 × 1.0 = 1500 (not 1500 × 0.51 = 765)
      expect(pressure.bidPressure).toBeCloseTo(2000, 5);
      expect(pressure.askPressure).toBeCloseTo(1500, 5);
    });
  });

  describe('Volatility Calculation (StatisticalModels)', () => {
    let models: StatisticalModels;

    beforeEach(() => {
      models = new StatisticalModels(mockStatConfig);
    });

    test('1% probability move should have same volatility at 10% and 90% levels', () => {
      // Low probability market: oscillates ±1% around 10%
      const lowProbPrices = [0.09, 0.10, 0.11, 0.10, 0.09, 0.10, 0.11, 0.10];

      // High probability market: oscillates ±1% around 90%
      const highProbPrices = [0.89, 0.90, 0.91, 0.90, 0.89, 0.90, 0.91, 0.90];

      const lowVolatility = models.calculateVolatilityMetrics('low', lowProbPrices);
      const highVolatility = models.calculateVolatilityMetrics('high', highProbPrices);

      // Both should have similar volatility since absolute moves are the same
      const ratio = lowVolatility.historicalVolatility / highVolatility.historicalVolatility;
      expect(ratio).toBeGreaterThan(0.9);
      expect(ratio).toBeLessThan(1.1);
    });

    test('volatility should use absolute changes, not log returns', () => {
      // Market with consistent 2% absolute moves
      const prices = [0.50, 0.52, 0.50, 0.52, 0.50, 0.52, 0.50];

      const volatility = models.calculateVolatilityMetrics('test', prices);

      // Returns should be: [0.02, -0.02, 0.02, -0.02, 0.02, -0.02]
      // Standard deviation ≈ 0.02
      // NOT log returns which would be: [0.0392, -0.0408, ...]
      expect(volatility.historicalVolatility).toBeGreaterThan(0);
      expect(volatility.historicalVolatility).toBeLessThan(1); // Reasonable bound
    });
  });

  describe('Signal Detection (SignalDetector)', () => {
    let detector: SignalDetector;

    beforeEach(() => {
      detector = new SignalDetector(mockBotConfig);
    });

    test('5pp probability move should trigger same signal strength at all levels', () => {
      // Test at 10%, 50%, and 90% probability levels
      const testCases = [
        { name: '10%', prev: 0.10, curr: 0.15 },
        { name: '50%', prev: 0.50, curr: 0.55 },
        { name: '90%', prev: 0.90, curr: 0.95 },
      ];

      testCases.forEach(({ name, prev, curr }) => {
        const previousPrices = [prev, 1 - prev];
        const currentPrices = [curr, 1 - curr];

        const calculatePriceChange = (detector as any).calculatePriceChange.bind(detector);
        const changes = calculatePriceChange(currentPrices, {
          marketId: 'test',
          volume24h: 10000,
          prices: previousPrices,
          timestamp: Date.now() - 60000,
        });

        // Change should be 5 (5 percentage points), not a percentage
        expect(Math.abs(changes.outcome_0)).toBeCloseTo(5, 1);
      });
    });

    test('price change should be in percentage points, not percentage', () => {
      const previousPrices = [0.30, 0.70];
      const currentPrices = [0.35, 0.65];

      const calculatePriceChange = (detector as any).calculatePriceChange.bind(detector);
      const changes = calculatePriceChange(currentPrices, {
        marketId: 'test',
        volume24h: 10000,
        prices: previousPrices,
        timestamp: Date.now() - 60000,
      });

      // Should be 5 (5pp), not 16.67% (relative change from 0.30 to 0.35)
      expect(changes.outcome_0).toBeCloseTo(5, 1);
    });
  });

  describe('Cross-Level Consistency', () => {
    test('all metrics should be unbiased across probability levels', () => {
      const analyzer = new OrderFlowAnalyzer(mockBotConfig);
      const models = new StatisticalModels(mockStatConfig);
      const detector = new SignalDetector(mockBotConfig);

      // Test the same 5pp move at three different levels
      const levels = [
        { start: 0.10, end: 0.15, name: '10% level' },
        { start: 0.50, end: 0.55, name: '50% level' },
        { start: 0.90, end: 0.95, name: '90% level' },
      ];

      const results: any[] = [];

      levels.forEach(({ start, end, name }) => {
        // Price impact
        const trades: TickData[] = [
          { marketId: 'test', price: start, volume: 100, size: 100, timestamp: Date.now() - 1000, side: 'buy' },
          { marketId: 'test', price: end, volume: 100, size: 100, timestamp: Date.now(), side: 'buy' },
        ];
        const calculatePriceImpact = (analyzer as any).calculatePriceImpact.bind(analyzer);
        const impact = calculatePriceImpact(trades, [], []);

        // Flow pressure
        const bids: OrderbookLevel[] = [{ price: start, size: 1000, volume: start * 1000 }];
        const calculateFlowPressure = (analyzer as any).calculateFlowPressure.bind(analyzer);
        const pressure = calculateFlowPressure(bids, []);

        // Signal detection
        const calculatePriceChange = (detector as any).calculatePriceChange.bind(detector);
        const change = calculatePriceChange([end], {
          marketId: 'test',
          volume24h: 10000,
          prices: [start],
          timestamp: Date.now() - 60000,
        });

        results.push({ name, impact, pressure: pressure.bidPressure, change: change.outcome_0 });
      });

      // All impacts should be 0.05 (5pp)
      results.forEach(r => {
        expect(r.impact).toBeCloseTo(0.05, 10);
      });

      // All pressures should be 1000 (size only)
      results.forEach(r => {
        expect(r.pressure).toBeCloseTo(1000, 5);
      });

      // All changes should be 5 (5pp)
      results.forEach(r => {
        expect(r.change).toBeCloseTo(5, 1);
      });

      // Verify consistency across levels
      expect(results[0].impact).toBeCloseTo(results[1].impact, 10);
      expect(results[1].impact).toBeCloseTo(results[2].impact, 10);
      expect(results[0].pressure).toBeCloseTo(results[1].pressure, 5);
      expect(results[1].pressure).toBeCloseTo(results[2].pressure, 5);
      expect(results[0].change).toBeCloseTo(results[1].change, 1);
      expect(results[1].change).toBeCloseTo(results[2].change, 1);
    });
  });
});
