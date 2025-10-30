#!/usr/bin/env ts-node

/**
 * Backtesting CLI Command
 *
 * Usage:
 *   npm run backtest -- --days 30                    # Backtest last 30 days
 *   npm run backtest -- --signal volume_spike        # Backtest specific signal type
 *   npm run backtest -- --all                        # Compare all signal types
 *   npm run backtest -- --start 2024-01-01 --end 2024-02-01  # Custom date range
 *   npm run backtest -- --stats                      # Show data statistics only
 */

import { DatabaseManager } from '../src/data/database';
import { BacktestOrchestrator, BacktestConfig } from '../src/backtesting/BacktestOrchestrator';
import * as fs from 'fs';
import * as path from 'path';

interface CliArgs {
  days?: number;
  start?: string;
  end?: string;
  signal?: string;
  all?: boolean;
  stats?: boolean;
  capital?: number;
  positionSize?: number;
  kelly?: boolean;
  stopLoss?: number;
  takeProfit?: number;
  output?: string;
  help?: boolean;
}

function parseArgs(): CliArgs {
  const args: CliArgs = {};

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];

    switch (arg) {
      case '--days':
        args.days = parseInt(process.argv[++i]);
        break;
      case '--start':
        args.start = process.argv[++i];
        break;
      case '--end':
        args.end = process.argv[++i];
        break;
      case '--signal':
        args.signal = process.argv[++i];
        break;
      case '--all':
        args.all = true;
        break;
      case '--stats':
        args.stats = true;
        break;
      case '--capital':
        args.capital = parseFloat(process.argv[++i]);
        break;
      case '--position-size':
        args.positionSize = parseFloat(process.argv[++i]);
        break;
      case '--kelly':
        args.kelly = true;
        break;
      case '--stop-loss':
        args.stopLoss = parseFloat(process.argv[++i]);
        break;
      case '--take-profit':
        args.takeProfit = parseFloat(process.argv[++i]);
        break;
      case '--output':
        args.output = process.argv[++i];
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
    }
  }

  return args;
}

function printHelp(): void {
  console.log(`
Polymarket Bot - Backtesting CLI

USAGE:
  npm run backtest -- [OPTIONS]

OPTIONS:
  --days <number>          Backtest last N days (default: 30)
  --start <YYYY-MM-DD>     Start date for backtest
  --end <YYYY-MM-DD>       End date for backtest (default: today)
  --signal <type>          Test specific signal type
  --all                    Compare all signal types
  --stats                  Show data statistics only (no backtest)

  --capital <number>       Initial capital (default: 10000)
  --position-size <pct>    Max position size as % of capital (default: 10)
  --kelly                  Use Kelly criterion for position sizing
  --stop-loss <pct>        Stop loss percentage (optional)
  --take-profit <pct>      Take profit percentage (optional)

  --output <path>          Save report to file (JSON format)
  --help, -h               Show this help message

EXAMPLES:
  # Backtest last 30 days
  npm run backtest -- --days 30

  # Backtest specific signal type
  npm run backtest -- --signal volume_spike --days 60

  # Compare all signal types for last 90 days
  npm run backtest -- --all --days 90

  # Custom date range with Kelly criterion
  npm run backtest -- --start 2024-01-01 --end 2024-03-01 --kelly

  # With risk management
  npm run backtest -- --days 30 --stop-loss 5 --take-profit 15

  # Show data statistics
  npm run backtest -- --stats --days 60
  `);
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.help) {
    printHelp();
    return;
  }

  console.log('🚀 Polymarket Bot - Backtesting Engine\n');

  // Initialize database
  const dbPath = process.env.SQLITE_PATH || './data/polymarket.db';

  if (!fs.existsSync(dbPath)) {
    console.error('❌ Database not found at:', dbPath);
    console.error('   Make sure the bot has been running and collecting data.');
    process.exit(1);
  }

  console.log('📂 Database:', dbPath);

  const database = new DatabaseManager({
    provider: 'sqlite',
    database: dbPath
  });
  await database.initialize();

  const orchestrator = new BacktestOrchestrator(database);

  // Determine date range
  const endDate = args.end ? new Date(args.end) : new Date();
  const startDate = args.start
    ? new Date(args.start)
    : new Date(endDate.getTime() - (args.days || 30) * 24 * 60 * 60 * 1000);

  console.log('📅 Date Range:', startDate.toISOString().split('T')[0], 'to', endDate.toISOString().split('T')[0]);
  console.log('');

  // Show data statistics if requested
  if (args.stats) {
    console.log('📊 Loading data statistics...\n');

    const stats = await orchestrator.getDataStats(startDate, endDate);

    console.log('═'.repeat(80));
    console.log('DATA STATISTICS');
    console.log('═'.repeat(80));
    console.log('');
    console.log(`Total Signals: ${stats.totalSignals}`);
    console.log(`Resolved Markets: ${stats.resolvedMarkets}`);
    console.log(`Average Confidence: ${(stats.averageConfidence * 100).toFixed(1)}%`);
    console.log('');
    console.log('Signals by Type:');
    console.log('-'.repeat(80));

    const sortedTypes = Object.entries(stats.signalsByType)
      .sort((a, b) => b[1] - a[1]);

    for (const [type, count] of sortedTypes) {
      console.log(`  ${type.padEnd(30)} ${count.toString().padStart(6)} signals`);
    }

    console.log('═'.repeat(80));
    console.log('');

    process.exit(0);
  }

  // Build backtest configuration
  const config: BacktestConfig = {
    startDate,
    endDate,
    signalTypes: args.signal ? [args.signal] : undefined,
    minConfidence: 0.5,
    resolvedOnly: false,

    initialCapital: args.capital || 10000,
    maxPositionSizePct: args.positionSize || 10,
    useKellyCriterion: args.kelly || false,
    kellyFraction: 0.25,

    slippageBps: 20,
    feeBps: 200,
    marketImpactModel: 'square_root',

    stopLossPct: args.stopLoss,
    takeProfitPct: args.takeProfit,
    maxConcurrentPositions: 10,

    defaultExitWindowHours: 24,
    useActualResolutions: true
  };

  console.log('⚙️  Configuration:');
  console.log(`   Initial Capital: $${config.initialCapital.toLocaleString()}`);
  console.log(`   Position Sizing: ${config.useKellyCriterion ? 'Kelly Criterion' : 'Fixed'} (${config.maxPositionSizePct}% max)`);
  console.log(`   Fees: ${config.feeBps / 100}% | Slippage: ${config.slippageBps / 100}%`);
  if (config.stopLossPct) console.log(`   Stop Loss: ${config.stopLossPct}%`);
  if (config.takeProfitPct) console.log(`   Take Profit: ${config.takeProfitPct}%`);
  console.log('');

  // Run backtest
  if (args.all) {
    // Comparative backtest for all signal types
    console.log('🔬 Running comparative backtest for all signal types...\n');

    const reports = await orchestrator.runComparativeBacktest(config);

    const comparativeReport = orchestrator.generateComparativeReport(reports);
    console.log(comparativeReport);

    // Save to file if requested
    if (args.output) {
      const outputData = {
        config,
        timestamp: new Date().toISOString(),
        reports: Array.from(reports.entries()).map(([type, report]) => ({
          signalType: type,
          ...report
        }))
      };

      fs.writeFileSync(args.output, JSON.stringify(outputData, null, 2));
      console.log(`\n📄 Report saved to: ${args.output}`);
    }
  } else {
    // Single backtest
    console.log('🔬 Running backtest...\n');

    const report = await orchestrator.runBacktest(config);

    // Print summary
    console.log('═'.repeat(100));
    console.log('BACKTEST RESULTS');
    console.log('═'.repeat(100));
    console.log('');

    console.log('Summary:');
    console.log(`  Total Signals: ${report.summary.totalSignals}`);
    console.log(`  Signals Traded: ${report.summary.signalsTraded}`);
    console.log(`  Win Rate: ${(report.summary.winRate * 100).toFixed(1)}%`);
    console.log(`  Profit Factor: ${report.summary.profitFactor.toFixed(2)}`);
    console.log('');

    console.log('Returns:');
    console.log(`  Total P&L: $${report.summary.totalReturn.toFixed(2)} (${report.summary.totalReturnPct.toFixed(2)}%)`);
    console.log(`  Average Win: $${report.summary.avgWin.toFixed(2)}`);
    console.log(`  Average Loss: $${report.summary.avgLoss.toFixed(2)}`);
    console.log(`  Sharpe Ratio: ${report.summary.sharpeRatio.toFixed(2)}`);
    console.log(`  Max Drawdown: ${report.summary.maxDrawdown.toFixed(2)}%`);
    console.log('');

    console.log('Costs:');
    console.log(`  Total Fees: $${report.summary.totalFees.toFixed(2)}`);
    console.log(`  Total Slippage: $${report.summary.totalSlippage.toFixed(2)}`);
    console.log('');

    console.log('Final Capital: $' + report.summary.finalCapital.toFixed(2));
    console.log('');

    // Show per-signal-type breakdown if multiple types tested
    if (report.bySignalType.size > 1) {
      console.log('Performance by Signal Type:');
      console.log('-'.repeat(100));

      const sorted = Array.from(report.bySignalType.values())
        .sort((a, b) => b.totalPnL - a.totalPnL);

      for (const stats of sorted) {
        console.log(
          `  ${stats.signalType.padEnd(30)} ` +
          `${stats.count} trades, ` +
          `${(stats.winRate * 100).toFixed(1)}% win rate, ` +
          `$${stats.avgPnL.toFixed(2)} avg P&L, ` +
          `$${stats.totalPnL.toFixed(2)} total`
        );
      }

      console.log('');
    }

    console.log('═'.repeat(100));

    // Save to file if requested
    if (args.output) {
      const outputData = {
        config,
        timestamp: new Date().toISOString(),
        report
      };

      fs.writeFileSync(args.output, JSON.stringify(outputData, null, 2));
      console.log(`\n📄 Report saved to: ${args.output}`);
    }
  }

  // Cleanup
  await database.close();
  console.log('');
  console.log('✅ Backtest complete!');
}

// Run the CLI
main().catch(error => {
  console.error('\n❌ Error running backtest:', error);
  process.exit(1);
});
