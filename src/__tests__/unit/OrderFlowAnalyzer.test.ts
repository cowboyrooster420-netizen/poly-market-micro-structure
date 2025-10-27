import { OrderFlowAnalyzer } from '../../services/OrderFlowAnalyzer';
import { BotConfig, OrderbookData } from '../../types';

/**
 * OrderFlowAnalyzer Tests
 *
 * Tests for spread tightness and relative spread calculations.
 * Verifies fixes to calculateSpreadTightness() and getRelativeSpread().
 */
describe('OrderFlowAnalyzer', () => {
  let analyzer: OrderFlowAnalyzer;
  let mockConfig: BotConfig;

  beforeEach(() => {
    mockConfig = {
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

    analyzer = new OrderFlowAnalyzer(mockConfig);
  });

  afterEach(() => {
    analyzer.dispose();
  });

  const createOrderbook = (bestBid: number, bestAsk: number, marketId: string = 'test_market'): OrderbookData => {
    const spread = bestAsk - bestBid;
    const midPrice = (bestBid + bestAsk) / 2;

    return {
      marketId,
      timestamp: Date.now(),
      bids: [
        { price: bestBid, size: 100, volume: bestBid * 100 },
        { price: bestBid - 0.01, size: 80, volume: (bestBid - 0.01) * 80 },
        { price: bestBid - 0.02, size: 60, volume: (bestBid - 0.02) * 60 },
      ],
      asks: [
        { price: bestAsk, size: 100, volume: bestAsk * 100 },
        { price: bestAsk + 0.01, size: 80, volume: (bestAsk + 0.01) * 80 },
        { price: bestAsk + 0.02, size: 60, volume: (bestAsk + 0.02) * 60 },
      ],
      spread,
      midPrice,
      bestBid,
      bestAsk,
    };
  };

  describe('calculateSpreadTightness', () => {
    test('should return 1.0 for zero spread (tightest possible)', () => {
      const orderbook = createOrderbook(0.50, 0.50);  // Locked market
      const metrics = (analyzer as any).calculateFlowMetrics(orderbook);

      expect(metrics.spreadTightness).toBeCloseTo(1.0, 2);
    });

    test('should return ~0 for very wide spread (10% or more)', () => {
      const orderbook = createOrderbook(0.25, 0.75);  // 50% spread >> 10%
      const metrics = (analyzer as any).calculateFlowMetrics(orderbook);

      // Should be close to 0 since spread is way wider than 10%
      expect(metrics.spreadTightness).toBeLessThan(0.1);
    });

    test('should return 0.9 for 100 bps (1%) spread', () => {
      const orderbook = createOrderbook(0.495, 0.505);  // 1% spread
      const metrics = (analyzer as any).calculateFlowMetrics(orderbook);

      // Tightness = 1 - (100 / 1000) = 0.9
      expect(metrics.spreadTightness).toBeCloseTo(0.9, 2);
    });

    test('should return 0.5 for 500 bps (5%) spread', () => {
      const orderbook = createOrderbook(0.475, 0.525);  // 5% spread
      const metrics = (analyzer as any).calculateFlowMetrics(orderbook);

      // Tightness = 1 - (500 / 1000) = 0.5
      expect(metrics.spreadTightness).toBeCloseTo(0.5, 2);
    });

    test('spread tightness should be price-level independent', () => {
      // Same 2% spread at different price levels
      const lowPriceOrderbook = createOrderbook(0.10, 0.12, 'low');    // 2% at 11%
      const midPriceOrderbook = createOrderbook(0.49, 0.51, 'mid');    // 2% at 50%
      const highPriceOrderbook = createOrderbook(0.88, 0.90, 'high');  // 2% at 89%

      const lowMetrics = (analyzer as any).calculateFlowMetrics(lowPriceOrderbook);
      const midMetrics = (analyzer as any).calculateFlowMetrics(midPriceOrderbook);
      const highMetrics = (analyzer as any).calculateFlowMetrics(highPriceOrderbook);

      // All should have same tightness: 1 - (200 / 1000) = 0.8
      expect(lowMetrics.spreadTightness).toBeCloseTo(0.8, 2);
      expect(midMetrics.spreadTightness).toBeCloseTo(0.8, 2);
      expect(highMetrics.spreadTightness).toBeCloseTo(0.8, 2);

      // They should all be equal
      expect(Math.abs(lowMetrics.spreadTightness - midMetrics.spreadTightness)).toBeLessThan(0.01);
      expect(Math.abs(midMetrics.spreadTightness - highMetrics.spreadTightness)).toBeLessThan(0.01);
    });
  });

  describe('getRelativeSpread', () => {
    test('should return absolute spread for prediction markets', () => {
      const orderbook = createOrderbook(0.48, 0.52);  // 4¢ spread

      // Access private method via type assertion (for testing)
      const relativeSpread = (analyzer as any).getRelativeSpread(orderbook);

      // Should return 0.04 (the absolute spread)
      expect(relativeSpread).toBeCloseTo(0.04, 3);
    });

    test('relative spread should be price-level independent', () => {
      // Same 3¢ spread at different price levels
      const testCases = [
        createOrderbook(0.10, 0.13, 'low'),
        createOrderbook(0.48, 0.51, 'mid'),
        createOrderbook(0.87, 0.90, 'high'),
      ];

      const relativeSpreads = testCases.map(ob => (analyzer as any).getRelativeSpread(ob));

      // All should return ~0.03
      relativeSpreads.forEach(spread => {
        expect(spread).toBeCloseTo(0.03, 3);
      });

      // They should all be equal
      expect(Math.abs(relativeSpreads[0] - relativeSpreads[1])).toBeLessThan(0.001);
      expect(Math.abs(relativeSpreads[1] - relativeSpreads[2])).toBeLessThan(0.001);
    });

    test('should NOT divide by midPrice (old bug)', () => {
      const orderbook = createOrderbook(0.486, 0.514);  // 2.8¢ spread, midPrice = 0.5

      const relativeSpread = (analyzer as any).getRelativeSpread(orderbook);

      // OLD WRONG WAY: 0.028 / 0.5 = 0.056
      const oldBuggyValue = orderbook.spread / orderbook.midPrice;
      expect(oldBuggyValue).toBeCloseTo(0.056, 3);

      // NEW CORRECT WAY: just return spread (0.028)
      expect(relativeSpread).toBeCloseTo(0.028, 3);

      // They should be different
      expect(relativeSpread).not.toBeCloseTo(oldBuggyValue, 3);
    });
  });

  describe('Regression Tests', () => {
    test('spread tightness should NOT use old formula (spread / midPrice)', () => {
      const orderbook = createOrderbook(0.40, 0.44);  // 4¢ spread, midPrice = 0.42
      const metrics = (analyzer as any).calculateFlowMetrics(orderbook);

      // OLD WRONG WAY: 1 - (0.04 / 0.42) ≈ 0.905
      const oldBuggyValue = 1 - (orderbook.spread / orderbook.midPrice);
      expect(oldBuggyValue).toBeCloseTo(0.905, 2);

      // NEW CORRECT WAY: 1 - (400 / 1000) = 0.6
      expect(metrics.spreadTightness).toBeCloseTo(0.6, 2);

      // They should be different
      expect(Math.abs(metrics.spreadTightness - oldBuggyValue)).toBeGreaterThan(0.1);
    });

    test('two markets with same absolute spread should have same tightness', () => {
      // 5¢ spread at very different probability levels
      const lowProbMarket = createOrderbook(0.05, 0.10, 'low');   // 5% at ~7.5% prob
      const highProbMarket = createOrderbook(0.90, 0.95, 'high'); // 5% at ~92.5% prob

      const lowMetrics = (analyzer as any).calculateFlowMetrics(lowProbMarket);
      const highMetrics = (analyzer as any).calculateFlowMetrics(highProbMarket);

      // Both should have same tightness since they have same absolute spread
      expect(lowMetrics.spreadTightness).toBeCloseTo(highMetrics.spreadTightness, 2);

      // With old buggy formula, they would be different:
      const oldBuggyLow = 1 - (lowProbMarket.spread / lowProbMarket.midPrice);
      const oldBuggyHigh = 1 - (highProbMarket.spread / highProbMarket.midPrice);
      expect(oldBuggyLow).not.toBeCloseTo(oldBuggyHigh, 2);  // Proves the bug existed
    });
  });

  describe('analyzeOrderFlow integration', () => {
    test('should analyze orderbook and return valid metrics', () => {
      const orderbook = createOrderbook(0.48, 0.52);
      const metrics = (analyzer as any).calculateFlowMetrics(orderbook);

      // Check all expected fields exist
      expect(metrics).toBeDefined();
      expect(metrics.bidAskImbalance).toBeDefined();
      expect(metrics.spreadTightness).toBeDefined();
      expect(metrics.marketMakerPresence).toBeDefined();

      // Tightness should be in valid range [0, 1]
      expect(metrics.spreadTightness).toBeGreaterThanOrEqual(0);
      expect(metrics.spreadTightness).toBeLessThanOrEqual(1);

      // Imbalance should be in valid range [-1, 1]
      expect(metrics.bidAskImbalance).toBeGreaterThanOrEqual(-1);
      expect(metrics.bidAskImbalance).toBeLessThanOrEqual(1);
    });

    test('should handle edge case of empty orderbook gracefully', () => {
      const emptyOrderbook: OrderbookData = {
        marketId: 'empty',
        timestamp: Date.now(),
        bids: [],
        asks: [],
        spread: 0,
        midPrice: 0,
        bestBid: 0,
        bestAsk: 0,
      };

      // Should not throw
      expect(() => (analyzer as any).calculateFlowMetrics(emptyOrderbook)).not.toThrow();
    });
  });
});
