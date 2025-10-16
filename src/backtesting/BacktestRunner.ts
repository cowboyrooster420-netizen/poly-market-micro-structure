import { BacktestEngine, BacktestResult, BacktestConfig } from './BacktestEngine';
export { BacktestConfig } from './BacktestEngine';
import { DatabaseManager } from '../data/database';
import { DataAccessLayer } from '../data/DataAccessLayer';
import { BotConfig } from '../types';
import { logger } from '../utils/logger';

export class BacktestRunner {
  private backtestEngine: BacktestEngine;
  private dataLayer: DataAccessLayer;

  constructor(dataLayer: DataAccessLayer, config: BotConfig) {
    this.dataLayer = dataLayer;
    this.backtestEngine = new BacktestEngine(dataLayer, config);
  }

  async runQuickBacktest(): Promise<BacktestResult> {
    logger.info('Running quick backtest (last 7 days)...');
    
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000); // 7 days ago

    const config: BacktestConfig = {
      startDate,
      endDate,
      initialCapital: 10000,
      maxPositionSize: 1000,
      transactionCosts: 20, // 20 basis points
      slippageCosts: 10, // 10 basis points
      holdingPeriodHours: 24, // Hold for 24 hours
      confidenceThreshold: 0.6,
      maxConcurrentPositions: 5
    };

    return await this.backtestEngine.runBacktest(config);
  }

  async runFullBacktest(): Promise<BacktestResult> {
    logger.info('Running comprehensive backtest (last 30 days)...');
    
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000); // 30 days ago

    const config: BacktestConfig = {
      startDate,
      endDate,
      initialCapital: 100000,
      maxPositionSize: 10000,
      transactionCosts: 15, // 15 basis points
      slippageCosts: 10, // 10 basis points
      holdingPeriodHours: 48, // Hold for 48 hours
      confidenceThreshold: 0.7,
      maxConcurrentPositions: 10
    };

    const result = await this.backtestEngine.runBacktest(config);
    
    // Save results to database
    await this.backtestEngine.saveBacktestResults(result, config);
    
    return result;
  }

  async runCustomBacktest(config: BacktestConfig): Promise<BacktestResult> {
    logger.info(`Running custom backtest from ${config.startDate.toISOString()} to ${config.endDate.toISOString()}`);
    
    const result = await this.backtestEngine.runBacktest(config);
    
    // Save results to database
    await this.backtestEngine.saveBacktestResults(result, config);
    
    return result;
  }

  async runParameterSweep(): Promise<ParameterSweepResult> {
    logger.info('Running parameter sweep optimization...');
    
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - 14 * 24 * 60 * 60 * 1000); // 14 days ago

    const confidenceThresholds = [0.5, 0.6, 0.7, 0.8, 0.9];
    const holdingPeriods = [12, 24, 48, 72]; // hours
    const maxPositions = [3, 5, 10, 15];

    const results: ParameterTestResult[] = [];

    for (const confidence of confidenceThresholds) {
      for (const holdingPeriod of holdingPeriods) {
        for (const maxPos of maxPositions) {
          const config: BacktestConfig = {
            startDate,
            endDate,
            initialCapital: 50000,
            maxPositionSize: 5000,
            transactionCosts: 20,
            slippageCosts: 10,
            holdingPeriodHours: holdingPeriod,
            confidenceThreshold: confidence,
            maxConcurrentPositions: maxPos
          };

          try {
            const result = await this.backtestEngine.runBacktest(config);
            
            results.push({
              parameters: {
                confidenceThreshold: confidence,
                holdingPeriodHours: holdingPeriod,
                maxConcurrentPositions: maxPos
              },
              performance: {
                totalReturns: result.totalReturns,
                sharpeRatio: result.sharpeRatio,
                maxDrawdown: result.maxDrawdown,
                winRate: result.winRate,
                totalTrades: result.totalTrades
              }
            });

            logger.info(`Tested params - Confidence: ${confidence}, Holding: ${holdingPeriod}h, Max Pos: ${maxPos} - Returns: ${(result.totalReturns * 100).toFixed(2)}%`);
          } catch (error) {
            logger.error(`Error testing parameters: confidence=${confidence}, holding=${holdingPeriod}, maxPos=${maxPos}`, error);
          }
        }
      }
    }

    // Find best parameters
    const bestByReturns = results.reduce((best, current) => 
      current.performance.totalReturns > best.performance.totalReturns ? current : best
    );

    const bestBySharpe = results.reduce((best, current) => 
      current.performance.sharpeRatio > best.performance.sharpeRatio ? current : best
    );

    const bestByWinRate = results.reduce((best, current) => 
      current.performance.winRate > best.performance.winRate ? current : best
    );

    return {
      allResults: results,
      bestByReturns,
      bestBySharpe,
      bestByWinRate,
      summary: {
        totalCombinations: results.length,
        avgReturns: results.reduce((sum, r) => sum + r.performance.totalReturns, 0) / results.length,
        avgSharpe: results.reduce((sum, r) => sum + r.performance.sharpeRatio, 0) / results.length,
        avgWinRate: results.reduce((sum, r) => sum + r.performance.winRate, 0) / results.length
      }
    };
  }

  printBacktestResults(result: BacktestResult): void {
    console.log('\n' + '='.repeat(60));
    console.log('📊 BACKTEST RESULTS SUMMARY');
    console.log('='.repeat(60));
    
    console.log(`💰 Total Returns: ${(result.totalReturns * 100).toFixed(2)}%`);
    console.log(`📈 Sharpe Ratio: ${result.sharpeRatio.toFixed(3)}`);
    console.log(`📉 Max Drawdown: ${(result.maxDrawdown * 100).toFixed(2)}%`);
    console.log(`🎯 Win Rate: ${(result.winRate * 100).toFixed(1)}%`);
    console.log(`🔢 Total Trades: ${result.totalTrades}`);
    console.log(`⏱️  Avg Holding Period: ${result.avgHoldingPeriod.toFixed(1)} hours`);
    console.log(`🎲 Signal Accuracy: ${(result.signalAccuracy * 100).toFixed(1)}%`);

    if (result.signalPerformance.length > 0) {
      console.log('\n📋 SIGNAL PERFORMANCE BREAKDOWN:');
      console.log('-'.repeat(80));
      console.log('Signal Type'.padEnd(25) + 'Count'.padEnd(8) + 'Accuracy'.padEnd(10) + 'Avg Returns'.padEnd(12) + 'Sharpe');
      console.log('-'.repeat(80));
      
      for (const signal of result.signalPerformance.slice(0, 10)) { // Top 10
        const accuracy = (signal.accuracy * 100).toFixed(1) + '%';
        const avgReturns = (signal.avgReturns * 100).toFixed(2) + '%';
        const sharpe = signal.sharpeRatio.toFixed(2);
        
        console.log(
          signal.signalType.padEnd(25) + 
          signal.count.toString().padEnd(8) + 
          accuracy.padEnd(10) + 
          avgReturns.padEnd(12) + 
          sharpe
        );
      }
    }

    console.log('\n🏢 MARKET STATISTICS:');
    console.log('-'.repeat(40));
    console.log(`Markets Analyzed: ${result.marketStats.totalMarketsAnalyzed}`);
    console.log(`Markets with Signals: ${result.marketStats.marketsWithSignals}`);
    console.log(`Avg Signals per Market: ${result.marketStats.avgSignalsPerMarket.toFixed(1)}`);
    
    if (result.marketStats.mostActiveMarket) {
      console.log(`Most Active Market: ${result.marketStats.mostActiveMarket.substring(0, 12)}...`);
    }

    console.log('\n' + '='.repeat(60));
  }

  printParameterSweepResults(results: ParameterSweepResult): void {
    console.log('\n' + '='.repeat(80));
    console.log('🔍 PARAMETER OPTIMIZATION RESULTS');
    console.log('='.repeat(80));

    console.log('\n🏆 BEST PARAMETERS BY METRIC:');
    console.log('-'.repeat(60));
    
    console.log('📈 Best by Total Returns:');
    this.printParameterResult(results.bestByReturns);
    
    console.log('\n📊 Best by Sharpe Ratio:');
    this.printParameterResult(results.bestBySharpe);
    
    console.log('\n🎯 Best by Win Rate:');
    this.printParameterResult(results.bestByWinRate);

    console.log('\n📋 SUMMARY STATISTICS:');
    console.log('-'.repeat(40));
    console.log(`Total Combinations Tested: ${results.summary.totalCombinations}`);
    console.log(`Average Returns: ${(results.summary.avgReturns * 100).toFixed(2)}%`);
    console.log(`Average Sharpe Ratio: ${results.summary.avgSharpe.toFixed(3)}`);
    console.log(`Average Win Rate: ${(results.summary.avgWinRate * 100).toFixed(1)}%`);

    console.log('\n' + '='.repeat(80));
  }

  private printParameterResult(result: ParameterTestResult): void {
    const params = result.parameters;
    const perf = result.performance;
    
    console.log(`  Confidence Threshold: ${params.confidenceThreshold}`);
    console.log(`  Holding Period: ${params.holdingPeriodHours} hours`);
    console.log(`  Max Positions: ${params.maxConcurrentPositions}`);
    console.log(`  → Returns: ${(perf.totalReturns * 100).toFixed(2)}%, Sharpe: ${perf.sharpeRatio.toFixed(3)}, Win Rate: ${(perf.winRate * 100).toFixed(1)}%`);
  }

  async validateModelPerformance(): Promise<ModelValidationResult> {
    logger.info('Running model validation against recent performance...');
    
    // Get recent signals and their outcomes
    const recentSignals = await this.dataLayer.getSignals(undefined, undefined, 168); // Last 7 days
    
    let correctPredictions = 0;
    let totalValidatedSignals = 0;
    const signalTypeAccuracy = new Map<string, { correct: number; total: number }>();

    for (const signal of recentSignals) {
      if (signal.validated && signal.outcome !== undefined) {
        totalValidatedSignals++;
        
        // Check if prediction was correct
        const wasCorrect = signal.outcome === true;
        if (wasCorrect) correctPredictions++;

        // Track by signal type
        const typeStats = signalTypeAccuracy.get(signal.signalType) || { correct: 0, total: 0 };
        typeStats.total++;
        if (wasCorrect) typeStats.correct++;
        signalTypeAccuracy.set(signal.signalType, typeStats);
      }
    }

    const overallAccuracy = totalValidatedSignals > 0 ? correctPredictions / totalValidatedSignals : 0;

    const signalAccuracies: SignalTypeAccuracy[] = [];
    for (const [signalType, stats] of signalTypeAccuracy) {
      signalAccuracies.push({
        signalType,
        accuracy: stats.correct / stats.total,
        totalSignals: stats.total,
        correctPredictions: stats.correct
      });
    }

    return {
      overallAccuracy,
      totalValidatedSignals,
      correctPredictions,
      signalTypeAccuracies: signalAccuracies.sort((a, b) => b.accuracy - a.accuracy),
      recommendedThresholds: this.calculateRecommendedThresholds(signalAccuracies)
    };
  }

  private calculateRecommendedThresholds(accuracies: SignalTypeAccuracy[]): Map<string, number> {
    const thresholds = new Map<string, number>();
    
    for (const acc of accuracies) {
      // Set threshold based on accuracy - higher accuracy signals get lower thresholds
      if (acc.accuracy >= 0.8) {
        thresholds.set(acc.signalType, 0.5); // Low threshold for highly accurate signals
      } else if (acc.accuracy >= 0.6) {
        thresholds.set(acc.signalType, 0.7); // Medium threshold
      } else if (acc.accuracy >= 0.4) {
        thresholds.set(acc.signalType, 0.8); // High threshold for less accurate signals
      } else {
        thresholds.set(acc.signalType, 0.9); // Very high threshold or disable
      }
    }
    
    return thresholds;
  }
}

// Supporting interfaces
interface ParameterTestResult {
  parameters: {
    confidenceThreshold: number;
    holdingPeriodHours: number;
    maxConcurrentPositions: number;
  };
  performance: {
    totalReturns: number;
    sharpeRatio: number;
    maxDrawdown: number;
    winRate: number;
    totalTrades: number;
  };
}

interface ParameterSweepResult {
  allResults: ParameterTestResult[];
  bestByReturns: ParameterTestResult;
  bestBySharpe: ParameterTestResult;
  bestByWinRate: ParameterTestResult;
  summary: {
    totalCombinations: number;
    avgReturns: number;
    avgSharpe: number;
    avgWinRate: number;
  };
}

interface ModelValidationResult {
  overallAccuracy: number;
  totalValidatedSignals: number;
  correctPredictions: number;
  signalTypeAccuracies: SignalTypeAccuracy[];
  recommendedThresholds: Map<string, number>;
}

interface SignalTypeAccuracy {
  signalType: string;
  accuracy: number;
  totalSignals: number;
  correctPredictions: number;
}