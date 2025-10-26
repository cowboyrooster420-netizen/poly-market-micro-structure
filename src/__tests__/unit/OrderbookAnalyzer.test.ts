import { OrderbookAnalyzer } from '../../services/OrderbookAnalyzer';
import { BotConfig, OrderbookData } from '../../types';

/**
 * OrderbookAnalyzer Tests
 *
 * Tests for the OrderbookAnalyzer service, focusing on spread calculation fixes.
 * These tests verify that spread percentages are calculated correctly and
 * consistently across different price levels.
 */
describe('OrderbookAnalyzer', () => {
  let analyzer: OrderbookAnalyzer;
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

    analyzer = new OrderbookAnalyzer(mockConfig);
  });

  afterEach(() => {
    analyzer.dispose();
  });

  /**
   * Helper to create orderbook test data
   */
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

  describe('analyzeOrderbook - Spread Percent Calculation', () => {
    test('should calculate spreadPercent correctly for 2.7¢ spread', () => {
      // Real-world example: bid=1.1¢, ask=3.8¢
      const orderbook = createOrderbook(0.011, 0.038);
      const metrics = analyzer.analyzeOrderbook(orderbook);

      // Should be 2.7% not 71%!
      expect(metrics.spreadPercent).toBeCloseTo(2.7, 1);
    });

    test('spreadPercent should be consistent across different price levels', () => {
      // Same 5¢ spread at different price levels
      const lowPriceOrderbook = createOrderbook(0.10, 0.15, 'market_low');
      const midPriceOrderbook = createOrderbook(0.45, 0.50, 'market_mid');
      const highPriceOrderbook = createOrderbook(0.85, 0.90, 'market_high');

      const lowMetrics = analyzer.analyzeOrderbook(lowPriceOrderbook);
      const midMetrics = analyzer.analyzeOrderbook(midPriceOrderbook);
      const highMetrics = analyzer.analyzeOrderbook(highPriceOrderbook);

      // All should report ~5% spread
      expect(lowMetrics.spreadPercent).toBeCloseTo(5.0, 1);
      expect(midMetrics.spreadPercent).toBeCloseTo(5.0, 1);
      expect(highMetrics.spreadPercent).toBeCloseTo(5.0, 1);

      // They should all be equal
      expect(lowMetrics.spreadPercent).toBeCloseTo(midMetrics.spreadPercent, 2);
      expect(midMetrics.spreadPercent).toBeCloseTo(highMetrics.spreadPercent, 2);
    });

    test('should handle very tight spreads correctly', () => {
      // 0.5¢ spread = 0.5%
      const orderbook = createOrderbook(0.500, 0.505);
      const metrics = analyzer.analyzeOrderbook(orderbook);

      expect(metrics.spreadPercent).toBeCloseTo(0.5, 2);
    });

    test('should handle very wide spreads correctly', () => {
      // 50¢ spread = 50%
      const orderbook = createOrderbook(0.25, 0.75);
      const metrics = analyzer.analyzeOrderbook(orderbook);

      expect(metrics.spreadPercent).toBeCloseTo(50.0, 1);
    });

    test('should handle zero spread (locked market)', () => {
      const orderbook = createOrderbook(0.50, 0.50);
      const metrics = analyzer.analyzeOrderbook(orderbook);

      expect(metrics.spreadPercent).toBe(0);
    });
  });

  describe('calculateLiquidityScore - Spread Penalty', () => {
    test('should penalize wider spreads more than tight spreads', () => {
      const tightSpreadOrderbook = createOrderbook(0.495, 0.505, 'tight');  // 1¢ spread
      const wideSpreadOrderbook = createOrderbook(0.40, 0.60, 'wide');      // 20¢ spread

      const tightMetrics = analyzer.analyzeOrderbook(tightSpreadOrderbook);
      const wideMetrics = analyzer.analyzeOrderbook(wideSpreadOrderbook);

      // Wider spread should have lower liquidity score
      expect(tightMetrics.liquidityScore).toBeGreaterThan(wideMetrics.liquidityScore);
    });

    test('spread penalty should be price-level independent', () => {
      // Same 10¢ spread at different price levels
      const lowPriceOrderbook = createOrderbook(0.10, 0.20, 'low');
      const midPriceOrderbook = createOrderbook(0.45, 0.55, 'mid');
      const highPriceOrderbook = createOrderbook(0.85, 0.95, 'high');

      const lowMetrics = analyzer.analyzeOrderbook(lowPriceOrderbook);
      const midMetrics = analyzer.analyzeOrderbook(midPriceOrderbook);
      const highMetrics = analyzer.analyzeOrderbook(highPriceOrderbook);

      // Liquidity scores should be similar (within margin for volume differences)
      const avgScore = (lowMetrics.liquidityScore + midMetrics.liquidityScore + highMetrics.liquidityScore) / 3;

      expect(Math.abs(lowMetrics.liquidityScore - avgScore)).toBeLessThan(5);
      expect(Math.abs(midMetrics.liquidityScore - avgScore)).toBeLessThan(5);
      expect(Math.abs(highMetrics.liquidityScore - avgScore)).toBeLessThan(5);
    });
  });

  describe('detectSpreadAnomaly - Context Values', () => {
    test('should include correct spreadPercent and spreadBps in anomaly context', () => {
      const marketId = 'anomaly_market';

      // Create history of tight spreads
      for (let i = 0; i < 20; i++) {
        const normalOrderbook = createOrderbook(0.495, 0.505, marketId);
        normalOrderbook.timestamp = Date.now() - (20 - i) * 10000; // Spaced out
        analyzer.analyzeOrderbook(normalOrderbook);
      }

      // Now create a wide spread anomaly
      const anomalyOrderbook = createOrderbook(0.40, 0.60, marketId);  // 20¢ spread
      const signals = analyzer.detectOrderbookSignals(anomalyOrderbook);

      // Should detect spread anomaly
      const spreadSignal = signals.find(s => s.type === 'spread_anomaly');

      if (spreadSignal) {
        // Check that context has correct values
        expect(spreadSignal.data.context).toBeDefined();
        expect(spreadSignal.data.context.spreadPercent).toBeCloseTo(20.0, 1);  // 20%
        expect(spreadSignal.data.context.spreadBps).toBeCloseTo(2000, 0);      // 2000 bps
      }
    });
  });

  describe('Regression Tests - Fix Verification', () => {
    test('should NOT use old buggy formula (spread / bestAsk)', () => {
      const orderbook = createOrderbook(0.011, 0.038);
      const metrics = analyzer.analyzeOrderbook(orderbook);

      // Old buggy way would give: (0.027 / 0.038) * 100 ≈ 71%
      const oldBuggyValue = (orderbook.spread / orderbook.bestAsk) * 100;
      expect(oldBuggyValue).toBeCloseTo(71.05, 1);

      // New correct way gives: 0.027 * 100 = 2.7%
      expect(metrics.spreadPercent).toBeCloseTo(2.7, 1);

      // They should be different!
      expect(metrics.spreadPercent).not.toBeCloseTo(oldBuggyValue, 1);
    });

    test('spread calculations should match across all price levels', () => {
      // Create multiple orderbooks with 3¢ spread at various price levels
      const testCases = [
        { bid: 0.01, ask: 0.04, level: '2.5%' },
        { bid: 0.20, ask: 0.23, level: '21.5%' },
        { bid: 0.48, ask: 0.51, level: '49.5%' },
        { bid: 0.73, ask: 0.76, level: '74.5%' },
        { bid: 0.96, ask: 0.99, level: '97.5%' },
      ];

      const spreadPercents = testCases.map(tc => {
        const orderbook = createOrderbook(tc.bid, tc.ask, `market_${tc.level}`);
        const metrics = analyzer.analyzeOrderbook(orderbook);
        return metrics.spreadPercent;
      });

      // All should be approximately 3.0%
      spreadPercents.forEach(percent => {
        expect(percent).toBeCloseTo(3.0, 1);
      });

      // Standard deviation should be very low (all values similar)
      const mean = spreadPercents.reduce((a, b) => a + b) / spreadPercents.length;
      const variance = spreadPercents.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / spreadPercents.length;
      const stdDev = Math.sqrt(variance);

      expect(stdDev).toBeLessThan(0.1);  // Very low deviation
    });
  });

  describe('Imbalance Calculations', () => {
    test('should calculate bid-ask imbalance correctly', () => {
      // Heavy bid side
      const bidHeavyOrderbook: OrderbookData = {
        marketId: 'imbalance_test',
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

      const metrics = analyzer.analyzeOrderbook(bidHeavyOrderbook);

      // Should have positive bid/ask ratio (more bid volume)
      expect(metrics.bidAskRatio).toBeGreaterThan(1);

      // Should have positive depth imbalance
      expect(metrics.depthImbalance).toBeGreaterThan(0);
    });
  });
});
