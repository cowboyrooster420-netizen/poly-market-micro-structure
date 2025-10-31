#!/usr/bin/env ts-node

/**
 * Check database statistics
 */

import { DatabaseManager } from '../src/data/database';

async function main() {
  const dbPath = process.env.SQLITE_PATH || './data/polymarket.db';

  const database = new DatabaseManager({
    provider: 'sqlite',
    database: dbPath
  });

  await database.initialize();

  // Get all table names
  const tables = await database.query(`
    SELECT name FROM sqlite_master WHERE type='table' ORDER BY name
  `);

  console.log('═'.repeat(80));
  console.log('DATABASE STATISTICS');
  console.log('═'.repeat(80));
  console.log('');

  for (const table of tables) {
    const tableName = table.name;

    // Count rows
    const countResult = await database.query(`SELECT COUNT(*) as count FROM ${tableName}`);
    const count = countResult[0].count;

    console.log(`${tableName.padEnd(30)} ${count.toString().padStart(10)} rows`);
  }

  console.log('');
  console.log('═'.repeat(80));

  await database.close();
}

main().catch(console.error);
