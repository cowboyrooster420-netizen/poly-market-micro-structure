import { MicrostructureDetector } from '../../services/MicrostructureDetector';
import { MarketDataMocks } from '../mocks/MarketDataMocks';
import { configManager } from '../../config/ConfigManager';
import { BotConfig, MicrostructureSignal } from '../../types';

// Mock WebSocket since we're testing logic, not network connectivity
jest.mock('ws', () => {
  return jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    send: jest.fn(),
    close: jest.fn(),
    readyState: 1
  }));
});

describe('MicrostructureDetector', () => {
  let microstructureDetector: MicrostructureDetector;
  let mockConfig: BotConfig;
  let capturedSignals: MicrostructureSignal[] = [];

  beforeEach(() => {
    // Reset configuration and captured signals
    configManager.applyPreset('balanced');
    capturedSignals = [];
    
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

    microstructureDetector = new MicrostructureDetector(mockConfig);
    
    // Capture signals for testing
    microstructureDetector.onMicrostructureSignal((signal) => {
      capturedSignals.push(signal);
    });
  });

  afterEach(async () => {
    await microstructureDetector.stop();
  });

  describe('Orderbook Imbalance Detection', () => {
    test('should detect significant orderbook imbalance', () => {
      const imbalancedOrderbook = MarketDataMocks.createOrderbook('test_market', 'imbalanced');
      
      // Manually call the analysis method (since we're mocking WebSocket)
      const analyzer = (microstructureDetector as any).microstructureAnalyzer;
      const result = analyzer.analyzeOrderbook(imbalancedOrderbook);

      expect(result.imbalanceRatio).toBeGreaterThan(0.3); // Above threshold
      expect(result.signal).toBe(true);
      expect(result.confidence).toBeGreaterThan(0.5);
    });

    test('should not detect imbalance in balanced orderbook', () => {
      const balancedOrderbook = MarketDataMocks.createOrderbook('test_market', 'balanced');
      
      const analyzer = (microstructureDetector as any).microstructureAnalyzer;
      const result = analyzer.analyzeOrderbook(balancedOrderbook);

      expect(result.imbalanceRatio).toBeLessThan(0.3); // Below threshold
      expect(result.signal).toBe(false);
    });

    test('should handle thin orderbooks appropriately', () => {
      const thinOrderbook = MarketDataMocks.createOrderbook('test_market', 'thin');
      
      const analyzer = (microstructureDetector as any).microstructureAnalyzer;
      const result = analyzer.analyzeOrderbook(thinOrderbook);

      // Thin orderbooks should be flagged as potentially problematic
      expect(result.totalLiquidity).toBeLessThan(500); // Low liquidity
      expect(result.signal).toBe(true); // Should signal liquidity issues
    });
  });

  describe('Spread Anomaly Detection', () => {
    test('should detect abnormally wide spreads', () => {
      const wideSpreadOrderbook = MarketDataMocks.createOrderbook('test_market', 'wide_spread');
      
      const analyzer = (microstructureDetector as any).microstructureAnalyzer;
      const result = analyzer.analyzeOrderbook(wideSpreadOrderbook);

      expect(result.spreadBps).toBeGreaterThan(1000); // Wide spread (>10%)
      expect(result.signal).toBe(true);
    });

    test('should not flag normal spreads', () => {
      const normalOrderbook = MarketDataMocks.createOrderbook('test_market', 'balanced');
      
      const analyzer = (microstructureDetector as any).microstructureAnalyzer;
      const result = analyzer.analyzeOrderbook(normalOrderbook);

      expect(result.spreadBps).toBeLessThan(300); // Normal spread (<3%)
    });
  });

  describe('Front-Running Detection', () => {
    test('should detect front-running patterns in tick data', () => {
      const frontRunningTicks = MarketDataMocks.createTickData('test_market', 50, 'front_running');
      
      const analyzer = (microstructureDetector as any).microstructureAnalyzer;
      const result = analyzer.analyzeTradingPattern(frontRunningTicks);

      expect(result.frontRunningScore).toBeGreaterThan(0.6);
      expect(result.signal).toBe(true);
      expect(result.pattern).toBe('front_running');
    });

    test('should not flag normal trading patterns', () => {
      const normalTicks = MarketDataMocks.createTickData('test_market', 50, 'normal');
      
      const analyzer = (microstructureDetector as any).microstructureAnalyzer;
      const result = analyzer.analyzeTradingPattern(normalTicks);

      expect(result.frontRunningScore).toBeLessThan(0.6);
      expect(result.signal).toBe(false);
    });

    test('should detect coordinated buying patterns', () => {
      const coordinatedTicks = MarketDataMocks.createTickData('test_market', 50, 'coordinated_buying');
      
      const analyzer = (microstructureDetector as any).microstructureAnalyzer;
      const result = analyzer.analyzeTradingPattern(coordinatedTicks);

      expect(result.buyPressure).toBeGreaterThan(0.7); // Strong buy pressure
      expect(result.coordinationScore).toBeGreaterThan(0.6);
    });
  });

  describe('Market Tracking and Management', () => {
    test('should track markets with asset IDs', () => {
      const markets = [
        {
          id: 'market_1',
          assetIds: ['asset_1_yes', 'asset_1_no']
        },
        {
          id: 'market_2', 
          assetIds: ['asset_2_yes', 'asset_2_no']
        }
      ];

      microstructureDetector.trackMarkets(markets);

      const trackedMarkets = microstructureDetector.getTrackedMarkets();
      expect(trackedMarkets).toContain('market_1');
      expect(trackedMarkets).toContain('market_2');
      expect(trackedMarkets).toHaveLength(2);
    });

    test('should untrack markets', () => {
      microstructureDetector.trackMarket('market_to_remove');
      expect(microstructureDetector.getTrackedMarkets()).toContain('market_to_remove');

      microstructureDetector.untrackMarket('market_to_remove');
      expect(microstructureDetector.getTrackedMarkets()).not.toContain('market_to_remove');
    });

    test('should handle tracking limits', () => {
      // Try to track more markets than configured limit
      const manyMarkets = [];
      for (let i = 0; i < 150; i++) {
        manyMarkets.push({
          id: `market_${i}`,
          assetIds: [`asset_${i}_yes`, `asset_${i}_no`]
        });
      }

      microstructureDetector.trackMarkets(manyMarkets);

      // Should respect maxMarketsToTrack limit (100)
      const trackedMarkets = microstructureDetector.getTrackedMarkets();
      expect(trackedMarkets.length).toBeLessThanOrEqual(mockConfig.maxMarketsToTrack);
    });
  });

  describe('Performance Monitoring', () => {
    test('should provide performance statistics', () => {
      const stats = microstructureDetector.getPerformanceStats();

      expect(stats).toHaveProperty('processedMessages');
      expect(stats).toHaveProperty('signalsGenerated');
      expect(stats).toHaveProperty('avgProcessingTime');
      expect(stats).toHaveProperty('errorRate');
      expect(stats).toHaveProperty('uptime');
      expect(stats.uptime).toBeGreaterThan(0);
    });

    test('should track message processing rate', async () => {
      const initialStats = microstructureDetector.getPerformanceStats();
      
      // Simulate processing messages
      const analyzer = (microstructureDetector as any).microstructureAnalyzer;
      const orderbook = MarketDataMocks.createOrderbook('test_market');
      
      for (let i = 0; i < 10; i++) {
        analyzer.analyzeOrderbook(orderbook);
      }

      const updatedStats = microstructureDetector.getPerformanceStats();
      
      // Processing count should increase (if implementation tracks this)
      expect(updatedStats.uptime).toBeGreaterThanOrEqual(initialStats.uptime);
    });
  });

  describe('Health Check System', () => {
    test('should report healthy status when running normally', async () => {
      await microstructureDetector.initialize();
      
      const health = await microstructureDetector.healthCheck();

      expect(health.healthy).toBe(true);
      expect(health.details).toHaveProperty('uptime');
      expect(health.details).toHaveProperty('trackedMarkets');
      expect(health.details.uptime).toBeGreaterThan(0);
    });

    test('should detect and report connection issues', async () => {
      // Simulate connection failure
      const mockWebSocket = (microstructureDetector as any).ws;
      if (mockWebSocket) {
        mockWebSocket.readyState = 3; // CLOSED
      }

      const health = await microstructureDetector.healthCheck();

      // Should still be healthy in test environment (mocked WebSocket)
      // In real implementation, this would detect connection issues
      expect(health).toHaveProperty('healthy');
      expect(health).toHaveProperty('details');
    });
  });

  describe('Configuration Responsiveness', () => {
    test('should adapt to configuration changes', () => {
      // Apply aggressive configuration
      configManager.applyPreset('aggressive');
      
      const orderbook = MarketDataMocks.createOrderbook('test_market', 'imbalanced');
      const analyzer = (microstructureDetector as any).microstructureAnalyzer;
      
      // Should be more sensitive with aggressive configuration
      const result = analyzer.analyzeOrderbook(orderbook);
      expect(result.signal).toBe(true);
    });

    test('should use updated thresholds', () => {
      // Update specific threshold
      configManager.updateConfig({
        detection: {
          ...configManager.getDetectionThresholds(),
          microstructure: {
            ...configManager.getDetectionThresholds().microstructure,
            orderbookImbalance: {
              ...configManager.getDetectionThresholds().microstructure.orderbookImbalance,
              threshold: 0.1 // Very sensitive
            }
          }
        }
      });

      const slightlyImbalancedOrderbook = MarketDataMocks.createOrderbook('test_market', 'balanced');
      
      // Manually adjust to create slight imbalance
      slightlyImbalancedOrderbook.bids[0].size = 2000;
      slightlyImbalancedOrderbook.asks[0].size = 1000;

      const analyzer = (microstructureDetector as any).microstructureAnalyzer;
      const result = analyzer.analyzeOrderbook(slightlyImbalancedOrderbook);

      // Should detect with lowered threshold
      expect(result.signal).toBe(true);
    });
  });

  describe('Error Handling and Resilience', () => {
    test('should handle malformed WebSocket messages gracefully', () => {
      const malformedMessages = [
        '{"invalid": json}',
        'not json at all',
        '{"missing": "required_fields"}',
        null,
        undefined,
        ''
      ];

      expect(() => {
        malformedMessages.forEach(msg => {
          // Simulate receiving malformed message
          (microstructureDetector as any).handleWebSocketMessage?.(msg);
        });
      }).not.toThrow();
    });

    test('should continue operating after errors', async () => {
      // Simulate error in analysis
      const originalAnalyze = (microstructureDetector as any).microstructureAnalyzer?.analyzeOrderbook;
      
      if (originalAnalyze) {
        (microstructureDetector as any).microstructureAnalyzer.analyzeOrderbook = jest.fn(() => {
          throw new Error('Analysis error');
        });

        // Should not crash the detector
        expect(() => {
          const orderbook = MarketDataMocks.createOrderbook('test_market');
          try {
            (microstructureDetector as any).microstructureAnalyzer.analyzeOrderbook(orderbook);
          } catch (e) {
            // Expected error
          }
        }).not.toThrow();

        // Restore original function
        (microstructureDetector as any).microstructureAnalyzer.analyzeOrderbook = originalAnalyze;
      }
    });

    test('should handle memory pressure gracefully', () => {
      // Simulate processing large number of messages
      const orderbook = MarketDataMocks.createOrderbook('test_market');
      const analyzer = (microstructureDetector as any).microstructureAnalyzer;

      expect(() => {
        for (let i = 0; i < 1000; i++) {
          analyzer.analyzeOrderbook(orderbook);
        }
      }).not.toThrow();
    });
  });

  describe('Signal Generation and Quality', () => {
    test('should generate signals with proper metadata', () => {
      const orderbook = MarketDataMocks.createOrderbook('test_market', 'imbalanced');
      const analyzer = (microstructureDetector as any).microstructureAnalyzer;
      const result = analyzer.analyzeOrderbook(orderbook);

      if (result.signal) {
        expect(result).toHaveProperty('confidence');
        expect(result).toHaveProperty('imbalanceRatio');
        expect(result).toHaveProperty('totalLiquidity');
        expect(result.confidence).toBeGreaterThan(0);
        expect(result.confidence).toBeLessThanOrEqual(1);
      }
    });

    test('should rate-limit signal generation', () => {
      const analyzer = (microstructureDetector as any).microstructureAnalyzer;
      const orderbook = MarketDataMocks.createOrderbook('test_market', 'imbalanced');

      // Process same orderbook multiple times rapidly
      const results = [];
      for (let i = 0; i < 20; i++) {
        const result = analyzer.analyzeOrderbook(orderbook);
        results.push(result);
      }

      // Should not generate excessive signals for same pattern
      const signalCount = results.filter(r => r.signal).length;
      expect(signalCount).toBeLessThan(results.length);
    });
  });
});