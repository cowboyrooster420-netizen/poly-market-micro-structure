import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import { advancedLogger } from '../utils/AdvancedLogger';

export interface DetectionThresholds {
  // Market Filtering Configuration
  marketFiltering: {
    enabled: boolean;
    maxDaysToResolution: number;
    minDaysToResolution: number;
    trendBasedPatterns: string[];
    eventBasedKeywords: string[];
    excludeTags: string[];
    includeTags: string[];
    requireEventDate: boolean;
    scoreThreshold: number;
  };

  // Category-Specific Volume Thresholds
  categoryVolumeThresholds: {
    earnings: number;            // Small-cap earnings have edge at low volume ($2k+)
    ceo_changes: number;         // Executive turnover markets
    mergers: number;             // M&A markets
    court_cases: number;         // Legal outcome markets
    pardons: number;             // Presidential pardon markets
    fed: number;                 // Federal Reserve / interest rate markets
    economic_data: number;       // CPI, jobs, GDP data releases
    politics: number;            // Elections, appointments, legislation
    sports_awards: number;       // MVP, championships, individual awards
    hollywood_awards: number;    // Oscars, Emmys, Golden Globes
    world_events: number;        // Geopolitical events, wars, treaties
    macro: number;               // Recessions, market crashes, systemic events
    crypto_events: number;       // ETF approvals, mainnet launches, protocol events
    uncategorized: number;       // Default for markets without category
  };

  // Two-Tier Monitoring Configuration
  marketTiers: {
    watchlist: {
      enabled: boolean;                    // Enable watchlist tier
      minVolumeFloor: number;              // Absolute minimum volume for any tier ($500)
      maxWatchlistSize: number;            // Maximum markets on watchlist (100)
      monitoringIntervalMs: number;        // How often to check watchlist markets (300000 = 5min)

      // Criteria for watchlist inclusion (markets below volume threshold)
      criteria: {
        minCategoryScore: number;          // Minimum keyword match score (3+)
        minOutcomeCount: number;           // Multi-outcome markets (5+ outcomes)
        maxDaysToClose: number;            // Markets closing soon (14 days)
        highEdgeCategories: string[];      // Categories with known edge despite low volume
        requireMultipleSignals: boolean;   // Require 2+ watchlist signals
      };
    };

    active: {
      monitoringIntervalMs: number;        // Real-time monitoring interval (30000 = 30sec)
      enableWebSocket: boolean;            // Use WebSocket for real-time updates
      maxActiveMarkets: number;            // Maximum concurrent active markets (200)
    };
  };

  // Opportunity Scoring Configuration
  opportunityScoring: {
    enabled: boolean;                      // Enable opportunity scoring system

    // Volume scoring (0-30 points): Balance liquidity vs efficiency
    volumeScore: {
      weight: number;                      // Weight in final score (0.3)
      optimalVolumeMultiplier: number;     // Optimal volume = threshold * multiplier (1.5x)
      illiquidityPenaltyThreshold: number; // Penalty below this ratio (0.3x)
      efficiencyPenaltyThreshold: number;  // Penalty above this ratio (5.0x)
    };

    // Edge scoring (0-25 points): Information advantage
    edgeScore: {
      weight: number;                      // Weight in final score (0.25)
      highEdgeCategories: Record<string, number>; // Category -> edge multiplier
      categoryScoreWeight: number;         // How much category confidence matters (0.4)
      multiOutcomeBonus: number;           // Bonus per outcome above 5 (0.5)
      maxMultiOutcomeBonus: number;        // Cap on multi-outcome bonus (5.0)
    };

    // Catalyst scoring (0-25 points): Time urgency
    catalystScore: {
      weight: number;                      // Weight in final score (0.25)
      optimalDaysToClose: number;          // Sweet spot days before close (4.0)
      minDaysToClose: number;              // Too soon to act (0.5)
      maxDaysToClose: number;              // Too far to matter (30)
      urgencyMultiplier: number;           // Boost for closing within week (1.5)
    };

    // Market quality scoring (0-20 points): Efficiency indicators
    qualityScore: {
      weight: number;                      // Weight in final score (0.2)
      spreadWeight: number;                // Wider spread = more opportunity (0.4)
      ageWeight: number;                   // Newer markets less discovered (0.3)
      liquidityWeight: number;             // Depth matters (0.3)
      optimalSpreadBps: number;            // Target spread in basis points (150)
      maxAgeDays: number;                  // Beyond this, age doesn't matter (60)
    };
  };

  // Alert Prioritization Configuration
  alertPrioritization: {
    enabled: boolean;                      // Enable alert prioritization system

    // Score thresholds for alert levels
    thresholds: {
      critical: number;                    // Score >= this = CRITICAL (80)
      high: number;                        // Score >= this = HIGH (60)
      medium: number;                      // Score >= this = MEDIUM (40)
      // Below medium = LOW
    };

    // Tier-specific adjustments
    tierAdjustments: {
      active: {
        scoreBoost: number;                // Boost for ACTIVE tier (0)
        minPriority: string;               // Minimum alert level for ACTIVE ('LOW')
      };
      watchlist: {
        scoreBoost: number;                // Boost for WATCHLIST tier (+5)
        minPriority: string;               // Minimum alert level for WATCHLIST ('MEDIUM')
      };
    };

    // Rate limiting per priority level
    rateLimits: {
      critical: {
        maxPerHour: number;                // Max CRITICAL alerts per hour (10)
        cooldownMinutes: number;           // Cooldown between same market (30)
      };
      high: {
        maxPerHour: number;                // Max HIGH alerts per hour (20)
        cooldownMinutes: number;           // Cooldown between same market (60)
      };
      medium: {
        maxPerHour: number;                // Max MEDIUM alerts per hour (50)
        cooldownMinutes: number;           // Cooldown between same market (120)
      };
      low: {
        maxPerHour: number;                // Max LOW alerts per hour (100)
        cooldownMinutes: number;           // Cooldown between same market (240)
      };
    };

    // Alert quality filters
    qualityFilters: {
      minOpportunityScore: number;         // Don't alert below this score (30)
      minCategoryScore: number;            // Min category confidence for alerts (2)
      requireNonBlacklisted: boolean;      // Never alert on blacklisted markets (true)
      minVolumeRatio: number;              // Min volume/threshold ratio (0.2)
    };

    // Notification configuration per priority
    notifications: {
      critical: {
        enableDiscord: boolean;            // Send to Discord (true)
        enableWebhook: boolean;            // Send to custom webhook (false)
        mentionEveryone: boolean;          // @everyone mention (true)
        includeChart: boolean;             // Include price chart (true)
      };
      high: {
        enableDiscord: boolean;            // Send to Discord (true)
        enableWebhook: boolean;            // Send to custom webhook (false)
        mentionEveryone: boolean;          // @everyone mention (false)
        includeChart: boolean;             // Include price chart (true)
      };
      medium: {
        enableDiscord: boolean;            // Send to Discord (true)
        enableWebhook: boolean;            // Send to custom webhook (false)
        mentionEveryone: boolean;          // @everyone mention (false)
        includeChart: boolean;             // Include price chart (false)
      };
      low: {
        enableDiscord: boolean;            // Send to Discord (false)
        enableWebhook: boolean;            // Send to custom webhook (false)
        mentionEveryone: boolean;          // @everyone mention (false)
        includeChart: boolean;             // Include price chart (false)
      };
    };
  };

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
      baselineExpectedChangePercent: number; // Expected baseline price change for confidence calculation
    };
    crossMarketCorrelation: {
      correlationThreshold: number; // Minimum correlation for coordinated movement
      minMarkets: number;          // Minimum markets needed for correlation
      zScoreThreshold: number;     // Z-score threshold for significance
    };
    activityDetection: {
      baselineActivityScore: number; // Expected baseline activity score for confidence calculation
      activityThreshold: number;     // Minimum activity score to trigger alert
    };
  };
  
  // Microstructure Detection Thresholds
  microstructure: {
    orderbookImbalance: {
      threshold: number;           // Imbalance ratio threshold (0-1)
      depth: number;               // Orderbook depth to analyze
      minSpreadBps: number;        // Minimum spread in basis points
    };
    spreadAnomaly?: {
      threshold: number;           // Normalized spread change threshold (std devs)
      minVolatility: number;       // Minimum spread volatility to consider
    };
    liquidityShift?: {
      threshold: number;           // Liquidity score change threshold (0-100)
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
          priceMovement: { percentageThreshold: 15, timeWindowMs: 1800000, minVolume: 50000, baselineExpectedChangePercent: 7 },
          crossMarketCorrelation: { correlationThreshold: 0.8, minMarkets: 3, zScoreThreshold: 3.0 },
          activityDetection: { baselineActivityScore: 70, activityThreshold: 90 }
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
          priceMovement: { percentageThreshold: 10, timeWindowMs: 1200000, minVolume: 25000, baselineExpectedChangePercent: 5 },
          crossMarketCorrelation: { correlationThreshold: 0.7, minMarkets: 2, zScoreThreshold: 2.5 },
          activityDetection: { baselineActivityScore: 60, activityThreshold: 80 }
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
          priceMovement: { percentageThreshold: 5, timeWindowMs: 600000, minVolume: 10000, baselineExpectedChangePercent: 3 },
          crossMarketCorrelation: { correlationThreshold: 0.6, minMarkets: 2, zScoreThreshold: 2.0 },
          activityDetection: { baselineActivityScore: 50, activityThreshold: 70 }
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
          priceMovement: { percentageThreshold: 3, timeWindowMs: 300000, minVolume: 5000, baselineExpectedChangePercent: 2 },
          crossMarketCorrelation: { correlationThreshold: 0.5, minMarkets: 2, zScoreThreshold: 1.5 },
          activityDetection: { baselineActivityScore: 40, activityThreshold: 60 }
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
            minVolume: 25000,
            baselineExpectedChangePercent: 5
          },
          crossMarketCorrelation: {
            correlationThreshold: 0.7,
            minMarkets: 2,
            zScoreThreshold: 2.5
          },
          activityDetection: {
            baselineActivityScore: 60,
            activityThreshold: 80
          }
        },
        marketFiltering: {
          enabled: true,
          maxDaysToResolution: 90,
          minDaysToResolution: 1,
          trendBasedPatterns: [
            'hit \\$\\d+.*202[5-9]',
            'reach \\$\\d+.*202[5-9]',
            'price.*\\$\\d+.*202[5-9]'
          ],
          eventBasedKeywords: [
            'earnings',
            'beat earnings',
            'win election',
            'primary',
            'indicted',
            'win game',
            'this week'
          ],
          excludeTags: ['long-term', 'price-prediction', 'crypto-price'],
          includeTags: ['earnings', 'elections', 'sports', 'legal'],
          requireEventDate: true,
          scoreThreshold: 0.6
        },
        categoryVolumeThresholds: {
          // Low thresholds - high information edge categories
          earnings: 2000,           // Small-cap earnings often mispriced despite low volume
          ceo_changes: 3000,        // Executive news often underreacted
          pardons: 3000,            // Rare events with insider info edge

          // Medium thresholds - balanced edge/liquidity
          mergers: 5000,            // M&A deals need some liquidity
          court_cases: 5000,        // Legal outcomes, moderate interest
          sports_awards: 4000,      // Multi-outcome markets, fan interest
          hollywood_awards: 4000,   // Multi-outcome markets, entertainment interest
          crypto_events: 6000,      // Event-based crypto (not price predictions)

          // Higher thresholds - need liquidity for reliable signals
          politics: 8000,           // High-profile political events
          economic_data: 8000,      // CPI, jobs reports need volume
          world_events: 7000,       // Geopolitical events
          fed: 10000,               // Fed decisions are major macro events
          macro: 10000,             // Systemic events need deep liquidity

          // Default for uncategorized
          uncategorized: 15000      // Conservative threshold for unknown categories
        },
        marketTiers: {
          watchlist: {
            enabled: true,
            minVolumeFloor: 500,              // Don't monitor markets with <$500 volume
            maxWatchlistSize: 100,            // Cap at 100 watchlist markets
            monitoringIntervalMs: 300000,     // Check every 5 minutes

            criteria: {
              minCategoryScore: 3,            // Strong category match (3+ keywords)
              minOutcomeCount: 5,             // Multi-outcome markets have more edge
              maxDaysToClose: 14,             // Markets closing within 2 weeks
              highEdgeCategories: [           // Categories with proven edge at low volume
                'earnings',
                'ceo_changes',
                'court_cases',
                'pardons'
              ],
              requireMultipleSignals: true    // Need 2+ signals for watchlist
            }
          },

          active: {
            monitoringIntervalMs: 30000,      // Real-time checks every 30 seconds
            enableWebSocket: true,            // Use WebSocket for active markets
            maxActiveMarkets: 200             // Reasonable limit for concurrent monitoring
          }
        },
        opportunityScoring: {
          enabled: true,

          volumeScore: {
            weight: 0.3,                      // 30% of final score
            optimalVolumeMultiplier: 1.5,     // Sweet spot: 1.5x category threshold
            illiquidityPenaltyThreshold: 0.3, // Penalty if <30% of threshold
            efficiencyPenaltyThreshold: 5.0   // Penalty if >5x threshold (too efficient)
          },

          edgeScore: {
            weight: 0.25,                     // 25% of final score
            highEdgeCategories: {             // Category-specific edge multipliers
              earnings: 1.5,                  // Highest edge (small-cap mispricing)
              ceo_changes: 1.4,               // Executive news underreacted
              court_cases: 1.3,               // Legal outcomes have insider info
              pardons: 1.3,                   // Rare events, political connections
              mergers: 1.2,                   // M&A deals have deal knowledge
              sports_awards: 1.1,             // Fan/insider knowledge
              hollywood_awards: 1.1,          // Industry insider info
              politics: 1.0,                  // Base edge
              economic_data: 0.9,             // Hard to predict data releases
              world_events: 0.9,              // Geopolitical uncertainty
              fed: 0.8,                       // Fed highly analyzed
              macro: 0.8,                     // Systemic events hard to time
              crypto_events: 1.0,             // Event-based has some edge
              uncategorized: 0.5              // Unknown category = low confidence
            },
            categoryScoreWeight: 0.4,         // Category confidence matters
            multiOutcomeBonus: 0.5,           // +0.5 per outcome above 5
            maxMultiOutcomeBonus: 5.0         // Cap at +5 total
          },

          catalystScore: {
            weight: 0.25,                     // 25% of final score
            optimalDaysToClose: 4.0,          // Sweet spot: 4 days before close
            minDaysToClose: 0.5,              // <12 hours too urgent
            maxDaysToClose: 30,               // >30 days too far
            urgencyMultiplier: 1.5            // 1.5x bonus if closing within 7 days
          },

          qualityScore: {
            weight: 0.2,                      // 20% of final score
            spreadWeight: 0.4,                // Spread most important quality indicator
            ageWeight: 0.3,                   // Age indicates discovery level
            liquidityWeight: 0.3,             // Depth matters for execution
            optimalSpreadBps: 150,            // 150 bps spread indicates good opportunity
            maxAgeDays: 60                    // Beyond 60 days, age doesn't matter
          }
        },
        alertPrioritization: {
          enabled: true,

          thresholds: {
            critical: 80,                    // Top tier opportunities (80-100)
            high: 60,                        // Strong opportunities (60-79)
            medium: 40                       // Moderate opportunities (40-59)
            // Below 40 = LOW
          },

          tierAdjustments: {
            active: {
              scoreBoost: 0,                 // No boost for ACTIVE tier
              minPriority: 'LOW'             // ACTIVE can send any level
            },
            watchlist: {
              scoreBoost: 5,                 // +5 bonus for WATCHLIST (high conviction)
              minPriority: 'MEDIUM'          // WATCHLIST minimum is MEDIUM
            }
          },

          rateLimits: {
            critical: {
              maxPerHour: 10,                // Max 10 CRITICAL/hour (rare, high impact)
              cooldownMinutes: 30            // 30 min cooldown per market
            },
            high: {
              maxPerHour: 20,                // Max 20 HIGH/hour
              cooldownMinutes: 60            // 1 hr cooldown per market
            },
            medium: {
              maxPerHour: 50,                // Max 50 MEDIUM/hour
              cooldownMinutes: 120           // 2 hr cooldown per market
            },
            low: {
              maxPerHour: 100,               // Max 100 LOW/hour (logged only)
              cooldownMinutes: 240           // 4 hr cooldown per market
            }
          },

          qualityFilters: {
            minOpportunityScore: 30,         // Don't alert if score <30
            minCategoryScore: 2,             // Need at least 2 keyword matches
            requireNonBlacklisted: true,     // Never alert blacklisted markets
            minVolumeRatio: 0.2              // Need at least 20% of threshold volume
          },

          notifications: {
            critical: {
              enableDiscord: true,           // Always send CRITICAL to Discord
              enableWebhook: false,          // Can enable custom webhook
              mentionEveryone: true,         // @everyone for CRITICAL
              includeChart: true             // Include price chart
            },
            high: {
              enableDiscord: true,           // Send HIGH to Discord
              enableWebhook: false,
              mentionEveryone: false,        // No @everyone for HIGH
              includeChart: true             // Include price chart
            },
            medium: {
              enableDiscord: true,           // Send MEDIUM to Discord
              enableWebhook: false,
              mentionEveryone: false,
              includeChart: false            // No chart for MEDIUM
            },
            low: {
              enableDiscord: false,          // Don't send LOW to Discord (log only)
              enableWebhook: false,
              mentionEveryone: false,
              includeChart: false
            }
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

      // Category volume threshold validation
      const thresholds = d.categoryVolumeThresholds;
      for (const category in thresholds) {
        const value = thresholds[category as keyof typeof thresholds];
        if (typeof value !== 'number' || value < 0 || value > 1000000) {
          logger.warn(`Invalid volume threshold for ${category}: ${value}`);
          return false;
        }
      }

      // Market tiers validation
      const tiers = d.marketTiers;
      if (tiers.watchlist.minVolumeFloor < 0 || tiers.watchlist.minVolumeFloor > 10000) return false;
      if (tiers.watchlist.maxWatchlistSize < 10 || tiers.watchlist.maxWatchlistSize > 1000) return false;
      if (tiers.watchlist.monitoringIntervalMs < 60000 || tiers.watchlist.monitoringIntervalMs > 3600000) return false; // 1min - 1hr
      if (tiers.watchlist.criteria.minCategoryScore < 1 || tiers.watchlist.criteria.minCategoryScore > 10) return false;
      if (tiers.watchlist.criteria.minOutcomeCount < 2 || tiers.watchlist.criteria.minOutcomeCount > 20) return false;
      if (tiers.watchlist.criteria.maxDaysToClose < 1 || tiers.watchlist.criteria.maxDaysToClose > 365) return false;
      if (!Array.isArray(tiers.watchlist.criteria.highEdgeCategories)) return false;
      if (tiers.active.monitoringIntervalMs < 10000 || tiers.active.monitoringIntervalMs > 300000) return false; // 10sec - 5min
      if (tiers.active.maxActiveMarkets < 10 || tiers.active.maxActiveMarkets > 1000) return false;

      // Opportunity scoring validation
      const scoring = d.opportunityScoring;
      if (scoring.volumeScore.weight < 0 || scoring.volumeScore.weight > 1) return false;
      if (scoring.volumeScore.optimalVolumeMultiplier < 1.0 || scoring.volumeScore.optimalVolumeMultiplier > 10.0) return false;
      if (scoring.volumeScore.illiquidityPenaltyThreshold < 0.1 || scoring.volumeScore.illiquidityPenaltyThreshold > 1.0) return false;
      if (scoring.volumeScore.efficiencyPenaltyThreshold < 2.0 || scoring.volumeScore.efficiencyPenaltyThreshold > 20.0) return false;

      if (scoring.edgeScore.weight < 0 || scoring.edgeScore.weight > 1) return false;
      if (scoring.edgeScore.categoryScoreWeight < 0 || scoring.edgeScore.categoryScoreWeight > 1) return false;
      if (scoring.edgeScore.multiOutcomeBonus < 0 || scoring.edgeScore.multiOutcomeBonus > 2) return false;
      if (scoring.edgeScore.maxMultiOutcomeBonus < 0 || scoring.edgeScore.maxMultiOutcomeBonus > 20) return false;

      if (scoring.catalystScore.weight < 0 || scoring.catalystScore.weight > 1) return false;
      if (scoring.catalystScore.optimalDaysToClose < 0.5 || scoring.catalystScore.optimalDaysToClose > 30) return false;
      if (scoring.catalystScore.minDaysToClose < 0.1 || scoring.catalystScore.minDaysToClose > 7) return false;
      if (scoring.catalystScore.maxDaysToClose < 7 || scoring.catalystScore.maxDaysToClose > 365) return false;
      if (scoring.catalystScore.urgencyMultiplier < 1.0 || scoring.catalystScore.urgencyMultiplier > 5.0) return false;

      if (scoring.qualityScore.weight < 0 || scoring.qualityScore.weight > 1) return false;
      if (scoring.qualityScore.spreadWeight < 0 || scoring.qualityScore.spreadWeight > 1) return false;
      if (scoring.qualityScore.ageWeight < 0 || scoring.qualityScore.ageWeight > 1) return false;
      if (scoring.qualityScore.liquidityWeight < 0 || scoring.qualityScore.liquidityWeight > 1) return false;
      if (scoring.qualityScore.optimalSpreadBps < 10 || scoring.qualityScore.optimalSpreadBps > 1000) return false;
      if (scoring.qualityScore.maxAgeDays < 1 || scoring.qualityScore.maxAgeDays > 365) return false;

      // Validate weights sum approximately to 1.0 (allow 0.95-1.05 for rounding)
      const totalWeight = scoring.volumeScore.weight + scoring.edgeScore.weight +
                          scoring.catalystScore.weight + scoring.qualityScore.weight;
      if (totalWeight < 0.95 || totalWeight > 1.05) {
        logger.warn(`Opportunity score weights don't sum to 1.0: ${totalWeight}`);
        return false;
      }

      // Alert prioritization validation
      const alerting = d.alertPrioritization;
      if (alerting.thresholds.critical < 0 || alerting.thresholds.critical > 100) return false;
      if (alerting.thresholds.high < 0 || alerting.thresholds.high > 100) return false;
      if (alerting.thresholds.medium < 0 || alerting.thresholds.medium > 100) return false;
      if (alerting.thresholds.high >= alerting.thresholds.critical) {
        logger.warn('HIGH threshold must be below CRITICAL threshold');
        return false;
      }
      if (alerting.thresholds.medium >= alerting.thresholds.high) {
        logger.warn('MEDIUM threshold must be below HIGH threshold');
        return false;
      }

      // Tier adjustments validation
      if (alerting.tierAdjustments.active.scoreBoost < -20 || alerting.tierAdjustments.active.scoreBoost > 20) return false;
      if (alerting.tierAdjustments.watchlist.scoreBoost < -20 || alerting.tierAdjustments.watchlist.scoreBoost > 20) return false;
      const validPriorities = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
      if (!validPriorities.includes(alerting.tierAdjustments.active.minPriority.toUpperCase())) return false;
      if (!validPriorities.includes(alerting.tierAdjustments.watchlist.minPriority.toUpperCase())) return false;

      // Rate limits validation
      for (const level of ['critical', 'high', 'medium', 'low'] as const) {
        const limit = alerting.rateLimits[level];
        if (limit.maxPerHour < 1 || limit.maxPerHour > 1000) return false;
        if (limit.cooldownMinutes < 1 || limit.cooldownMinutes > 1440) return false; // Max 24 hours
      }

      // Quality filters validation
      if (alerting.qualityFilters.minOpportunityScore < 0 || alerting.qualityFilters.minOpportunityScore > 100) return false;
      if (alerting.qualityFilters.minCategoryScore < 0 || alerting.qualityFilters.minCategoryScore > 20) return false;
      if (alerting.qualityFilters.minVolumeRatio < 0 || alerting.qualityFilters.minVolumeRatio > 10) return false;

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