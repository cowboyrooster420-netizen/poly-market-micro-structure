import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import { advancedLogger } from '../utils/AdvancedLogger';

export interface DetectionThresholds {
  // Signal Detection Thresholds
  signals: {
    volumeSpike: {
      multiplier: number;          // Volume spike threshold (e.g., 3x average)
      windowMs: number;            // Time window for volume comparison
      minConfidence: number;       // Minimum confidence to trigger alert
    };
    priceMovement: {
      percentageThreshold: number; // Price movement threshold percentage
      timeWindowMs: number;        // Time window for price movement
      minVolume: number;           // Minimum volume required
    };
    crossMarketCorrelation: {
      correlationThreshold: number; // Minimum correlation for coordinated movement
      minMarkets: number;          // Minimum markets needed for correlation
      zScoreThreshold: number;     // Z-score threshold for significance
    };
  };
  
  // Microstructure Detection Thresholds
  microstructure: {
    orderbookImbalance: {
      threshold: number;           // Imbalance ratio threshold (0-1)
      depth: number;               // Orderbook depth to analyze
      minSpreadBps: number;        // Minimum spread in basis points
    };
    liquidityVacuum: {
      depthDropThreshold: number;  // % drop in orderbook depth
      spreadWidenThreshold: number; // Spread widening multiplier
      durationMs: number;          // Minimum duration of vacuum
    };
    frontRunning: {
      scoreThreshold: number;      // Front-running score threshold
      volumeWeightThreshold: number; // Volume weight threshold
      spreadImpactThreshold: number; // Spread impact threshold
    };
  };
  
  // Statistical Model Thresholds
  statistical: {
    anomalyDetection: {
      zScoreThreshold: number;     // Z-score threshold for anomalies
      mahalanobisThreshold: number; // Mahalanobis distance threshold
      isolationForestThreshold: number; // Isolation forest threshold
      lookbackPeriods: number;     // Historical periods for comparison
    };
    trendAnalysis: {
      trendStrengthThreshold: number; // Minimum trend strength
      volatilityThreshold: number;   // Maximum volatility tolerance
      stabilityPeriods: number;      // Periods required for trend stability
    };
  };
  
  // Market Discovery Thresholds
  markets: {
    minVolumeThreshold: number;    // Minimum volume to track market
    maxMarketsToTrack: number;     // Maximum concurrent markets
    refreshIntervalMs: number;     // Market refresh interval
    inactivityTimeoutMs: number;   // Remove market after inactivity
  };
  
  // Alert and Notification Thresholds
  alerts: {
    discordRateLimit: number;      // Max Discord alerts per minute
    confidenceThresholds: {
      info: number;                // Info alert confidence threshold
      warning: number;             // Warning alert confidence threshold
      critical: number;            // Critical alert confidence threshold
    };
    severityLevels: {
      low: string[];               // Signal types for low severity
      medium: string[];            // Signal types for medium severity
      high: string[];              // Signal types for high severity
      critical: string[];          // Signal types for critical severity
    };
  };
}

export interface PerformanceConfig {
  // Real-time Processing Limits
  processing: {
    maxConcurrentRequests: number;   // Max concurrent API requests
    requestTimeoutMs: number;        // API request timeout
    retryAttempts: number;           // Max retry attempts
    backoffMultiplier: number;       // Exponential backoff multiplier
  };
  
  // Memory Management
  memory: {
    maxHistoricalDataPoints: number; // Max data points to keep in memory
    cleanupIntervalMs: number;       // Memory cleanup interval
    maxRingBufferSize: number;       // Max ring buffer size
    gcThresholdMb: number;          // GC trigger threshold
  };
  
  // Database Performance
  database: {
    connectionPoolSize: number;      // DB connection pool size
    queryTimeoutMs: number;          // Query timeout
    batchSize: number;               // Batch insert size
    vacuumIntervalMs: number;        // DB vacuum interval
  };
  
  // WebSocket Configuration
  websocket: {
    maxConnections: number;          // Max WebSocket connections
    heartbeatIntervalMs: number;     // Heartbeat interval
    reconnectDelayMs: number;        // Reconnection delay
    messageQueueSize: number;        // Message queue size
  };
}

export interface SystemConfig {
  detection: DetectionThresholds;
  performance: PerformanceConfig;
  environment: {
    logLevel: string;
    isDevelopment: boolean;
    enableDebugMode: boolean;
    enablePerformanceMode: boolean;
  };
  features: {
    enableCrossMarketDetection: boolean;
    enableMicrostructureAnalysis: boolean;
    enableStatisticalModels: boolean;
    enableBacktesting: boolean;
    enableWebDashboard: boolean;
  };
}

export class ConfigManager {
  private static instance: ConfigManager;
  private config: SystemConfig;
  private configPath: string;
  private watchers: Map<string, (config: SystemConfig) => void> = new Map();
  private lastModified: number = 0;

  private constructor() {
    this.configPath = path.join(process.cwd(), 'config', 'detection-config.json');
    this.config = this.loadDefaultConfig();
    this.loadConfigFromFile();
    this.startConfigWatcher();
  }

  public static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }

  /**
   * Get current configuration
   */
  public getConfig(): SystemConfig {
    return { ...this.config }; // Return copy to prevent mutations
  }

  /**
   * Get detection thresholds
   */
  public getDetectionThresholds(): DetectionThresholds {
    return { ...this.config.detection };
  }

  /**
   * Get performance configuration
   */
  public getPerformanceConfig(): PerformanceConfig {
    return { ...this.config.performance };
  }

  /**
   * Update configuration (for runtime changes)
   */
  public updateConfig(updates: Partial<SystemConfig>): void {
    const oldConfig = { ...this.config };
    this.config = this.mergeConfigs(this.config, updates);
    
    // Validate updated config
    if (this.validateConfig(this.config)) {
      advancedLogger.info('Configuration updated successfully', {
        component: 'config_manager',
        operation: 'update_config',
        metadata: { 
          changedFields: this.getChangedFields(oldConfig, this.config),
          timestamp: Date.now()
        }
      });
      
      // Notify watchers
      this.notifyWatchers();
      
      // Save to file
      this.saveConfigToFile();
    } else {
      // Revert changes if validation fails
      this.config = oldConfig;
      throw new Error('Configuration validation failed - changes reverted');
    }
  }

  /**
   * Update detection thresholds specifically
   */
  public updateDetectionThresholds(thresholds: Partial<DetectionThresholds>): void {
    this.updateConfig({ detection: this.mergeDetectionThresholds(this.config.detection, thresholds) });
  }

  /**
   * Subscribe to configuration changes
   */
  public onConfigChange(id: string, callback: (config: SystemConfig) => void): void {
    this.watchers.set(id, callback);
  }

  /**
   * Unsubscribe from configuration changes
   */
  public offConfigChange(id: string): void {
    this.watchers.delete(id);
  }

  /**
   * Reload configuration from file
   */
  public reloadConfig(): void {
    try {
      this.loadConfigFromFile();
      advancedLogger.info('Configuration reloaded from file', {
        component: 'config_manager',
        operation: 'reload_config'
      });
    } catch (error) {
      advancedLogger.error('Failed to reload configuration', error as Error, {
        component: 'config_manager',
        operation: 'reload_config'
      });
    }
  }

  /**
   * Export current configuration to file
   */
  public exportConfig(filePath?: string): void {
    const exportPath = filePath || path.join(process.cwd(), 'config', 'exported-config.json');
    
    try {
      // Ensure directory exists
      const dir = path.dirname(exportPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      fs.writeFileSync(exportPath, JSON.stringify(this.config, null, 2));
      
      advancedLogger.info(`Configuration exported to ${exportPath}`, {
        component: 'config_manager',
        operation: 'export_config',
        metadata: { exportPath }
      });
    } catch (error) {
      advancedLogger.error('Failed to export configuration', error as Error, {
        component: 'config_manager',
        operation: 'export_config'
      });
      throw error;
    }
  }

  /**
   * Get configuration presets for different scenarios
   */
  public getPreset(preset: 'conservative' | 'balanced' | 'aggressive' | 'development'): Partial<DetectionThresholds> {
    const presets = {
      conservative: {
        signals: {
          volumeSpike: { multiplier: 5.0, windowMs: 900000, minConfidence: 0.9 },
          priceMovement: { percentageThreshold: 15, timeWindowMs: 1800000, minVolume: 50000 },
          crossMarketCorrelation: { correlationThreshold: 0.8, minMarkets: 3, zScoreThreshold: 3.0 }
        },
        microstructure: {
          orderbookImbalance: { threshold: 0.4, depth: 5, minSpreadBps: 20 },
          liquidityVacuum: { depthDropThreshold: 40, spreadWidenThreshold: 3.0, durationMs: 300000 },
          frontRunning: { scoreThreshold: 0.8, volumeWeightThreshold: 0.7, spreadImpactThreshold: 2.5 }
        },
        statistical: {
          anomalyDetection: { zScoreThreshold: 3.5, mahalanobisThreshold: 4.0, isolationForestThreshold: 0.8, lookbackPeriods: 168 },
          trendAnalysis: { trendStrengthThreshold: 0.7, volatilityThreshold: 0.3, stabilityPeriods: 36 }
        }
      },
      
      balanced: {
        signals: {
          volumeSpike: { multiplier: 3.0, windowMs: 600000, minConfidence: 0.75 },
          priceMovement: { percentageThreshold: 10, timeWindowMs: 1200000, minVolume: 25000 },
          crossMarketCorrelation: { correlationThreshold: 0.7, minMarkets: 2, zScoreThreshold: 2.5 }
        },
        microstructure: {
          orderbookImbalance: { threshold: 0.3, depth: 10, minSpreadBps: 15 },
          liquidityVacuum: { depthDropThreshold: 30, spreadWidenThreshold: 2.5, durationMs: 180000 },
          frontRunning: { scoreThreshold: 0.7, volumeWeightThreshold: 0.6, spreadImpactThreshold: 2.0 }
        },
        statistical: {
          anomalyDetection: { zScoreThreshold: 2.5, mahalanobisThreshold: 3.0, isolationForestThreshold: 0.7, lookbackPeriods: 120 },
          trendAnalysis: { trendStrengthThreshold: 0.6, volatilityThreshold: 0.4, stabilityPeriods: 24 }
        }
      },
      
      aggressive: {
        signals: {
          volumeSpike: { multiplier: 2.0, windowMs: 300000, minConfidence: 0.6 },
          priceMovement: { percentageThreshold: 5, timeWindowMs: 600000, minVolume: 10000 },
          crossMarketCorrelation: { correlationThreshold: 0.6, minMarkets: 2, zScoreThreshold: 2.0 }
        },
        microstructure: {
          orderbookImbalance: { threshold: 0.2, depth: 15, minSpreadBps: 10 },
          liquidityVacuum: { depthDropThreshold: 20, spreadWidenThreshold: 2.0, durationMs: 60000 },
          frontRunning: { scoreThreshold: 0.6, volumeWeightThreshold: 0.5, spreadImpactThreshold: 1.5 }
        },
        statistical: {
          anomalyDetection: { zScoreThreshold: 2.0, mahalanobisThreshold: 2.5, isolationForestThreshold: 0.6, lookbackPeriods: 96 },
          trendAnalysis: { trendStrengthThreshold: 0.5, volatilityThreshold: 0.5, stabilityPeriods: 18 }
        }
      },
      
      development: {
        signals: {
          volumeSpike: { multiplier: 1.5, windowMs: 180000, minConfidence: 0.5 },
          priceMovement: { percentageThreshold: 3, timeWindowMs: 300000, minVolume: 5000 },
          crossMarketCorrelation: { correlationThreshold: 0.5, minMarkets: 2, zScoreThreshold: 1.5 }
        },
        microstructure: {
          orderbookImbalance: { threshold: 0.15, depth: 20, minSpreadBps: 5 },
          liquidityVacuum: { depthDropThreshold: 15, spreadWidenThreshold: 1.5, durationMs: 30000 },
          frontRunning: { scoreThreshold: 0.5, volumeWeightThreshold: 0.4, spreadImpactThreshold: 1.2 }
        },
        statistical: {
          anomalyDetection: { zScoreThreshold: 1.5, mahalanobisThreshold: 2.0, isolationForestThreshold: 0.5, lookbackPeriods: 72 },
          trendAnalysis: { trendStrengthThreshold: 0.4, volatilityThreshold: 0.6, stabilityPeriods: 12 }
        }
      }
    };
    
    return presets[preset];
  }

  /**
   * Apply a configuration preset
   */
  public applyPreset(preset: 'conservative' | 'balanced' | 'aggressive' | 'development'): void {
    const presetConfig = this.getPreset(preset);
    const mergedConfig = this.mergeDetectionThresholds(this.config.detection, presetConfig);
    this.updateConfig({ detection: mergedConfig });
    
    advancedLogger.info(`Applied ${preset} configuration preset`, {
      component: 'config_manager',
      operation: 'apply_preset',
      metadata: { preset }
    });
  }

  // Private methods

  private loadDefaultConfig(): SystemConfig {
    return {
      detection: {
        signals: {
          volumeSpike: {
            multiplier: 3.0,
            windowMs: 600000, // 10 minutes
            minConfidence: 0.75
          },
          priceMovement: {
            percentageThreshold: 10,
            timeWindowMs: 1200000, // 20 minutes
            minVolume: 25000
          },
          crossMarketCorrelation: {
            correlationThreshold: 0.7,
            minMarkets: 2,
            zScoreThreshold: 2.5
          }
        },
        microstructure: {
          orderbookImbalance: {
            threshold: 0.3,
            depth: 10,
            minSpreadBps: 15
          },
          liquidityVacuum: {
            depthDropThreshold: 30,
            spreadWidenThreshold: 2.5,
            durationMs: 180000
          },
          frontRunning: {
            scoreThreshold: 0.7,
            volumeWeightThreshold: 0.6,
            spreadImpactThreshold: 2.0
          }
        },
        statistical: {
          anomalyDetection: {
            zScoreThreshold: 2.5,
            mahalanobisThreshold: 3.0,
            isolationForestThreshold: 0.7,
            lookbackPeriods: 120
          },
          trendAnalysis: {
            trendStrengthThreshold: 0.6,
            volatilityThreshold: 0.4,
            stabilityPeriods: 24
          }
        },
        markets: {
          minVolumeThreshold: 10000,
          maxMarketsToTrack: 100,
          refreshIntervalMs: 30000,
          inactivityTimeoutMs: 3600000
        },
        alerts: {
          discordRateLimit: 10,
          confidenceThresholds: {
            info: 0.6,
            warning: 0.75,
            critical: 0.9
          },
          severityLevels: {
            low: ['volume_spike', 'price_movement'],
            medium: ['orderbook_imbalance', 'liquidity_vacuum'],
            high: ['front_running', 'cross_market_correlation'],
            critical: ['coordinated_cross_market', 'statistical_anomaly']
          }
        }
      },
      performance: {
        processing: {
          maxConcurrentRequests: 10,
          requestTimeoutMs: 15000,
          retryAttempts: 3,
          backoffMultiplier: 2.0
        },
        memory: {
          maxHistoricalDataPoints: 10000,
          cleanupIntervalMs: 300000,
          maxRingBufferSize: 1000,
          gcThresholdMb: 512
        },
        database: {
          connectionPoolSize: 5,
          queryTimeoutMs: 30000,
          batchSize: 100,
          vacuumIntervalMs: 86400000
        },
        websocket: {
          maxConnections: 50,
          heartbeatIntervalMs: 30000,
          reconnectDelayMs: 5000,
          messageQueueSize: 1000
        }
      },
      environment: {
        logLevel: process.env.LOG_LEVEL || 'info',
        isDevelopment: process.env.NODE_ENV === 'development',
        enableDebugMode: process.env.DEBUG_MODE === 'true',
        enablePerformanceMode: process.env.PERFORMANCE_MODE === 'true'
      },
      features: {
        enableCrossMarketDetection: true,
        enableMicrostructureAnalysis: true,
        enableStatisticalModels: true,
        enableBacktesting: false,
        enableWebDashboard: false
      }
    };
  }

  private loadConfigFromFile(): void {
    try {
      if (fs.existsSync(this.configPath)) {
        const configData = fs.readFileSync(this.configPath, 'utf8');
        const fileConfig = JSON.parse(configData);
        
        // Merge with defaults
        this.config = this.mergeConfigs(this.config, fileConfig);
        
        // Validate merged config
        if (!this.validateConfig(this.config)) {
          throw new Error('Invalid configuration file');
        }
        
        // Update last modified time
        const stats = fs.statSync(this.configPath);
        this.lastModified = stats.mtime.getTime();
        
        advancedLogger.info('Configuration loaded from file', {
          component: 'config_manager',
          operation: 'load_config',
          metadata: { configPath: this.configPath }
        });
      } else {
        // Create default config file
        this.saveConfigToFile();
      }
    } catch (error) {
      advancedLogger.error('Failed to load configuration file', error as Error, {
        component: 'config_manager',
        operation: 'load_config'
      });
      
      // Continue with default config
      logger.warn('Using default configuration due to file load error');
    }
  }

  private saveConfigToFile(): void {
    try {
      // Ensure directory exists
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
      
      advancedLogger.info('Configuration saved to file', {
        component: 'config_manager',
        operation: 'save_config',
        metadata: { configPath: this.configPath }
      });
    } catch (error) {
      advancedLogger.error('Failed to save configuration file', error as Error, {
        component: 'config_manager',
        operation: 'save_config'
      });
    }
  }

  private startConfigWatcher(): void {
    // Watch for file changes every 5 seconds
    setInterval(() => {
      try {
        if (fs.existsSync(this.configPath)) {
          const stats = fs.statSync(this.configPath);
          const currentModified = stats.mtime.getTime();
          
          if (currentModified > this.lastModified) {
            this.lastModified = currentModified;
            this.loadConfigFromFile();
            this.notifyWatchers();
          }
        }
      } catch (error) {
        // Silent error - don't spam logs
      }
    }, 5000);
  }

  private notifyWatchers(): void {
    for (const [id, callback] of this.watchers) {
      try {
        callback(this.config);
      } catch (error) {
        advancedLogger.error(`Configuration watcher error for ${id}`, error as Error, {
          component: 'config_manager',
          operation: 'notify_watchers'
        });
      }
    }
  }

  private mergeConfigs(base: SystemConfig, override: any): SystemConfig {
    const merged = JSON.parse(JSON.stringify(base)); // Deep clone
    
    function deepMerge(target: any, source: any): any {
      for (const key in source) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
          if (!target[key]) target[key] = {};
          deepMerge(target[key], source[key]);
        } else {
          target[key] = source[key];
        }
      }
      return target;
    }
    
    return deepMerge(merged, override);
  }

  private validateConfig(config: SystemConfig): boolean {
    try {
      // Validate detection thresholds
      const d = config.detection;
      
      // Volume spike validation
      if (d.signals.volumeSpike.multiplier <= 1.0) return false;
      if (d.signals.volumeSpike.windowMs < 60000) return false; // Min 1 minute
      if (d.signals.volumeSpike.minConfidence < 0 || d.signals.volumeSpike.minConfidence > 1) return false;
      
      // Price movement validation
      if (d.signals.priceMovement.percentageThreshold <= 0) return false;
      if (d.signals.priceMovement.timeWindowMs < 60000) return false;
      if (d.signals.priceMovement.minVolume < 0) return false;
      
      // Correlation validation
      if (d.signals.crossMarketCorrelation.correlationThreshold < 0 || d.signals.crossMarketCorrelation.correlationThreshold > 1) return false;
      if (d.signals.crossMarketCorrelation.minMarkets < 2) return false;
      if (d.signals.crossMarketCorrelation.zScoreThreshold <= 0) return false;
      
      // Microstructure validation
      if (d.microstructure.orderbookImbalance.threshold < 0 || d.microstructure.orderbookImbalance.threshold > 1) return false;
      if (d.microstructure.orderbookImbalance.depth < 1) return false;
      if (d.microstructure.orderbookImbalance.minSpreadBps < 0) return false;
      
      // Performance validation
      const p = config.performance;
      if (p.processing.maxConcurrentRequests < 1) return false;
      if (p.processing.requestTimeoutMs < 1000) return false; // Min 1 second
      if (p.processing.retryAttempts < 0) return false;
      if (p.processing.backoffMultiplier <= 1.0) return false;
      
      // Memory validation
      if (p.memory.maxHistoricalDataPoints < 100) return false;
      if (p.memory.cleanupIntervalMs < 60000) return false; // Min 1 minute
      if (p.memory.maxRingBufferSize < 10) return false;
      if (p.memory.gcThresholdMb < 64) return false; // Min 64MB
      
      return true;
    } catch (error) {
      return false;
    }
  }

  private getChangedFields(oldConfig: SystemConfig, newConfig: SystemConfig): string[] {
    const changes: string[] = [];
    
    function findChanges(old: any, current: any, path: string = ''): void {
      for (const key in current) {
        const currentPath = path ? `${path}.${key}` : key;
        
        if (typeof current[key] === 'object' && !Array.isArray(current[key])) {
          if (old[key]) {
            findChanges(old[key], current[key], currentPath);
          } else {
            changes.push(currentPath);
          }
        } else if (old[key] !== current[key]) {
          changes.push(currentPath);
        }
      }
    }
    
    findChanges(oldConfig, newConfig);
    return changes;
  }

  private mergeDetectionThresholds(base: DetectionThresholds, override: Partial<DetectionThresholds>): DetectionThresholds {
    const merged = JSON.parse(JSON.stringify(base)) as DetectionThresholds;
    
    function deepMerge(target: any, source: any): any {
      for (const key in source) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
          if (!target[key]) target[key] = {};
          deepMerge(target[key], source[key]);
        } else if (source[key] !== undefined) {
          target[key] = source[key];
        }
      }
      return target;
    }
    
    return deepMerge(merged, override);
  }
}

// Export singleton instance
export const configManager = ConfigManager.getInstance();