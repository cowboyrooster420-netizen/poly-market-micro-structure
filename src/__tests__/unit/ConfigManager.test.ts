import { ConfigManager, configManager } from '../../config/ConfigManager';
import fs from 'fs';
import path from 'path';

describe('ConfigManager', () => {
  let testConfigPath: string;
  let originalConfigPath: string;

  beforeEach(() => {
    // Setup test config file
    testConfigPath = path.join(__dirname, 'test-config.json');
    originalConfigPath = (configManager as any).configPath;
    (configManager as any).configPath = testConfigPath;
    
    // Clean up any existing test config
    if (fs.existsSync(testConfigPath)) {
      fs.unlinkSync(testConfigPath);
    }
    
    // Reset to balanced preset for consistent testing
    configManager.applyPreset('balanced');
  });

  afterEach(() => {
    // Cleanup test config file
    if (fs.existsSync(testConfigPath)) {
      fs.unlinkSync(testConfigPath);
    }
    
    // Restore original config path
    (configManager as any).configPath = originalConfigPath;
  });

  describe('Configuration Loading and Saving', () => {
    test('should load default configuration when no file exists', () => {
      const config = configManager.getConfig();
      
      expect(config).toHaveProperty('detection');
      expect(config).toHaveProperty('performance');
      expect(config).toHaveProperty('environment');
      expect(config).toHaveProperty('features');
      
      // Check default values
      expect(config.detection.signals.volumeSpike.multiplier).toBe(3.0);
      expect(config.detection.markets.minVolumeThreshold).toBe(10000);
      expect(config.performance.processing.maxConcurrentRequests).toBe(10);
    });

    test('should save configuration to file', () => {
      const config = configManager.getConfig();
      
      // Modify a value
      configManager.updateConfig({
        detection: {
          ...config.detection,
          signals: {
            ...config.detection.signals,
            volumeSpike: {
              ...config.detection.signals.volumeSpike,
              multiplier: 4.0
            }
          }
        }
      });

      // Check file was created and contains the change
      expect(fs.existsSync(testConfigPath)).toBe(true);
      
      const fileContent = fs.readFileSync(testConfigPath, 'utf8');
      const savedConfig = JSON.parse(fileContent);
      expect(savedConfig.detection.signals.volumeSpike.multiplier).toBe(4.0);
    });

    test('should load configuration from existing file', () => {
      // Create a test config file
      const testConfig = {
        detection: {
          signals: {
            volumeSpike: {
              multiplier: 5.0,
              windowMs: 600000,
              minConfidence: 0.8
            },
            priceMovement: {
              percentageThreshold: 15,
              timeWindowMs: 1200000,
              minVolume: 30000
            },
            crossMarketCorrelation: {
              correlationThreshold: 0.8,
              minMarkets: 3,
              zScoreThreshold: 3.0
            }
          },
          microstructure: {
            orderbookImbalance: {
              threshold: 0.4,
              depth: 8,
              minSpreadBps: 20
            },
            liquidityVacuum: {
              depthDropThreshold: 35,
              spreadWidenThreshold: 3.0,
              durationMs: 200000
            },
            frontRunning: {
              scoreThreshold: 0.8,
              volumeWeightThreshold: 0.7,
              spreadImpactThreshold: 2.5
            }
          },
          statistical: {
            anomalyDetection: {
              zScoreThreshold: 3.0,
              mahalanobisThreshold: 3.5,
              isolationForestThreshold: 0.75,
              lookbackPeriods: 144
            },
            trendAnalysis: {
              trendStrengthThreshold: 0.65,
              volatilityThreshold: 0.35,
              stabilityPeriods: 30
            }
          }
        }
      };

      fs.writeFileSync(testConfigPath, JSON.stringify(testConfig, null, 2));
      
      // Force reload
      (configManager as any).loadConfigFromFile();
      
      const loadedConfig = configManager.getConfig();
      expect(loadedConfig.detection.signals.volumeSpike.multiplier).toBe(5.0);
      expect(loadedConfig.detection.signals.priceMovement.percentageThreshold).toBe(15);
    });
  });

  describe('Configuration Validation', () => {
    test('should validate correct configuration', () => {
      const config = configManager.getConfig();
      expect(() => configManager.updateConfig(config)).not.toThrow();
    });

    test('should reject invalid volume spike multiplier', () => {
      expect(() => {
        configManager.updateConfig({
          detection: {
            ...configManager.getDetectionThresholds(),
            signals: {
              ...configManager.getDetectionThresholds().signals,
              volumeSpike: {
                ...configManager.getDetectionThresholds().signals.volumeSpike,
                multiplier: 0.5 // Invalid: below 1.0
              }
            }
          }
        });
      }).toThrow('Configuration validation failed');
    });

    test('should reject invalid correlation threshold', () => {
      expect(() => {
        configManager.updateConfig({
          detection: {
            ...configManager.getDetectionThresholds(),
            signals: {
              ...configManager.getDetectionThresholds().signals,
              crossMarketCorrelation: {
                ...configManager.getDetectionThresholds().signals.crossMarketCorrelation,
                correlationThreshold: 1.5 // Invalid: above 1.0
              }
            }
          }
        });
      }).toThrow('Configuration validation failed');
    });

    test('should reject invalid performance settings', () => {
      expect(() => {
        configManager.updateConfig({
          performance: {
            ...configManager.getPerformanceConfig(),
            processing: {
              ...configManager.getPerformanceConfig().processing,
              maxConcurrentRequests: 0 // Invalid: below 1
            }
          }
        });
      }).toThrow('Configuration validation failed');
    });
  });

  describe('Configuration Presets', () => {
    test('should apply conservative preset correctly', () => {
      configManager.applyPreset('conservative');
      
      const config = configManager.getDetectionThresholds();
      
      expect(config.signals.volumeSpike.multiplier).toBe(5.0);
      expect(config.signals.priceMovement.percentageThreshold).toBe(15);
      expect(config.signals.crossMarketCorrelation.correlationThreshold).toBe(0.8);
      expect(config.statistical.anomalyDetection.zScoreThreshold).toBe(3.5);
    });

    test('should apply aggressive preset correctly', () => {
      configManager.applyPreset('aggressive');
      
      const config = configManager.getDetectionThresholds();
      
      expect(config.signals.volumeSpike.multiplier).toBe(2.0);
      expect(config.signals.priceMovement.percentageThreshold).toBe(5);
      expect(config.signals.crossMarketCorrelation.correlationThreshold).toBe(0.6);
      expect(config.statistical.anomalyDetection.zScoreThreshold).toBe(2.0);
    });

    test('should apply balanced preset correctly', () => {
      configManager.applyPreset('balanced');
      
      const config = configManager.getDetectionThresholds();
      
      expect(config.signals.volumeSpike.multiplier).toBe(3.0);
      expect(config.signals.priceMovement.percentageThreshold).toBe(10);
      expect(config.signals.crossMarketCorrelation.correlationThreshold).toBe(0.7);
      expect(config.statistical.anomalyDetection.zScoreThreshold).toBe(2.5);
    });

    test('should apply development preset correctly', () => {
      configManager.applyPreset('development');
      
      const config = configManager.getDetectionThresholds();
      
      expect(config.signals.volumeSpike.multiplier).toBe(1.5);
      expect(config.signals.priceMovement.percentageThreshold).toBe(3);
      expect(config.signals.crossMarketCorrelation.correlationThreshold).toBe(0.5);
      expect(config.statistical.anomalyDetection.zScoreThreshold).toBe(1.5);
    });
  });

  describe('Change Notifications', () => {
    test('should notify watchers of configuration changes', () => {
      const mockCallback = jest.fn();
      
      configManager.onConfigChange('test_watcher', mockCallback);
      
      configManager.updateConfig({
        detection: {
          ...configManager.getDetectionThresholds(),
          signals: {
            ...configManager.getDetectionThresholds().signals,
            volumeSpike: {
              ...configManager.getDetectionThresholds().signals.volumeSpike,
              multiplier: 3.5
            }
          }
        }
      });

      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          detection: expect.objectContaining({
            signals: expect.objectContaining({
              volumeSpike: expect.objectContaining({
                multiplier: 3.5
              })
            })
          })
        })
      );
      
      configManager.offConfigChange('test_watcher');
    });

    test('should handle watcher errors gracefully', () => {
      const errorCallback = jest.fn(() => {
        throw new Error('Watcher error');
      });
      
      configManager.onConfigChange('error_watcher', errorCallback);
      
      expect(() => {
        configManager.updateConfig({
          detection: {
            ...configManager.getDetectionThresholds(),
            markets: {
              ...configManager.getDetectionThresholds().markets,
              minVolumeThreshold: 15000
            }
          }
        });
      }).not.toThrow();
      
      configManager.offConfigChange('error_watcher');
    });
  });

  describe('Partial Updates', () => {
    test('should update only specified fields', () => {
      const originalConfig = configManager.getConfig();
      const originalMultiplier = originalConfig.detection.signals.volumeSpike.multiplier;
      const originalThreshold = originalConfig.detection.signals.priceMovement.percentageThreshold;
      
      configManager.updateDetectionThresholds({
        signals: {
          volumeSpike: {
            multiplier: 4.0,
            windowMs: originalConfig.detection.signals.volumeSpike.windowMs,
            minConfidence: originalConfig.detection.signals.volumeSpike.minConfidence
          },
          priceMovement: originalConfig.detection.signals.priceMovement,
          crossMarketCorrelation: originalConfig.detection.signals.crossMarketCorrelation
        }
      });

      const updatedConfig = configManager.getConfig();
      
      expect(updatedConfig.detection.signals.volumeSpike.multiplier).toBe(4.0);
      expect(updatedConfig.detection.signals.priceMovement.percentageThreshold).toBe(originalThreshold);
      expect(updatedConfig.performance.processing.maxConcurrentRequests).toBe(originalConfig.performance.processing.maxConcurrentRequests);
    });

    test('should merge nested objects correctly', () => {
      configManager.updateConfig({
        detection: {
          ...configManager.getDetectionThresholds(),
          microstructure: {
            ...configManager.getDetectionThresholds().microstructure,
            orderbookImbalance: {
              ...configManager.getDetectionThresholds().microstructure.orderbookImbalance,
              threshold: 0.25 // Only update threshold
            }
          }
        }
      });

      const config = configManager.getDetectionThresholds();
      
      expect(config.microstructure.orderbookImbalance.threshold).toBe(0.25);
      expect(config.microstructure.orderbookImbalance.depth).toBe(10); // Should remain unchanged
      expect(config.microstructure.liquidityVacuum.depthDropThreshold).toBe(30); // Should remain unchanged
    });
  });

  describe('Export and Import', () => {
    test('should export configuration to specified file', () => {
      const exportPath = path.join(__dirname, 'exported-test-config.json');
      
      try {
        configManager.exportConfig(exportPath);
        
        expect(fs.existsSync(exportPath)).toBe(true);
        
        const exportedContent = fs.readFileSync(exportPath, 'utf8');
        const exportedConfig = JSON.parse(exportedContent);
        
        expect(exportedConfig).toHaveProperty('detection');
        expect(exportedConfig).toHaveProperty('performance');
        expect(exportedConfig).toHaveProperty('environment');
        expect(exportedConfig).toHaveProperty('features');
        
      } finally {
        if (fs.existsSync(exportPath)) {
          fs.unlinkSync(exportPath);
        }
      }
    });

    test('should create directory if it does not exist', () => {
      const exportDir = path.join(__dirname, 'test-export-dir');
      const exportPath = path.join(exportDir, 'config.json');
      
      try {
        configManager.exportConfig(exportPath);
        
        expect(fs.existsSync(exportDir)).toBe(true);
        expect(fs.existsSync(exportPath)).toBe(true);
        
      } finally {
        if (fs.existsSync(exportPath)) {
          fs.unlinkSync(exportPath);
        }
        if (fs.existsSync(exportDir)) {
          fs.rmdirSync(exportDir);
        }
      }
    });
  });

  describe('Configuration Bounds and Limits', () => {
    test('should enforce minimum and maximum values', () => {
      // Test minimum values
      expect(() => {
        configManager.updateConfig({
          detection: {
            ...configManager.getDetectionThresholds(),
            signals: {
              ...configManager.getDetectionThresholds().signals,
              volumeSpike: {
                ...configManager.getDetectionThresholds().signals.volumeSpike,
                windowMs: 30000 // Below minimum of 60000
              }
            }
          }
        });
      }).toThrow();

      // Test maximum values
      expect(() => {
        configManager.updateConfig({
          detection: {
            ...configManager.getDetectionThresholds(),
            signals: {
              ...configManager.getDetectionThresholds().signals,
              crossMarketCorrelation: {
                ...configManager.getDetectionThresholds().signals.crossMarketCorrelation,
                correlationThreshold: 1.5 // Above maximum of 1.0
              }
            }
          }
        });
      }).toThrow();
    });

    test('should enforce logical constraints', () => {
      // Test minimum markets constraint
      expect(() => {
        configManager.updateConfig({
          detection: {
            ...configManager.getDetectionThresholds(),
            signals: {
              ...configManager.getDetectionThresholds().signals,
              crossMarketCorrelation: {
                ...configManager.getDetectionThresholds().signals.crossMarketCorrelation,
                minMarkets: 1 // Below minimum of 2
              }
            }
          }
        });
      }).toThrow();
    });
  });

  describe('Performance Impact', () => {
    test('should handle frequent configuration updates efficiently', () => {
      const startTime = Date.now();
      
      // Perform many updates
      for (let i = 0; i < 100; i++) {
        configManager.updateConfig({
          detection: {
            ...configManager.getDetectionThresholds(),
            signals: {
              ...configManager.getDetectionThresholds().signals,
              volumeSpike: {
                ...configManager.getDetectionThresholds().signals.volumeSpike,
                multiplier: 2.0 + (i * 0.01)
              }
            }
          }
        });
      }
      
      const endTime = Date.now();
      
      // Should complete within reasonable time
      expect(endTime - startTime).toBeLessThan(5000); // 5 seconds
    });

    test('should not leak memory with frequent updates', () => {
      const initialMemory = process.memoryUsage().heapUsed;
      
      // Perform many updates and trigger GC
      for (let i = 0; i < 200; i++) {
        configManager.updateConfig({
          detection: {
            ...configManager.getDetectionThresholds(),
            markets: {
              ...configManager.getDetectionThresholds().markets,
              minVolumeThreshold: 10000 + i
            }
          }
        });
      }
      
      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }
      
      const finalMemory = process.memoryUsage().heapUsed;
      const memoryGrowth = finalMemory - initialMemory;
      
      // Memory growth should be reasonable (less than 10MB)
      expect(memoryGrowth).toBeLessThan(10 * 1024 * 1024);
    });
  });
});