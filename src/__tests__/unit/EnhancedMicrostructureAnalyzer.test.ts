import { EnhancedMicrostructureAnalyzer } from '../../services/EnhancedMicrostructureAnalyzer';
import { BotConfig, OrderbookData } from '../../types';

/**
 * EnhancedMicrostructureAnalyzer Tests
 *
 * Tests for the EnhancedMicrostructureAnalyzer, focusing on the spread-to-bps
 * conversion fix. Verifies that spreadBps is calculated correctly using
 * spread * 10000 instead of (spread / midPrice) * 10000.
 */
describe('EnhancedMicrostructureAnalyzer', () => {
  let analyzer: EnhancedMicrostructureAnalyzer;
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

    analyzer = new EnhancedMicrostructureAnalyzer(mockConfig);
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

  describe('Spread to Basis Points Conversion', () => {
    test('should calculate spreadBps correctly for 2.7¢ spread (270 bps)', () => {
      // Real-world example from Discord bug report
      const orderbook = createOrderbook(0.011, 0.038);
      const metrics = analyzer.processOrderbook(orderbook);

      expect(metrics).toBeDefined();
      expect(metrics!.spreadBps).toBeCloseTo(270, 0);
    });

    test('should calculate spreadBps correctly for 1¢ spread (100 bps)', () => {
      const orderbook = createOrderbook(0.50, 0.51);
      const metrics = analyzer.processOrderbook(orderbook);

      expect(metrics!.spreadBps).toBeCloseTo(100, 0);
    });

    test('should calculate spreadBps correctly for 10¢ spread (1000 bps)', () => {
      const orderbook = createOrderbook(0.45, 0.55);
      const metrics = analyzer.processOrderbook(orderbook);

      expect(metrics!.spreadBps).toBeCloseTo(1000, 0);
    });

    test('spreadBps should be price-level independent', () => {
      // Same 5¢ spread at different price levels
      const lowPriceOrderbook = createOrderbook(0.10, 0.15, 'low');
      const midPriceOrderbook = createOrderbook(0.47, 0.52, 'mid');
      const highPriceOrderbook = createOrderbook(0.85, 0.90, 'high');

      const lowMetrics = analyzer.processOrderbook(lowPriceOrderbook);
      const midMetrics = analyzer.processOrderbook(midPriceOrderbook);
      const highMetrics = analyzer.processOrderbook(highPriceOrderbook);

      // All should report 500 bps
      expect(lowMetrics!.spreadBps).toBeCloseTo(500, 0);
      expect(midMetrics!.spreadBps).toBeCloseTo(500, 0);
      expect(highMetrics!.spreadBps).toBeCloseTo(500, 0);

      // They should all be equal
      expect(Math.abs(lowMetrics!.spreadBps - midMetrics!.spreadBps)).toBeLessThan(1);
      expect(Math.abs(midMetrics!.spreadBps - highMetrics!.spreadBps)).toBeLessThan(1);
    });
  });

  describe('Edge Cases', () => {
    test('should handle zero spread (locked market)', () => {
      const orderbook = createOrderbook(0.50, 0.50);
      const metrics = analyzer.processOrderbook(orderbook);

      expect(metrics!.spreadBps).toBe(0);
    });

    test('should handle very tight spread (10 bps)', () => {
      const orderbook = createOrderbook(0.4990, 0.5000);  // 0.1¢ spread
      const metrics = analyzer.processOrderbook(orderbook);

      expect(metrics!.spreadBps).toBeCloseTo(10, 0);
    });

    test('should handle very wide spread (5000 bps)', () => {
      const orderbook = createOrderbook(0.25, 0.75);  // 50¢ spread
      const metrics = analyzer.processOrderbook(orderbook);

      expect(metrics!.spreadBps).toBeCloseTo(5000, 0);
    });
  });

  describe('Regression Tests - Fix Verification', () => {
    test('should NOT use old buggy formula (spread / midPrice * 10000)', () => {
      const orderbook = createOrderbook(0.486, 0.514);  // 2.8¢ spread, midPrice = 0.5
      const metrics = analyzer.processOrderbook(orderbook);

      // OLD WRONG WAY: (0.028 / 0.5) * 10000 = 560 bps
      const oldBuggyValue = (orderbook.spread / orderbook.midPrice) * 10000;
      expect(oldBuggyValue).toBeCloseTo(560, 0);

      // NEW CORRECT WAY: 0.028 * 10000 = 280 bps
      expect(metrics!.spreadBps).toBeCloseTo(280, 0);

      // They should be different
      expect(Math.abs(metrics!.spreadBps - oldBuggyValue)).toBeGreaterThan(200);
    });

    test('spreadBps should match across all probability levels', () => {
      // Create multiple orderbooks with 2¢ spread at various price levels
      const testCases = [
        { bid: 0.01, ask: 0.03, level: '2%' },
        { bid: 0.20, ask: 0.22, level: '21%' },
        { bid: 0.49, ask: 0.51, level: '50%' },
        { bid: 0.74, ask: 0.76, level: '75%' },
        { bid: 0.96, ask: 0.98, level: '97%' },
      ];

      const spreadBpsList = testCases.map(tc => {
        const orderbook = createOrderbook(tc.bid, tc.ask, `market_${tc.level}`);
        const metrics = analyzer.processOrderbook(orderbook);
        return metrics!.spreadBps;
      });

      // All should be approximately 200 bps
      spreadBpsList.forEach(bps => {
        expect(bps).toBeCloseTo(200, 0);
      });

      // Standard deviation should be very low (all values should be identical)
      const mean = spreadBpsList.reduce((a, b) => a + b) / spreadBpsList.length;
      const variance = spreadBpsList.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / spreadBpsList.length;
      const stdDev = Math.sqrt(variance);

      expect(stdDev).toBeLessThan(1);  // Very low deviation
    });

    test('Discord bug example: should show 270 bps not 9520 bps', () => {
      // The original bug showed 9520 bps when actual spread was 270 bps
      const orderbook = createOrderbook(0.011, 0.038);
      const metrics = analyzer.processOrderbook(orderbook);

      // Should show correct 270 bps
      expect(metrics!.spreadBps).toBeCloseTo(270, 0);

      // NOT the outcome range that was being calculated before
      const outcomeRange = (0.989 - 0.011) * 10000;
      expect(outcomeRange).toBeCloseTo(9780, 0);  // What was shown before (~9520)

      // They should be very different
      expect(Math.abs(metrics!.spreadBps - outcomeRange)).toBeGreaterThan(9000);
    });
  });

  describe('Imbalance Calculations', () => {
    test('should calculate imbalance in range [-1, 1]', () => {
      const orderbook = createOrderbook(0.50, 0.51);
      const metrics = analyzer.processOrderbook(orderbook);

      expect(metrics!.imbalance).toBeGreaterThanOrEqual(-1);
      expect(metrics!.imbalance).toBeLessThanOrEqual(1);
    });

    test('should show positive imbalance for bid-heavy orderbook', () => {
      const bidHeavyOrderbook: OrderbookData = {
        marketId: 'bid_heavy',
        timestamp: Date.now(),
        bids: [
          { price: 0.50, size: 1000, volume: 500 },
          { price: 0.49, size: 800, volume: 392 },
        ],
        asks: [
          { price: 0.51, size: 100, volume: 51 },
          { price: 0.52, size: 80, volume: 41.6 },
        ],
        spread: 0.01,
        midPrice: 0.505,
        bestBid: 0.50,
        bestAsk: 0.51,
      };

      const metrics = analyzer.processOrderbook(bidHeavyOrderbook);
      expect(metrics!.imbalance).toBeGreaterThan(0);
    });

    test('should show negative imbalance for ask-heavy orderbook', () => {
      const askHeavyOrderbook: OrderbookData = {
        marketId: 'ask_heavy',
        timestamp: Date.now(),
        bids: [
          { price: 0.50, size: 100, volume: 50 },
          { price: 0.49, size: 80, volume: 39.2 },
        ],
        asks: [
          { price: 0.51, size: 1000, volume: 510 },
          { price: 0.52, size: 800, volume: 416 },
        ],
        spread: 0.01,
        midPrice: 0.505,
        bestBid: 0.50,
        bestAsk: 0.51,
      };

      const metrics = analyzer.processOrderbook(askHeavyOrderbook);
      expect(metrics!.imbalance).toBeLessThan(0);
    });
  });

  describe('processOrderbook integration', () => {
    test('should return all expected metrics fields', () => {
      const orderbook = createOrderbook(0.48, 0.52);
      const metrics = analyzer.processOrderbook(orderbook);

      expect(metrics).toBeDefined();
      expect(metrics!.imbalance).toBeDefined();
      expect(metrics!.spreadBps).toBeDefined();
      expect(metrics!.spreadChange).toBeDefined();
    });

    test('should track spread changes over time', () => {
      const marketId = 'spread_change_test';

      // First orderbook with 1% spread
      const orderbook1 = createOrderbook(0.495, 0.505, marketId);
      orderbook1.timestamp = Date.now() - 10000;
      const metrics1 = analyzer.processOrderbook(orderbook1);
      expect(metrics1!.spreadBps).toBeCloseTo(100, 0);

      // Second orderbook with 2% spread
      const orderbook2 = createOrderbook(0.49, 0.51, marketId);
      orderbook2.timestamp = Date.now();
      const metrics2 = analyzer.processOrderbook(orderbook2);
      expect(metrics2!.spreadBps).toBeCloseTo(200, 0);

      // Spread change should be positive (widened)
      expect(metrics2!.spreadChange).toBeGreaterThan(0);
    });
  });
});
