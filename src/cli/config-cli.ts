#!/usr/bin/env node

import { Command } from 'commander';
import inquirer from 'inquirer';
import { configManager, DetectionThresholds } from '../config/ConfigManager';
import { logger } from '../utils/logger';

// Type for validation functions
type ValidationFunction = (value: number) => boolean;

const program = new Command();

program
  .name('config-cli')
  .description('Polymarket Information Leak Detection - Configuration Management')
  .version('1.0.0');

// View current configuration
program
  .command('show')
  .description('Show current configuration')
  .option('-s, --section <section>', 'Show specific section (detection|performance|environment|features)')
  .action((options) => {
    const config = configManager.getConfig();
    
    if (options.section) {
      if (config[options.section as keyof typeof config]) {
        console.log(JSON.stringify(config[options.section as keyof typeof config], null, 2));
      } else {
        console.error(`Invalid section: ${options.section}`);
        process.exit(1);
      }
    } else {
      console.log(JSON.stringify(config, null, 2));
    }
  });

// Interactive configuration tuning
program
  .command('tune')
  .description('Interactive configuration tuning')
  .action(async () => {
    console.log('🔧 Polymarket Detection Configuration Tuning\n');
    
    const { category } = await inquirer.prompt([
      {
        type: 'list',
        name: 'category',
        message: 'What would you like to configure?',
        choices: [
          'Detection Sensitivity',
          'Microstructure Thresholds', 
          'Statistical Models',
          'Market Discovery',
          'Alert Settings',
          'Performance Tuning',
          'Apply Preset',
          'Advanced Settings'
        ]
      }
    ]);

    switch (category) {
      case 'Detection Sensitivity':
        await tuneDetectionSensitivity();
        break;
      case 'Microstructure Thresholds':
        await tuneMicrostructureThresholds();
        break;
      case 'Statistical Models':
        await tuneStatisticalModels();
        break;
      case 'Market Discovery':
        await tuneMarketSettings();
        break;
      case 'Alert Settings':
        await tuneAlertSettings();
        break;
      case 'Performance Tuning':
        await tunePerformanceSettings();
        break;
      case 'Apply Preset':
        await applyPreset();
        break;
      case 'Advanced Settings':
        await tuneAdvancedSettings();
        break;
    }
  });

// Set specific configuration values
program
  .command('set')
  .description('Set configuration value')
  .argument('<path>', 'Configuration path (e.g., detection.signals.volumeSpike.multiplier)')
  .argument('<value>', 'New value')
  .action((path, value) => {
    try {
      const config = configManager.getConfig();
      const pathParts = path.split('.');
      
      // Parse value
      let parsedValue: any = value;
      if (!isNaN(Number(value))) {
        parsedValue = Number(value);
      } else if (value === 'true' || value === 'false') {
        parsedValue = value === 'true';
      }
      
      // Create update object
      const update: any = {};
      let current = update;
      
      for (let i = 0; i < pathParts.length - 1; i++) {
        current[pathParts[i]] = {};
        current = current[pathParts[i]];
      }
      current[pathParts[pathParts.length - 1]] = parsedValue;
      
      configManager.updateConfig(update);
      console.log(`✅ Updated ${path} = ${parsedValue}`);
      
    } catch (error) {
      console.error(`❌ Error: ${(error as Error).message}`);
      process.exit(1);
    }
  });

// Apply configuration presets
program
  .command('preset')
  .description('Apply configuration preset')
  .argument('<preset>', 'Preset name (conservative|balanced|aggressive|development)')
  .action((preset) => {
    const validPresets = ['conservative', 'balanced', 'aggressive', 'development'];
    
    if (!validPresets.includes(preset)) {
      console.error(`❌ Invalid preset. Valid options: ${validPresets.join(', ')}`);
      process.exit(1);
    }
    
    try {
      configManager.applyPreset(preset as any);
      console.log(`✅ Applied ${preset} preset configuration`);
    } catch (error) {
      console.error(`❌ Error: ${(error as Error).message}`);
      process.exit(1);
    }
  });

// Export configuration
program
  .command('export')
  .description('Export current configuration to file')
  .option('-f, --file <file>', 'Output file path', './exported-config.json')
  .action((options) => {
    try {
      configManager.exportConfig(options.file);
      console.log(`✅ Configuration exported to ${options.file}`);
    } catch (error) {
      console.error(`❌ Error: ${(error as Error).message}`);
      process.exit(1);
    }
  });

// Validate configuration
program
  .command('validate')
  .description('Validate current configuration')
  .action(() => {
    try {
      const config = configManager.getConfig();
      console.log('✅ Configuration is valid');
      
      // Show summary
      const detection = config.detection;
      console.log('\n📊 Configuration Summary:');
      console.log(`  • Volume Spike Threshold: ${detection.signals.volumeSpike.multiplier}x`);
      console.log(`  • Price Movement Threshold: ${detection.signals.priceMovement.percentageThreshold}%`);
      console.log(`  • Correlation Threshold: ${detection.signals.crossMarketCorrelation.correlationThreshold}`);
      console.log(`  • Z-Score Threshold: ${detection.statistical.anomalyDetection.zScoreThreshold}`);
      console.log(`  • Markets Tracked: ${detection.markets.maxMarketsToTrack}`);
      console.log(`  • Min Volume: $${detection.markets.minVolumeThreshold.toLocaleString()}`);
      
    } catch (error) {
      console.error(`❌ Configuration validation failed: ${(error as Error).message}`);
      process.exit(1);
    }
  });

// Interactive functions

async function tuneDetectionSensitivity() {
  const current = configManager.getDetectionThresholds();
  
  console.log('\n🎯 Detection Sensitivity Configuration\n');
  
  const answers = await inquirer.prompt([
    {
      type: 'number',
      name: 'volumeMultiplier',
      message: 'Volume spike multiplier (1.5-10.0):',
      default: current.signals.volumeSpike.multiplier,
      validate: (value) => value >= 1.5 && value <= 10.0
    },
    {
      type: 'number',
      name: 'priceThreshold',
      message: 'Price movement threshold % (1-50):',
      default: current.signals.priceMovement.percentageThreshold,
      validate: (value) => value >= 1 && value <= 50
    },
    {
      type: 'number',
      name: 'correlationThreshold',
      message: 'Cross-market correlation threshold (0.3-0.95):',
      default: current.signals.crossMarketCorrelation.correlationThreshold,
      validate: (value) => value >= 0.3 && value <= 0.95
    },
    {
      type: 'number',
      name: 'minConfidence',
      message: 'Minimum signal confidence (0.5-1.0):',
      default: current.signals.volumeSpike.minConfidence,
      validate: (value) => value >= 0.5 && value <= 1.0
    }
  ]);
  
  try {
    configManager.updateDetectionThresholds({
      signals: {
        volumeSpike: {
          ...current.signals.volumeSpike,
          multiplier: answers.volumeMultiplier,
          minConfidence: answers.minConfidence
        },
        priceMovement: {
          ...current.signals.priceMovement,
          percentageThreshold: answers.priceThreshold
        },
        crossMarketCorrelation: {
          ...current.signals.crossMarketCorrelation,
          correlationThreshold: answers.correlationThreshold
        }
      }
    });
    
    console.log('✅ Detection sensitivity updated successfully!');
  } catch (error) {
    console.error(`❌ Error: ${(error as Error).message}`);
  }
}

async function tuneMicrostructureThresholds() {
  const current = configManager.getDetectionThresholds();
  
  console.log('\n📈 Microstructure Analysis Configuration\n');
  
  const answers = await inquirer.prompt([
    {
      type: 'number',
      name: 'imbalanceThreshold',
      message: 'Orderbook imbalance threshold (0.1-0.8):',
      default: current.microstructure.orderbookImbalance.threshold,
      validate: (value) => value >= 0.1 && value <= 0.8
    },
    {
      type: 'number',
      name: 'liquidityDrop',
      message: 'Liquidity vacuum depth drop % (10-80):',
      default: current.microstructure.liquidityVacuum.depthDropThreshold,
      validate: (value) => value >= 10 && value <= 80
    },
    {
      type: 'number',
      name: 'frontRunScore',
      message: 'Front-running score threshold (0.3-0.9):',
      default: current.microstructure.frontRunning.scoreThreshold,
      validate: (value) => value >= 0.3 && value <= 0.9
    },
    {
      type: 'number',
      name: 'orderbookDepth',
      message: 'Orderbook analysis depth (5-50):',
      default: current.microstructure.orderbookImbalance.depth,
      validate: (value) => value >= 5 && value <= 50
    }
  ]);
  
  try {
    configManager.updateDetectionThresholds({
      microstructure: {
        orderbookImbalance: {
          ...current.microstructure.orderbookImbalance,
          threshold: answers.imbalanceThreshold,
          depth: answers.orderbookDepth
        },
        liquidityVacuum: {
          ...current.microstructure.liquidityVacuum,
          depthDropThreshold: answers.liquidityDrop
        },
        frontRunning: {
          ...current.microstructure.frontRunning,
          scoreThreshold: answers.frontRunScore
        }
      }
    });
    
    console.log('✅ Microstructure thresholds updated successfully!');
  } catch (error) {
    console.error(`❌ Error: ${(error as Error).message}`);
  }
}

async function tuneStatisticalModels() {
  const current = configManager.getDetectionThresholds();
  
  console.log('\n📊 Statistical Models Configuration\n');
  
  const answers = await inquirer.prompt([
    {
      type: 'number',
      name: 'zScoreThreshold',
      message: 'Z-score anomaly threshold (1.0-5.0):',
      default: current.statistical.anomalyDetection.zScoreThreshold,
      validate: (value) => value >= 1.0 && value <= 5.0
    },
    {
      type: 'number',
      name: 'mahalanobisThreshold',
      message: 'Mahalanobis distance threshold (1.5-6.0):',
      default: current.statistical.anomalyDetection.mahalanobisThreshold,
      validate: (value) => value >= 1.5 && value <= 6.0
    },
    {
      type: 'number',
      name: 'lookbackPeriods',
      message: 'Historical lookback periods (24-336):',
      default: current.statistical.anomalyDetection.lookbackPeriods,
      validate: (value) => value >= 24 && value <= 336
    }
  ]);
  
  try {
    configManager.updateDetectionThresholds({
      statistical: {
        anomalyDetection: {
          ...current.statistical.anomalyDetection,
          zScoreThreshold: answers.zScoreThreshold,
          mahalanobisThreshold: answers.mahalanobisThreshold,
          lookbackPeriods: answers.lookbackPeriods
        },
        trendAnalysis: current.statistical.trendAnalysis
      }
    });
    
    console.log('✅ Statistical model parameters updated successfully!');
  } catch (error) {
    console.error(`❌ Error: ${(error as Error).message}`);
  }
}

async function tuneMarketSettings() {
  const current = configManager.getDetectionThresholds();
  
  console.log('\n🏪 Market Discovery Configuration\n');
  
  const answers = await inquirer.prompt([
    {
      type: 'number',
      name: 'minVolume',
      message: 'Minimum volume threshold ($):',
      default: current.markets.minVolumeThreshold,
      validate: (value) => value >= 1000
    },
    {
      type: 'number',
      name: 'maxMarkets',
      message: 'Maximum markets to track (10-500):',
      default: current.markets.maxMarketsToTrack,
      validate: (value) => value >= 10 && value <= 500
    },
    {
      type: 'number',
      name: 'refreshInterval',
      message: 'Market refresh interval (seconds):',
      default: current.markets.refreshIntervalMs / 1000,
      validate: (value) => value >= 10 && value <= 300
    }
  ]);
  
  try {
    configManager.updateDetectionThresholds({
      markets: {
        ...current.markets,
        minVolumeThreshold: answers.minVolume,
        maxMarketsToTrack: answers.maxMarkets,
        refreshIntervalMs: answers.refreshInterval * 1000
      }
    });
    
    console.log('✅ Market settings updated successfully!');
  } catch (error) {
    console.error(`❌ Error: ${(error as Error).message}`);
  }
}

async function tuneAlertSettings() {
  const current = configManager.getDetectionThresholds();
  
  console.log('\n🚨 Alert Configuration\n');
  
  const answers = await inquirer.prompt([
    {
      type: 'number',
      name: 'infoThreshold',
      message: 'Info alert confidence threshold (0.3-0.8):',
      default: current.alerts.confidenceThresholds.info,
      validate: (value) => value >= 0.3 && value <= 0.8
    },
    {
      type: 'number',
      name: 'warningThreshold',
      message: 'Warning alert confidence threshold (0.5-0.9):',
      default: current.alerts.confidenceThresholds.warning,
      validate: (value) => value >= 0.5 && value <= 0.9
    },
    {
      type: 'number',
      name: 'criticalThreshold',
      message: 'Critical alert confidence threshold (0.7-1.0):',
      default: current.alerts.confidenceThresholds.critical,
      validate: (value) => value >= 0.7 && value <= 1.0
    },
    {
      type: 'number',
      name: 'discordRateLimit',
      message: 'Discord alerts per minute (1-30):',
      default: current.alerts.discordRateLimit,
      validate: (value) => value >= 1 && value <= 30
    }
  ]);
  
  try {
    configManager.updateDetectionThresholds({
      alerts: {
        ...current.alerts,
        confidenceThresholds: {
          info: answers.infoThreshold,
          warning: answers.warningThreshold,
          critical: answers.criticalThreshold
        },
        discordRateLimit: answers.discordRateLimit
      }
    });
    
    console.log('✅ Alert settings updated successfully!');
  } catch (error) {
    console.error(`❌ Error: ${(error as Error).message}`);
  }
}

async function tunePerformanceSettings() {
  const current = configManager.getPerformanceConfig();
  
  console.log('\n⚡ Performance Configuration\n');
  
  const answers = await inquirer.prompt([
    {
      type: 'number',
      name: 'maxRequests',
      message: 'Max concurrent API requests (1-50):',
      default: current.processing.maxConcurrentRequests,
      validate: (value) => value >= 1 && value <= 50
    },
    {
      type: 'number',
      name: 'requestTimeout',
      message: 'API request timeout (seconds):',
      default: current.processing.requestTimeoutMs / 1000,
      validate: (value) => value >= 5 && value <= 60
    },
    {
      type: 'number',
      name: 'maxDataPoints',
      message: 'Max historical data points (1000-50000):',
      default: current.memory.maxHistoricalDataPoints,
      validate: (value) => value >= 1000 && value <= 50000
    },
    {
      type: 'number',
      name: 'bufferSize',
      message: 'Ring buffer size (100-5000):',
      default: current.memory.maxRingBufferSize,
      validate: (value) => value >= 100 && value <= 5000
    }
  ]);
  
  try {
    configManager.updateConfig({
      performance: {
        ...current,
        processing: {
          ...current.processing,
          maxConcurrentRequests: answers.maxRequests,
          requestTimeoutMs: answers.requestTimeout * 1000
        },
        memory: {
          ...current.memory,
          maxHistoricalDataPoints: answers.maxDataPoints,
          maxRingBufferSize: answers.bufferSize
        }
      }
    });
    
    console.log('✅ Performance settings updated successfully!');
  } catch (error) {
    console.error(`❌ Error: ${(error as Error).message}`);
  }
}

async function applyPreset() {
  console.log('\n🎨 Configuration Presets\n');
  
  const { preset } = await inquirer.prompt([
    {
      type: 'list',
      name: 'preset',
      message: 'Choose a configuration preset:',
      choices: [
        { name: '🛡️  Conservative - High precision, low false positives', value: 'conservative' },
        { name: '⚖️  Balanced - Good balance of sensitivity and precision', value: 'balanced' },
        { name: '🎯 Aggressive - High sensitivity, may have false positives', value: 'aggressive' },
        { name: '🔧 Development - Very sensitive for testing', value: 'development' }
      ]
    }
  ]);
  
  const { confirm } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message: `Apply ${preset} preset? This will overwrite current detection settings.`,
      default: false
    }
  ]);
  
  if (confirm) {
    try {
      configManager.applyPreset(preset);
      console.log(`✅ Applied ${preset} preset successfully!`);
    } catch (error) {
      console.error(`❌ Error: ${(error as Error).message}`);
    }
  } else {
    console.log('❌ Preset application cancelled');
  }
}

async function tuneAdvancedSettings() {
  const config = configManager.getConfig();
  
  console.log('\n🔬 Advanced Configuration\n');
  
  const answers = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'enableCrossMarket',
      message: 'Enable cross-market leak detection?',
      default: config.features.enableCrossMarketDetection
    },
    {
      type: 'confirm',
      name: 'enableMicrostructure',
      message: 'Enable microstructure analysis?',
      default: config.features.enableMicrostructureAnalysis
    },
    {
      type: 'confirm',
      name: 'enableStatistical',
      message: 'Enable statistical models?',
      default: config.features.enableStatisticalModels
    },
    {
      type: 'confirm',
      name: 'enableDebug',
      message: 'Enable debug mode?',
      default: config.environment.enableDebugMode
    },
    {
      type: 'confirm',
      name: 'enablePerformance',
      message: 'Enable performance mode?',
      default: config.environment.enablePerformanceMode
    }
  ]);
  
  try {
    configManager.updateConfig({
      features: {
        ...config.features,
        enableCrossMarketDetection: answers.enableCrossMarket,
        enableMicrostructureAnalysis: answers.enableMicrostructure,
        enableStatisticalModels: answers.enableStatistical
      },
      environment: {
        ...config.environment,
        enableDebugMode: answers.enableDebug,
        enablePerformanceMode: answers.enablePerformance
      }
    });
    
    console.log('✅ Advanced settings updated successfully!');
  } catch (error) {
    console.error(`❌ Error: ${(error as Error).message}`);
  }
}

if (require.main === module) {
  program.parse();
}