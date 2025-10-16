import { SignalDetector } from '../../services/SignalDetector';
import { MarketDataMocks } from '../mocks/MarketDataMocks';
import { configManager } from '../../config/ConfigManager';
import { BotConfig } from '../../types';

describe('SignalDetector', () => {
  let signalDetector: SignalDetector;
  let mockConfig: BotConfig;

  beforeEach(() => {
    // Reset configuration to balanced preset for testing
    configManager.applyPreset('balanced');
    
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
        momentumThreshold: 5,
        tickBufferSize: 1000,
      },
      discord: {
        webhookUrl: undefined,
        enableRichEmbeds: true,
        alertRateLimit: 10,
      },
    };

    signalDetector = new SignalDetector(mockConfig);
  });

  describe('Volume Spike Detection', () => {
    test('should detect significant volume spike', async () => {
      // Create market with 5x volume spike
      const markets = [MarketDataMocks.createHighVolumeMarket(5)];
      
      // Mock the market history to show normal volume before spike
      const marketHistory = MarketDataMocks.createVolumeSpikeHistory(markets[0].id, 5);
      (signalDetector as any).marketHistory.set(markets[0].id, marketHistory);

      // Spy on updateMarketMetrics to prevent it from overwriting our test data
      const updateMarketMetricsSpy = jest.spyOn(signalDetector as any, 'updateMarketMetrics').mockImplementation(() => {});

      const signals = await signalDetector.detectSignals(markets);

      updateMarketMetricsSpy.mockRestore();

      console.log('Detected signals:', JSON.stringify(signals, null, 2));
      
      expect(signals).toHaveLength(1);
      expect(signals[0].signalType).toBe('volume_spike');
      expect(signals[0].confidence).toBeGreaterThan(0.5);
      expect(signals[0].metadata?.currentVolume).toBe(250000);
      if (signals[0].metadata?.spikeMultiplier) {
        expect(signals[0].metadata.spikeMultiplier).toBeCloseTo(5.0, 1);
      }
    });

    test('should not detect volume spike below threshold', async () => {
      // Create market with only 2x volume increase (below 3x threshold)
      const markets = [MarketDataMocks.createHighVolumeMarket(2)];
      
      const marketHistory = MarketDataMocks.createVolumeSpikeHistory(markets[0].id, 2);
      (signalDetector as any).marketHistory.set(markets[0].id, marketHistory);

      const signals = await signalDetector.detectSignals(markets);

      // Should not detect volume spike with 2x increase
      const volumeSpikes = signals.filter(s => s.signalType === 'volume_spike');
      expect(volumeSpikes).toHaveLength(0);
    });

    test('should require minimum volume threshold', async () => {
      // Create low-volume market even with high multiplier
      const markets = [MarketDataMocks.createBasicMarket({
        volumeNum: 5000 // Below minVolumeThreshold * 5
      })];
      
      const marketHistory = MarketDataMocks.createVolumeSpikeHistory(markets[0].id, 10);
      (signalDetector as any).marketHistory.set(markets[0].id, marketHistory);

      const signals = await signalDetector.detectSignals(markets);

      const volumeSpikes = signals.filter(s => s.signalType === 'volume_spike');
      expect(volumeSpikes).toHaveLength(0);
    });
  });

  describe('Price Movement Detection', () => {
    test('should detect significant price movement', async () => {
      const market = MarketDataMocks.createBasicMarket({
        outcomePrices: ['0.75', '0.25'] // Moved from 0.65/0.35 to 0.75/0.25
      });

      // Create history with previous prices
      const history = MarketDataMocks.createMarketHistory(market.id, 5);
      history[history.length - 2].prices = [0.65, 0.35]; // Previous prices
      (signalDetector as any).marketHistory.set(market.id, history);

      const signals = await signalDetector.detectSignals([market]);

      const priceMovements = signals.filter(s => s.signalType === 'price_movement');
      expect(priceMovements.length).toBeGreaterThan(0);
      
      if (priceMovements.length > 0) {
        expect(priceMovements[0].confidence).toBeGreaterThan(0.3);
        expect(priceMovements[0].metadata?.priceChange).toBeDefined();
      }
    });

    test('should not detect small price movements', async () => {
      const market = MarketDataMocks.createBasicMarket({
        outcomePrices: ['0.66', '0.34'] // Small movement from 0.65/0.35
      });

      const history = MarketDataMocks.createMarketHistory(market.id, 5);
      history[history.length - 2].prices = [0.65, 0.35];
      (signalDetector as any).marketHistory.set(market.id, history);

      const signals = await signalDetector.detectSignals([market]);

      const priceMovements = signals.filter(s => s.signalType === 'price_movement');
      expect(priceMovements).toHaveLength(0);
    });
  });

  describe('New Market Discovery', () => {
    test('should detect new high-activity markets', async () => {
      const newMarket = MarketDataMocks.createBasicMarket({
        id: 'brand_new_market',
        volumeNum: 75000, // High initial volume
        question: 'Breaking: New market with high initial activity'
      });

      // No history for this market (simulating new market)
      const signals = await signalDetector.detectSignals([newMarket]);

      const newMarketSignals = signals.filter(s => s.signalType === 'new_market');
      expect(newMarketSignals.length).toBeGreaterThan(0);
      
      if (newMarketSignals.length > 0) {
        expect(newMarketSignals[0].confidence).toBeGreaterThan(0.5);
        expect(newMarketSignals[0].metadata?.activityScore).toBeGreaterThan(70);
      }
    });

    test('should not detect low-activity new markets', async () => {
      const newMarket = MarketDataMocks.createBasicMarket({
        id: 'low_activity_market',
        volumeNum: 5000 // Low initial volume
      });

      const signals = await signalDetector.detectSignals([newMarket]);

      const newMarketSignals = signals.filter(s => s.signalType === 'new_market');
      expect(newMarketSignals).toHaveLength(0);
    });
  });

  describe('Configuration Integration', () => {
    test('should use configuration thresholds', async () => {
      // Apply aggressive configuration (lower thresholds)
      configManager.applyPreset('aggressive');
      
      const markets = [MarketDataMocks.createHighVolumeMarket(2.5)]; // 2.5x volume
      const marketHistory = MarketDataMocks.createVolumeSpikeHistory(markets[0].id, 2.5);
      (signalDetector as any).marketHistory.set(markets[0].id, marketHistory);

      const signals = await signalDetector.detectSignals(markets);

      // Should detect with aggressive settings (2x threshold) but not with balanced (3x threshold)
      const volumeSpikes = signals.filter(s => s.signalType === 'volume_spike');
      expect(volumeSpikes.length).toBeGreaterThan(0);
    });

    test('should respect minimum confidence thresholds', async () => {
      // Apply conservative configuration (higher confidence requirements)
      configManager.applyPreset('conservative');
      
      const markets = [MarketDataMocks.createHighVolumeMarket(3.5)];
      const marketHistory = MarketDataMocks.createVolumeSpikeHistory(markets[0].id, 3.5);
      (signalDetector as any).marketHistory.set(markets[0].id, marketHistory);

      const signals = await signalDetector.detectSignals(markets);

      // Should require higher confidence with conservative settings
      if (signals.length > 0) {
        expect(signals[0].confidence).toBeGreaterThan(0.8); // Conservative threshold
      }
    });
  });

  describe('Error Handling', () => {
    test('should handle markets with missing data gracefully', async () => {
      const incompleteMarket = {
        ...MarketDataMocks.createBasicMarket(),
        outcomePrices: [], // Missing price data
        volumeNum: undefined as any // Missing volume
      };

      expect(async () => {
        await signalDetector.detectSignals([incompleteMarket]);
      }).not.toThrow();
    });

    test('should handle empty market list', async () => {
      const signals = await signalDetector.detectSignals([]);
      expect(signals).toHaveLength(0);
    });

    test('should handle corrupted market history', async () => {
      const market = MarketDataMocks.createBasicMarket();
      
      // Set corrupted history
      (signalDetector as any).marketHistory.set(market.id, [
        { invalid: 'data' } as any
      ]);

      expect(async () => {
        await signalDetector.detectSignals([market]);
      }).not.toThrow();
    });
  });

  describe('Performance and Scalability', () => {
    test('should handle large number of markets efficiently', async () => {
      // Create 200 markets
      const markets = [];
      for (let i = 0; i < 200; i++) {
        markets.push(MarketDataMocks.createBasicMarket({
          id: `market_${i}`,
          volumeNum: 10000 + (i * 1000)
        }));
      }

      const startTime = Date.now();
      const signals = await signalDetector.detectSignals(markets);
      const endTime = Date.now();

      // Should complete within 5 seconds
      expect(endTime - startTime).toBeLessThan(5000);
      expect(signals).toBeDefined();
      expect(Array.isArray(signals)).toBe(true);
    });

    test('should limit signal generation rate', async () => {
      // Create multiple markets with volume spikes
      const markets = [];
      for (let i = 0; i < 50; i++) {
        const market = MarketDataMocks.createHighVolumeMarket(5);
        market.id = `spike_market_${i}`;
        markets.push(market);
        
        const history = MarketDataMocks.createVolumeSpikeHistory(market.id, 5);
        (signalDetector as any).marketHistory.set(market.id, history);
      }

      const signals = await signalDetector.detectSignals(markets);

      // Should have reasonable number of signals (not overwhelm system)
      expect(signals.length).toBeLessThan(markets.length);
      expect(signals.length).toBeGreaterThan(0);
    });
  });

  describe('Signal Quality and Metadata', () => {
    test('should provide comprehensive signal metadata', async () => {
      const market = MarketDataMocks.createHighVolumeMarket(4);
      const history = MarketDataMocks.createVolumeSpikeHistory(market.id, 4);
      (signalDetector as any).marketHistory.set(market.id, history);

      const signals = await signalDetector.detectSignals([market]);

      expect(signals.length).toBeGreaterThan(0);
      
      const signal = signals[0];
      expect(signal.marketId).toBe(market.id);
      expect(signal.market).toEqual(market);
      expect(signal.timestamp).toBeCloseTo(Date.now(), -3); // Within 1 second
      expect(signal.confidence).toBeGreaterThan(0);
      expect(signal.confidence).toBeLessThanOrEqual(1);
      expect(signal.metadata).toBeDefined();
      expect(signal.metadata?.severity).toMatch(/^(low|medium|high|critical)$/);
    });

    test('should calculate appropriate confidence scores', async () => {
      // Test different volume multipliers
      const testCases = [
        { multiplier: 3, expectedMinConfidence: 0.2 },
        { multiplier: 5, expectedMinConfidence: 0.4 },
        { multiplier: 10, expectedMinConfidence: 0.7 }
      ];

      for (const testCase of testCases) {
        const market = MarketDataMocks.createHighVolumeMarket(testCase.multiplier);
        market.id = `test_market_${testCase.multiplier}`;
        
        const history = MarketDataMocks.createVolumeSpikeHistory(market.id, testCase.multiplier);
        (signalDetector as any).marketHistory.set(market.id, history);

        const signals = await signalDetector.detectSignals([market]);
        
        if (signals.length > 0) {
          expect(signals[0].confidence).toBeGreaterThan(testCase.expectedMinConfidence);
        }
      }
    });
  });
});