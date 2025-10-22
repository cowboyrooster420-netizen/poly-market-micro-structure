import { BacktestRunner, BacktestConfig } from '../backtesting/BacktestRunner';
import { DatabaseManager } from '../data/database';
import { DataAccessLayer } from '../data/DataAccessLayer';
import { getDatabaseConfig, validateDatabaseConfig } from '../config/database.config';
import { BotConfig } from '../types';
import { logger } from '../utils/logger';

export async function runBacktestingCLI(): Promise<void> {
  console.log('🚀 Polymarket Information Leak Detection - Backtesting Framework');
  console.log('='.repeat(70));

  try {
    // Initialize database and data layer
    const dbConfig = getDatabaseConfig();
    validateDatabaseConfig(dbConfig);
    const database = new DatabaseManager(dbConfig);
    await database.initialize();
    
    const dataLayer = new DataAccessLayer(database);
    
    // Create basic bot config for backtesting
    const botConfig: BotConfig = {
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
        webhookUrl: process.env.DISCORD_WEBHOOK_URL,
        enableRichEmbeds: true,
        alertRateLimit: 10,
      },
    };

    const backtestRunner = new BacktestRunner(dataLayer, botConfig);

    // Run quick backtest first
    console.log('\n📊 Running Quick Backtest (7 days)...');
    const quickResult = await backtestRunner.runQuickBacktest();
    backtestRunner.printBacktestResults(quickResult);

    // Check if we have enough data for comprehensive analysis
    if (quickResult.totalTrades > 0) {
      console.log('\n🔍 Running Comprehensive Backtest (30 days)...');
      const fullResult = await backtestRunner.runFullBacktest();
      backtestRunner.printBacktestResults(fullResult);

      if (fullResult.totalTrades >= 10) {
        console.log('\n⚙️  Running Parameter Optimization...');
        const paramResults = await backtestRunner.runParameterSweep();
        backtestRunner.printParameterSweepResults(paramResults);
      } else {
        console.log('\n⚠️  Insufficient trades for parameter optimization (need >= 10 trades)');
      }

      // Validate model performance
      console.log('\n🎯 Validating Model Performance...');
      const validationResult = await backtestRunner.validateModelPerformance();
      printValidationResults(validationResult);

    } else {
      console.log('\n⚠️  No trades found in quick backtest. This could indicate:');
      console.log('   • Insufficient historical data in database');
      console.log('   • Signal detection thresholds too high');
      console.log('   • No market activity in the selected period');
      console.log('\n💡 Recommendations:');
      console.log('   • Run the bot in live mode to collect data');
      console.log('   • Lower confidence thresholds');
      console.log('   • Check database for historical market data');
    }

    await database.close();

  } catch (error) {
    logger.error('Backtesting CLI error:', error);
    console.error('\n❌ Backtesting failed:', error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
  }
}

function printValidationResults(result: any): void {
  console.log('\n' + '='.repeat(50));
  console.log('🎯 MODEL VALIDATION RESULTS');
  console.log('='.repeat(50));
  
  console.log(`📈 Overall Accuracy: ${(result.overallAccuracy * 100).toFixed(1)}%`);
  console.log(`🔢 Total Validated Signals: ${result.totalValidatedSignals}`);
  console.log(`✅ Correct Predictions: ${result.correctPredictions}`);

  if (result.signalTypeAccuracies.length > 0) {
    console.log('\n📋 SIGNAL TYPE ACCURACY:');
    console.log('-'.repeat(60));
    console.log('Signal Type'.padEnd(25) + 'Accuracy'.padEnd(12) + 'Count'.padEnd(8) + 'Threshold');
    console.log('-'.repeat(60));
    
    for (const acc of result.signalTypeAccuracies) {
      const accuracy = (acc.accuracy * 100).toFixed(1) + '%';
      const threshold = result.recommendedThresholds.get(acc.signalType)?.toFixed(1) || 'N/A';
      
      console.log(
        acc.signalType.padEnd(25) + 
        accuracy.padEnd(12) + 
        acc.totalSignals.toString().padEnd(8) + 
        threshold
      );
    }

    console.log('\n💡 OPTIMIZATION RECOMMENDATIONS:');
    console.log('-'.repeat(40));
    
    const highAccuracy = result.signalTypeAccuracies.filter((acc: any) => acc.accuracy >= 0.8);
    const lowAccuracy = result.signalTypeAccuracies.filter((acc: any) => acc.accuracy < 0.5);
    
    if (highAccuracy.length > 0) {
      console.log(`🎯 High-performing signals (≥80% accuracy):`);
      highAccuracy.forEach((acc: any) => {
        console.log(`   • ${acc.signalType}: ${(acc.accuracy * 100).toFixed(1)}% - Consider lowering threshold`);
      });
    }
    
    if (lowAccuracy.length > 0) {
      console.log(`⚠️  Low-performing signals (<50% accuracy):`);
      lowAccuracy.forEach((acc: any) => {
        console.log(`   • ${acc.signalType}: ${(acc.accuracy * 100).toFixed(1)}% - Consider increasing threshold or disabling`);
      });
    }
  } else {
    console.log('\n⚠️  No validated signals found. Run the bot longer to collect validation data.');
  }

  console.log('\n' + '='.repeat(50));
}

// Custom backtest function for advanced users
export async function runCustomBacktest(
  startDate: string,
  endDate: string,
  initialCapital: number = 50000,
  confidenceThreshold: number = 0.7,
  holdingPeriodHours: number = 24
): Promise<void> {
  console.log('🔧 Running Custom Backtest...');
  
  try {
    const dbConfig = getDatabaseConfig();
    validateDatabaseConfig(dbConfig);
    const database = new DatabaseManager(dbConfig);
    await database.initialize();
    
    const dataLayer = new DataAccessLayer(database);
    
    const botConfig: BotConfig = {
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

    const backtestRunner = new BacktestRunner(dataLayer, botConfig);
    
    const config: BacktestConfig = {
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      initialCapital,
      maxPositionSize: initialCapital * 0.1, // 10% max position size
      transactionCosts: 20, // 20 basis points
      slippageCosts: 10, // 10 basis points
      holdingPeriodHours,
      confidenceThreshold,
      maxConcurrentPositions: 5
    };

    const result = await backtestRunner.runCustomBacktest(config);
    backtestRunner.printBacktestResults(result);

    await database.close();

  } catch (error) {
    logger.error('Custom backtesting error:', error);
    console.error('\n❌ Custom backtest failed:', error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
  }
}

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    runBacktestingCLI();
  } else if (args[0] === 'custom') {
    const startDate = args[1] || new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const endDate = args[2] || new Date().toISOString();
    const initialCapital = args[3] ? parseInt(args[3]) : 50000;
    const confidenceThreshold = args[4] ? parseFloat(args[4]) : 0.7;
    const holdingPeriodHours = args[5] ? parseInt(args[5]) : 24;
    
    runCustomBacktest(startDate, endDate, initialCapital, confidenceThreshold, holdingPeriodHours);
  } else {
    console.log('Usage:');
    console.log('  npm run backtest                                    # Run standard backtesting suite');
    console.log('  npm run backtest custom [start] [end] [capital] [threshold] [holding]  # Custom backtest');
    console.log('');
    console.log('Example:');
    console.log('  npm run backtest custom 2024-01-01 2024-01-31 100000 0.8 48');
  }
}