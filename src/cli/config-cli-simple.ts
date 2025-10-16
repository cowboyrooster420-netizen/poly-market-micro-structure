#!/usr/bin/env node

import { configManager } from '../config/ConfigManager';

// Simple configuration CLI without external dependencies
function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'show':
      showConfiguration(args[1]);
      break;
    case 'set':
      setConfiguration(args[1], args[2]);
      break;
    case 'preset':
      applyPreset(args[1] as any);
      break;
    case 'validate':
      validateConfiguration();
      break;
    case 'export':
      exportConfiguration(args[1]);
      break;
    default:
      showHelp();
  }
}

function showHelp() {
  console.log(`
🔧 Polymarket Detection Configuration CLI

Usage:
  npm run config show [section]     - Show configuration
  npm run config set <path> <value> - Set configuration value
  npm run config preset <preset>    - Apply preset (conservative|balanced|aggressive|development)
  npm run config validate           - Validate configuration
  npm run config export [file]      - Export configuration

Examples:
  npm run config show detection
  npm run config set detection.signals.volumeSpike.multiplier 3.5
  npm run config preset aggressive
  npm run config validate
  npm run config export ./my-config.json
`);
}

function showConfiguration(section?: string) {
  const config = configManager.getConfig();
  
  if (section) {
    if (config[section as keyof typeof config]) {
      console.log(JSON.stringify(config[section as keyof typeof config], null, 2));
    } else {
      console.error(`❌ Invalid section: ${section}`);
      process.exit(1);
    }
  } else {
    console.log(JSON.stringify(config, null, 2));
  }
}

function setConfiguration(path: string, value: string) {
  if (!path || !value) {
    console.error('❌ Usage: npm run config set <path> <value>');
    process.exit(1);
  }

  try {
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
}

function applyPreset(preset: 'conservative' | 'balanced' | 'aggressive' | 'development') {
  const validPresets = ['conservative', 'balanced', 'aggressive', 'development'];
  
  if (!preset || !validPresets.includes(preset)) {
    console.error(`❌ Invalid preset. Valid options: ${validPresets.join(', ')}`);
    process.exit(1);
  }
  
  try {
    configManager.applyPreset(preset);
    console.log(`✅ Applied ${preset} preset configuration`);
    
    // Show summary
    const config = configManager.getConfig();
    const detection = config.detection;
    console.log('\n📊 Updated Configuration Summary:');
    console.log(`  • Volume Spike Threshold: ${detection.signals.volumeSpike.multiplier}x`);
    console.log(`  • Price Movement Threshold: ${detection.signals.priceMovement.percentageThreshold}%`);
    console.log(`  • Correlation Threshold: ${detection.signals.crossMarketCorrelation.correlationThreshold}`);
    console.log(`  • Z-Score Threshold: ${detection.statistical.anomalyDetection.zScoreThreshold}`);
    
  } catch (error) {
    console.error(`❌ Error: ${(error as Error).message}`);
    process.exit(1);
  }
}

function validateConfiguration() {
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
    console.log(`  • Refresh Interval: ${detection.markets.refreshIntervalMs / 1000}s`);
    
    // Show performance config
    const performance = config.performance;
    console.log('\n⚡ Performance Configuration:');
    console.log(`  • Max Concurrent Requests: ${performance.processing.maxConcurrentRequests}`);
    console.log(`  • Request Timeout: ${performance.processing.requestTimeoutMs / 1000}s`);
    console.log(`  • Max Data Points: ${performance.memory.maxHistoricalDataPoints.toLocaleString()}`);
    console.log(`  • Buffer Size: ${performance.memory.maxRingBufferSize}`);
    
    // Show feature flags
    const features = config.features;
    console.log('\n🚩 Feature Flags:');
    console.log(`  • Cross-Market Detection: ${features.enableCrossMarketDetection ? '✅' : '❌'}`);
    console.log(`  • Microstructure Analysis: ${features.enableMicrostructureAnalysis ? '✅' : '❌'}`);
    console.log(`  • Statistical Models: ${features.enableStatisticalModels ? '✅' : '❌'}`);
    console.log(`  • Backtesting: ${features.enableBacktesting ? '✅' : '❌'}`);
    console.log(`  • Web Dashboard: ${features.enableWebDashboard ? '✅' : '❌'}`);
    
  } catch (error) {
    console.error(`❌ Configuration validation failed: ${(error as Error).message}`);
    process.exit(1);
  }
}

function exportConfiguration(filePath?: string) {
  try {
    const outputPath = filePath || './exported-config.json';
    configManager.exportConfig(outputPath);
    console.log(`✅ Configuration exported to ${outputPath}`);
  } catch (error) {
    console.error(`❌ Error: ${(error as Error).message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}