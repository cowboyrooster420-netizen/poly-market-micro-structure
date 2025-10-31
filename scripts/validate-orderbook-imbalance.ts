#!/usr/bin/env ts-node

/**
 * Orderbook Imbalance Validation CLI
 *
 * Usage:
 *   npm run validate:imbalance -- --days 30
 *   npm run validate:imbalance -- --start 2024-01-01 --end 2024-02-01
 *   npm run validate:imbalance -- --days 60 --output report.json
 */

import { DatabaseManager } from '../src/data/database';
import { OrderbookImbalanceValidator } from '../src/backtesting/OrderbookImbalanceValidator';
import * as fs from 'fs';

interface CliArgs {
  days?: number;
  start?: string;
  end?: string;
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
Polymarket Bot - Orderbook Imbalance Validator

USAGE:
  npm run validate:imbalance -- [OPTIONS]

OPTIONS:
  --days <number>          Validate last N days (default: 30)
  --start <YYYY-MM-DD>     Start date for validation
  --end <YYYY-MM-DD>       End date for validation (default: today)
  --output <path>          Save report to file (JSON format)
  --help, -h               Show this help message

EXAMPLES:
  # Validate last 30 days
  npm run validate:imbalance -- --days 30

  # Validate specific date range
  npm run validate:imbalance -- --start 2024-01-01 --end 2024-03-01

  # Save report to file
  npm run validate:imbalance -- --days 60 --output validation-report.json

WHAT THIS VALIDATES:
  - Directional accuracy (bid>ask → price up, ask>bid → price down)
  - Optimal imbalance ratio threshold (1.5x, 2x, 3x, 5x)
  - Lead time (how quickly imbalances translate to moves)
  - Performance by market size (small, medium, large)
  - Performance by spread (tight, normal, wide)
  - Whether imbalance signals should be used at all

This helps tune the orderbook imbalance detection parameters for better performance.
  `);
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.help) {
    printHelp();
    return;
  }

  console.log('📊 Polymarket Bot - Orderbook Imbalance Validator\n');

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

  const validator = new OrderbookImbalanceValidator(database);

  // Determine date range
  const endDate = args.end ? new Date(args.end) : new Date();
  const startDate = args.start
    ? new Date(args.start)
    : new Date(endDate.getTime() - (args.days || 30) * 24 * 60 * 60 * 1000);

  console.log('📅 Date Range:', startDate.toISOString().split('T')[0], 'to', endDate.toISOString().split('T')[0]);
  console.log('');

  // Run validation
  console.log('🔬 Analyzing orderbook imbalance signals...\n');

  const metrics = await validator.validateSignals(startDate, endDate);

  // Generate and print report
  const report = validator.generateReport(metrics);
  console.log(report);

  // Save to file if requested
  if (args.output) {
    const outputData = {
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      timestamp: new Date().toISOString(),
      metrics: {
        totalSignals: metrics.totalSignals,
        bullishSignals: metrics.bullishSignals,
        bearishSignals: metrics.bearishSignals,
        neutralSignals: metrics.neutralSignals,
        bullishCorrect: metrics.bullishCorrect,
        bullishAccuracy: metrics.bullishAccuracy,
        bearishCorrect: metrics.bearishCorrect,
        bearishAccuracy: metrics.bearishAccuracy,
        overallAccuracy: metrics.overallAccuracy,
        avgMovement5min: metrics.avgMovement5min,
        avgMovement15min: metrics.avgMovement15min,
        avgMovement30min: metrics.avgMovement30min,
        avgMovement1hr: metrics.avgMovement1hr,
        avgMagnitude: metrics.avgMagnitude,
        avgLeadTime: metrics.avgLeadTime,
        medianLeadTime: metrics.medianLeadTime,
        byRatioThreshold: Array.from(metrics.byRatioThreshold.entries()).map(([, stats]) => stats),
        byMarketSize: metrics.byMarketSize,
        bySpread: metrics.bySpread,
        recommendations: metrics.recommendations
      }
    };

    fs.writeFileSync(args.output, JSON.stringify(outputData, null, 2));
    console.log(`\n📄 Report saved to: ${args.output}`);
  }

  // Cleanup
  await database.close();
  console.log('');
  console.log('✅ Validation complete!');
}

// Run the CLI
main().catch(error => {
  console.error('\n❌ Error running validation:', error);
  process.exit(1);
});
