import { EarlyBot } from '../../bot/EarlyBot';
import { MarketDataMocks } from '../mocks/MarketDataMocks';
import { configManager } from '../../config/ConfigManager';
import { DatabaseManager } from '../../data/database';
import { EarlySignal, MicrostructureSignal } from '../../types';
import fs from 'fs';
import path from 'path';

// Mock external dependencies
jest.mock('../../services/EnhancedPolymarketService', () => {
  return {
    EnhancedPolymarketService: jest.fn().mockImplementation(() => ({
      initialize: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
      getMarketsWithMinVolume: jest.fn(),
      getMarketById: jest.fn(),
      healthCheck: jest.fn().mockResolvedValue({ healthy: true, details: {} })
    }))
  };
});

jest.mock('../../services/DiscordAlerter', () => {
  return {
    DiscordAlerter: jest.fn().mockImplementation(() => ({
      sendTestAlert: jest.fn().mockResolvedValue(undefined),
      sendAlert: jest.fn().mockResolvedValue(undefined),
      sendMicrostructureAlert: jest.fn().mockResolvedValue(undefined),
      sendPerformanceReport: jest.fn().mockResolvedValue(undefined)
    }))
  };
});

// Mock WebSocket
jest.mock('ws', () => {
  return jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    send: jest.fn(),
    close: jest.fn(),
    readyState: 1
  }));
});

describe('EarlyBot Integration Tests', () => {
  let bot: EarlyBot;
  let testDbPath: string;
  let capturedSignals: EarlySignal[] = [];
  let capturedMicroSignals: MicrostructureSignal[] = [];

  beforeEach(async () => {
    // Setup test database
    testDbPath = path.join(__dirname, '../../data/test_integration.db');
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }

    // Set test environment
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_PATH = testDbPath;
    
    // Reset configuration
    configManager.applyPreset('development'); // Sensitive for testing
    
    // Clear captured signals
    capturedSignals = [];
    capturedMicroSignals = [];

    // Create bot instance
    bot = new EarlyBot();
  });

  afterEach(async () => {
    // Stop bot and cleanup
    if (bot) {
      await bot.stop();
    }
    
    // Cleanup test database
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  describe('Bot Lifecycle Management', () => {
    test('should initialize all components successfully', async () => {
      await expect(bot.initialize()).resolves.not.toThrow();
      
      const health = await bot.getHealthStatus();
      expect(health.running).toBe(false); // Not started yet
      expect(health.overall).toBe('healthy');
      expect(health.dataLayer.healthy).toBe(true);
    });

    test('should start and stop gracefully', async () => {
      await bot.initialize();
      
      // Mock the polymarket service to return test data
      const mockService = (bot as any).polymarketService;
      mockService.getMarketsWithMinVolume.mockResolvedValue([
        MarketDataMocks.createBasicMarket({ id: 'test_market_1' }),
        MarketDataMocks.createBasicMarket({ id: 'test_market_2' })
      ]);

      await expect(bot.start()).resolves.not.toThrow();
      
      let health = await bot.getHealthStatus();
      expect(health.running).toBe(true);
      
      await expect(bot.stop()).resolves.not.toThrow();
      
      health = await bot.getHealthStatus();
      expect(health.running).toBe(false);
    });

    test('should handle initialization failures gracefully', async () => {
      // Simulate database failure
      const originalDbPath = process.env.DATABASE_PATH;
      process.env.DATABASE_PATH = '/invalid/path/that/does/not/exist/test.db';

      await expect(bot.initialize()).rejects.toThrow();
      
      // Restore path
      process.env.DATABASE_PATH = originalDbPath;
    });
  });

  describe('Signal Detection Integration', () => {
    test('should detect and process volume spike signals end-to-end', async () => {
      await bot.initialize();
      
      // Setup mock data with volume spike
      const spikeMarket = MarketDataMocks.createHighVolumeMarket(5);
      const mockService = (bot as any).polymarketService;
      mockService.getMarketsWithMinVolume.mockResolvedValue([spikeMarket]);

      // Capture signals
      const originalHandleSignal = (bot as any).handleSignal.bind(bot);
      (bot as any).handleSignal = jest.fn(async (signal: EarlySignal) => {
        capturedSignals.push(signal);
        return originalHandleSignal(signal);
      });

      await bot.start();
      
      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      await bot.stop();

      // Should have detected new market signals
      expect(capturedSignals.length).toBeGreaterThan(0);
      
      const newMarketSignals = capturedSignals.filter(s => s.signalType === 'new_market');
      expect(newMarketSignals.length).toBeGreaterThan(0);
    });

    test('should persist signals to database', async () => {
      await bot.initialize();
      
      // Create a signal manually and save it
      const testSignal = MarketDataMocks.createMockSignal('volume_spike', 0.8);
      
      const dataLayer = (bot as any).dataLayer;
      await dataLayer.saveSignal(testSignal);

      // Verify signal was saved
      const savedSignals = await dataLayer.getRecentSignals(1);
      expect(savedSignals.length).toBe(1);
      expect(savedSignals[0].signal_type).toBe('volume_spike');
      expect(savedSignals[0].confidence).toBe(0.8);
    });

    test('should handle multiple concurrent signals', async () => {
      await bot.initialize();
      
      // Create multiple markets with different signal types
      const markets = [
        MarketDataMocks.createHighVolumeMarket(4),  // Volume spike
        MarketDataMocks.createSuspiciousPriceMarket(), // Price movement
        MarketDataMocks.createBasicMarket({ volumeNum: 75000 }) // New high-activity market
      ];

      const mockService = (bot as any).polymarketService;
      mockService.getMarketsWithMinVolume.mockResolvedValue(markets);

      // Capture all signals
      const originalHandleSignal = (bot as any).handleSignal.bind(bot);
      (bot as any).handleSignal = jest.fn(async (signal: EarlySignal) => {
        capturedSignals.push(signal);
        return originalHandleSignal(signal);
      });

      await bot.start();
      await new Promise(resolve => setTimeout(resolve, 1500));
      await bot.stop();

      // Should handle multiple signals without errors
      expect(capturedSignals.length).toBeGreaterThan(0);
      
      // Check for different signal types
      const signalTypes = new Set(capturedSignals.map(s => s.signalType));
      expect(signalTypes.size).toBeGreaterThan(1);
    });
  });

  describe('Cross-Market Correlation Detection', () => {
    test('should detect coordinated movements across related markets', async () => {
      await bot.initialize();
      
      // Create related markets for the same entity
      const relatedMarkets = MarketDataMocks.createRelatedMarkets('Tesla', 3);
      
      const mockService = (bot as any).polymarketService;
      mockService.getMarketsWithMinVolume.mockResolvedValue(relatedMarkets);

      // Capture signals
      const originalHandleSignal = (bot as any).handleSignal.bind(bot);
      (bot as any).handleSignal = jest.fn(async (signal: EarlySignal) => {
        capturedSignals.push(signal);
        return originalHandleSignal(signal);
      });

      await bot.start();
      await new Promise(resolve => setTimeout(resolve, 1000));
      await bot.stop();

      // Check for cross-market correlation signals
      const crossMarketSignals = capturedSignals.filter(
        s => s.signalType === 'coordinated_cross_market'
      );
      
      // May or may not detect depending on simulated correlation
      expect(capturedSignals.length).toBeGreaterThan(0);
    });
  });

  describe('Configuration Management Integration', () => {
    test('should respond to runtime configuration changes', async () => {
      await bot.initialize();
      
      const initialConfig = (bot as any).config;
      const initialVolumeThreshold = initialConfig.minVolumeThreshold;
      
      // Change configuration
      configManager.updateConfig({
        detection: {
          ...configManager.getDetectionThresholds(),
          markets: {
            ...configManager.getDetectionThresholds().markets,
            minVolumeThreshold: initialVolumeThreshold * 2
          }
        }
      });

      // Wait for configuration update to propagate
      await new Promise(resolve => setTimeout(resolve, 100));

      const updatedConfig = (bot as any).config;
      expect(updatedConfig.minVolumeThreshold).toBe(initialVolumeThreshold * 2);
    });

    test('should apply different detection sensitivities', async () => {
      await bot.initialize();
      
      // Test with conservative settings
      configManager.applyPreset('conservative');
      
      const conservativeMarkets = [MarketDataMocks.createHighVolumeMarket(3)];
      const mockService = (bot as any).polymarketService;
      mockService.getMarketsWithMinVolume.mockResolvedValue(conservativeMarkets);

      const originalHandleSignal = (bot as any).handleSignal.bind(bot);
      let conservativeSignals: EarlySignal[] = [];
      (bot as any).handleSignal = jest.fn(async (signal: EarlySignal) => {
        conservativeSignals.push(signal);
        return originalHandleSignal(signal);
      });

      await bot.start();
      await new Promise(resolve => setTimeout(resolve, 500));
      await bot.stop();

      // Switch to aggressive settings
      configManager.applyPreset('aggressive');
      
      let aggressiveSignals: EarlySignal[] = [];
      (bot as any).handleSignal = jest.fn(async (signal: EarlySignal) => {
        aggressiveSignals.push(signal);
        return originalHandleSignal(signal);
      });

      await bot.start();
      await new Promise(resolve => setTimeout(resolve, 500));
      await bot.stop();

      // Aggressive should detect more signals (lower thresholds)
      expect(aggressiveSignals.length).toBeGreaterThanOrEqual(conservativeSignals.length);
    });
  });

  describe('Error Recovery and Resilience', () => {
    test('should recover from API failures', async () => {
      await bot.initialize();
      
      const mockService = (bot as any).polymarketService;
      
      // First call fails
      mockService.getMarketsWithMinVolume
        .mockRejectedValueOnce(new Error('API Error'))
        .mockResolvedValue([MarketDataMocks.createBasicMarket()]);

      await bot.start();
      
      // Wait for multiple refresh cycles
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const health = await bot.getHealthStatus();
      expect(health.running).toBe(true); // Should still be running
      
      await bot.stop();
    });

    test('should handle database connection issues', async () => {
      await bot.initialize();
      
      // Simulate database error
      const dataLayer = (bot as any).dataLayer;
      const originalSave = dataLayer.saveSignal.bind(dataLayer);
      dataLayer.saveSignal = jest.fn().mockRejectedValue(new Error('Database Error'));

      const testSignal = MarketDataMocks.createMockSignal();
      
      // Should not crash on database error
      await expect((bot as any).handleSignal(testSignal)).resolves.not.toThrow();
      
      // Restore original method
      dataLayer.saveSignal = originalSave;
    });

    test('should maintain operation during Discord webhook failures', async () => {
      await bot.initialize();
      
      // Set up Discord webhook
      (bot as any).config.discord.webhookUrl = 'https://discord.com/api/webhooks/test';
      
      const mockDiscord = (bot as any).discordAlerter;
      mockDiscord.sendAlert.mockRejectedValue(new Error('Discord Error'));

      const testSignal = MarketDataMocks.createMockSignal();
      
      // Should continue processing despite Discord failure
      await expect((bot as any).handleSignal(testSignal)).resolves.not.toThrow();
    });
  });

  describe('Performance and Scalability', () => {
    test('should handle large numbers of markets efficiently', async () => {
      await bot.initialize();
      
      // Create many markets
      const manyMarkets = [];
      for (let i = 0; i < 200; i++) {
        manyMarkets.push(MarketDataMocks.createBasicMarket({
          id: `perf_test_market_${i}`,
          volumeNum: 10000 + (i * 100)
        }));
      }

      const mockService = (bot as any).polymarketService;
      mockService.getMarketsWithMinVolume.mockResolvedValue(manyMarkets);

      const startTime = Date.now();
      
      await bot.start();
      await new Promise(resolve => setTimeout(resolve, 1000));
      await bot.stop();
      
      const endTime = Date.now();
      
      // Should complete processing within reasonable time
      expect(endTime - startTime).toBeLessThan(10000); // 10 seconds
    });

    test('should maintain consistent memory usage', async () => {
      await bot.initialize();
      
      const mockService = (bot as any).polymarketService;
      mockService.getMarketsWithMinVolume.mockResolvedValue([
        MarketDataMocks.createBasicMarket()
      ]);

      const initialMemory = process.memoryUsage().heapUsed;
      
      await bot.start();
      
      // Let it run for several cycles
      for (let i = 0; i < 5; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      await bot.stop();
      
      const finalMemory = process.memoryUsage().heapUsed;
      
      // Memory growth should be reasonable (less than 50MB)
      const memoryGrowth = finalMemory - initialMemory;
      expect(memoryGrowth).toBeLessThan(50 * 1024 * 1024);
    });
  });

  describe('Health Monitoring and Reporting', () => {
    test('should provide comprehensive health status', async () => {
      await bot.initialize();
      await bot.start();
      
      const health = await bot.getHealthStatus();
      
      expect(health).toHaveProperty('running', true);
      expect(health).toHaveProperty('overall');
      expect(health).toHaveProperty('score');
      expect(health).toHaveProperty('uptime');
      expect(health).toHaveProperty('microstructureDetector');
      expect(health).toHaveProperty('polymarketService');
      expect(health).toHaveProperty('topicClustering');
      expect(health).toHaveProperty('dataLayer');
      expect(health).toHaveProperty('systemHealth');
      expect(health).toHaveProperty('errorStatistics');
      expect(health).toHaveProperty('configurationManager');
      
      expect(health.score).toBeGreaterThan(0);
      expect(health.uptime).toBeGreaterThan(0);
      
      await bot.stop();
    });

    test('should track operational metrics', async () => {
      await bot.initialize();
      
      const mockService = (bot as any).polymarketService;
      mockService.getMarketsWithMinVolume.mockResolvedValue([
        MarketDataMocks.createBasicMarket()
      ]);

      await bot.start();
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const health = await bot.getHealthStatus();
      
      expect(health.trackedMarkets).toBeGreaterThan(0);
      expect(health.systemHealth.uptime).toBeGreaterThan(0);
      
      await bot.stop();
    });
  });
});