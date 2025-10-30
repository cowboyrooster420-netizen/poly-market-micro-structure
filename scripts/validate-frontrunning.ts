#!/usr/bin/env ts-node

/**
 * Front-Running Detection Validation CLI
 *
 * Usage:
 *   npm run validate:frontrun -- --days 30
 *   npm run validate:frontrun -- --start 2024-01-01 --end 2024-02-01
 *   npm run validate:frontrun -- --days 60 --output report.json
 */

import { DatabaseManager } from '../src/data/database';
import { FrontRunningValidator } from '../src/backtesting/FrontRunningValidator';
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
Polymarket Bot - Front-Running Detection Validator

USAGE:
  npm run validate:frontrun -- [OPTIONS]

OPTIONS:
  --days <number>          Validate last N days (default: 30)
  --start <YYYY-MM-DD>     Start date for validation
  --end <YYYY-MM-DD>       End date for validation (default: today)
  --output <path>          Save report to file (JSON format)
  --help, -h               Show this help message

EXAMPLES:
  # Validate last 30 days
  npm run validate:frontrun -- --days 30

  # Validate specific date range
  npm run validate:frontrun -- --start 2024-01-01 --end 2024-03-01

  # Save report to file
  npm run validate:frontrun -- --days 60 --output validation-report.json

WHAT THIS VALIDATES:
  - Accuracy of front-running detection (% of signals that predicted moves)
  - Lead time (how early we detected movements before they happened)
  - False positive rate (% of signals with no movement)
  - Optimal threshold recommendations

This helps tune the front-running detection parameters for better performance.
  `);
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.help) {
    printHelp();
    return;
  }

  console.log('🔍 Polymarket Bot - Front-Running Detection Validator\n');

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

  const validator = new FrontRunningValidator(database);

  // Determine date range
  const endDate = args.end ? new Date(args.end) : new Date();
  const startDate = args.start
    ? new Date(args.start)
    : new Date(endDate.getTime() - (args.days || 30) * 24 * 60 * 60 * 1000);

  console.log('📅 Date Range:', startDate.toISOString().split('T')[0], 'to', endDate.toISOString().split('T')[0]);
  console.log('');

  // Run validation
  console.log('🔬 Analyzing front-running signals...\n');

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
        correctPredictions: metrics.correctPredictions,
        accuracy: metrics.accuracy,
        falsePositiveRate: metrics.falsePositiveRate,
        avgLeadTime: metrics.avgLeadTime,
        medianLeadTime: metrics.medianLeadTime,
        minLeadTime: metrics.minLeadTime,
        maxLeadTime: metrics.maxLeadTime,
        avgMovement5min: metrics.avgMovement5min,
        avgMovement15min: metrics.avgMovement15min,
        avgMovement30min: metrics.avgMovement30min,
        avgMovement1hr: metrics.avgMovement1hr,
        byThreshold: Array.from(metrics.byThreshold.entries()).map(([, stats]) => stats),
        byConfidence: metrics.byConfidence,
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
