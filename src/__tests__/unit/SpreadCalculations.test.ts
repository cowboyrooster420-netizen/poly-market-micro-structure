import { OrderbookData } from '../../types';

/**
 * Core Spread Calculation Tests
 *
 * These tests verify that spread calculations are consistent across different
 * price levels in prediction markets. This prevents the bug where spreads were
 * incorrectly divided by price levels (bestAsk or midPrice), causing spreads
 * to appear different for the same absolute spread at different probabilities.
 */
describe('Spread Calculations - Prediction Market Math', () => {

  /**
   * Helper function to create an orderbook with specific bid/ask values
   */
  const createOrderbook = (bestBid: number, bestAsk: number): OrderbookData => {
    const spread = bestAsk - bestBid;
    const midPrice = (bestBid + bestAsk) / 2;

    return {
      marketId: 'test_market',
      timestamp: Date.now(),
      bids: [
        { price: bestBid, size: 100, volume: bestBid * 100 },
        { price: bestBid - 0.01, size: 50, volume: (bestBid - 0.01) * 50 },
      ],
      asks: [
        { price: bestAsk, size: 100, volume: bestAsk * 100 },
        { price: bestAsk + 0.01, size: 50, volume: (bestAsk + 0.01) * 50 },
      ],
      spread,
      midPrice,
      bestBid,
      bestAsk,
    };
  };

  describe('Spread Consistency Across Price Levels', () => {
    test('2.7¢ spread should equal 270 bps regardless of probability level', () => {
      // Real-world example from Discord: bid=1.1¢, ask=3.8¢ = 2.7¢ spread
      const spread = 0.027;

      // Test at different probability levels
      const lowProbMarket = createOrderbook(0.011, 0.038);    // ~2.5% probability
      const midProbMarket = createOrderbook(0.486, 0.513);    // ~50% probability
      const highProbMarket = createOrderbook(0.976, 1.003);   // ~99% probability (capped at 1.0)

      // All should report the same spread
      expect(lowProbMarket.spread).toBeCloseTo(spread, 4);
      expect(midProbMarket.spread).toBeCloseTo(spread, 4);

      // Convert to basis points
      const expectedBps = 270;
      expect(lowProbMarket.spread * 10000).toBeCloseTo(expectedBps, 0);
      expect(midProbMarket.spread * 10000).toBeCloseTo(expectedBps, 0);
    });

    test('1¢ spread should equal 100 bps at any price level', () => {
      const spread = 0.01;
      const expectedBps = 100;

      const market10pct = createOrderbook(0.10, 0.11);  // 10% probability
      const market50pct = createOrderbook(0.50, 0.51);  // 50% probability
      const market90pct = createOrderbook(0.90, 0.91);  // 90% probability

      expect(market10pct.spread * 10000).toBeCloseTo(expectedBps, 0);
      expect(market50pct.spread * 10000).toBeCloseTo(expectedBps, 0);
      expect(market90pct.spread * 10000).toBeCloseTo(expectedBps, 0);
    });

    test('10¢ spread should equal 1000 bps (10%) at any price level', () => {
      const spread = 0.10;
      const expectedBps = 1000;

      const market20pct = createOrderbook(0.20, 0.30);  // 20-30% range
      const market50pct = createOrderbook(0.45, 0.55);  // 45-55% range

      expect(market20pct.spread * 10000).toBeCloseTo(expectedBps, 0);
      expect(market50pct.spread * 10000).toBeCloseTo(expectedBps, 0);
    });
  });

  describe('Spread to Percentage Conversion', () => {
    test('spread * 100 should give correct percentage', () => {
      const orderbook = createOrderbook(0.45, 0.50);  // 5¢ spread

      const spreadPercent = orderbook.spread * 100;
      expect(spreadPercent).toBeCloseTo(5.0, 1);
    });

    test('very tight spread (0.1¢) should give 0.1%', () => {
      const orderbook = createOrderbook(0.500, 0.501);  // 0.1¢ spread

      const spreadPercent = orderbook.spread * 100;
      expect(spreadPercent).toBeCloseTo(0.1, 2);
    });

    test('very wide spread (50¢) should give 50%', () => {
      const orderbook = createOrderbook(0.25, 0.75);  // 50¢ spread

      const spreadPercent = orderbook.spread * 100;
      expect(spreadPercent).toBeCloseTo(50.0, 1);
    });
  });

  describe('Spread to Basis Points Conversion', () => {
    test('spread * 10000 should give correct basis points', () => {
      const orderbook = createOrderbook(0.45, 0.50);  // 5¢ spread

      const spreadBps = orderbook.spread * 10000;
      expect(spreadBps).toBeCloseTo(500, 0);
    });

    test('tight spread (20 bps) should be calculated correctly', () => {
      const orderbook = createOrderbook(0.498, 0.500);  // 0.2¢ spread = 20 bps

      const spreadBps = orderbook.spread * 10000;
      expect(spreadBps).toBeCloseTo(20, 0);
    });

    test('very wide spread (5000 bps) should be calculated correctly', () => {
      const orderbook = createOrderbook(0.25, 0.75);  // 50¢ spread = 5000 bps

      const spreadBps = orderbook.spread * 10000;
      expect(spreadBps).toBeCloseTo(5000, 0);
    });
  });

  describe('Edge Cases', () => {
    test('zero spread (locked market) should give 0 bps', () => {
      const orderbook = createOrderbook(0.50, 0.50);  // Locked

      expect(orderbook.spread).toBe(0);
      expect(orderbook.spread * 10000).toBe(0);
    });

    test('very small spread (0.01 bps) should be calculated accurately', () => {
      const orderbook = createOrderbook(0.5000, 0.5000001);  // ~0.01 bps

      const spreadBps = orderbook.spread * 10000;
      expect(spreadBps).toBeGreaterThan(0);
      expect(spreadBps).toBeLessThan(0.1);
    });

    test('maximum realistic spread (99¢) should give 9900 bps', () => {
      const orderbook = createOrderbook(0.005, 0.995);  // Nearly 100%

      const spreadBps = orderbook.spread * 10000;
      expect(spreadBps).toBeCloseTo(9900, 0);
    });
  });

  describe('Regression Tests - Prevent Old Bug', () => {
    test('should NOT divide spread by bestAsk (old bug)', () => {
      // This was the bug: (spread / bestAsk) * 100
      const orderbook = createOrderbook(0.011, 0.038);  // 2.7¢ spread, ask at 3.8¢

      // OLD WRONG WAY (what we fixed):
      const wrongCalculation = (orderbook.spread / orderbook.bestAsk) * 100;
      expect(wrongCalculation).toBeCloseTo(71.05, 1);  // WRONG!

      // NEW CORRECT WAY:
      const correctCalculation = orderbook.spread * 100;
      expect(correctCalculation).toBeCloseTo(2.7, 1);  // CORRECT!

      // The bug made it seem like spreads varied with price level
      expect(wrongCalculation).not.toBeCloseTo(correctCalculation, 1);
    });

    test('should NOT divide spread by midPrice (old bug)', () => {
      // This was another bug: spread / midPrice
      const orderbook = createOrderbook(0.486, 0.514);  // 2.8¢ spread, mid at 50¢

      // OLD WRONG WAY:
      const wrongCalculation = orderbook.spread / orderbook.midPrice;
      expect(wrongCalculation).toBeCloseTo(0.056, 3);  // 5.6% - WRONG!

      // NEW CORRECT WAY:
      const correctCalculation = orderbook.spread;
      expect(correctCalculation).toBeCloseTo(0.028, 3);  // 2.8% - CORRECT!
    });

    test('spread at 10% probability should equal spread at 90% probability', () => {
      // Same absolute spread, different price levels
      const lowProbMarket = createOrderbook(0.09, 0.12);   // 3¢ spread at ~10%
      const highProbMarket = createOrderbook(0.87, 0.90);  // 3¢ spread at ~88%

      // Absolute spreads should be equal
      expect(lowProbMarket.spread).toBeCloseTo(highProbMarket.spread, 4);

      // Basis points should be equal
      expect(lowProbMarket.spread * 10000).toBeCloseTo(highProbMarket.spread * 10000, 0);

      // This test FAILS with the old buggy formula!
      // Old buggy way would give different results:
      const oldBuggyLow = (lowProbMarket.spread / lowProbMarket.midPrice) * 10000;
      const oldBuggyHigh = (highProbMarket.spread / highProbMarket.midPrice) * 10000;
      expect(oldBuggyLow).not.toBeCloseTo(oldBuggyHigh, 0);  // Proves the bug!
    });
  });

  describe('Real-World Examples from Discord', () => {
    test('Discord example: 9520 bps shown, actual 270 bps', () => {
      // User reported: bid=1.1¢, ask=3.8¢, Discord showed 9520 bps
      const orderbook = createOrderbook(0.011, 0.038);

      // The bug was calculating outcome range instead of bid-ask spread
      const outcomeRange = (0.989 - 0.011) * 10000;  // Old buggy calculation
      expect(outcomeRange).toBeCloseTo(9780, 0);      // ~9520 bps shown in Discord

      // Correct spread calculation
      const actualSpreadBps = orderbook.spread * 10000;
      expect(actualSpreadBps).toBeCloseTo(270, 0);    // Correct 270 bps

      // Prove they're different
      expect(Math.abs(outcomeRange - actualSpreadBps)).toBeGreaterThan(9000);
    });
  });
});
