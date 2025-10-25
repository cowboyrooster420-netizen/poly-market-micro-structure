#!/usr/bin/env ts-node

/**
 * Database Migration Script
 *
 * Adds missing columns to existing database schema to support:
 * - Market categorization (Phase 1-2)
 * - Tier classification (Phase 3)
 * - Opportunity scoring (Phase 4)
 * - Alert prioritization (Phase 5-6)
 * - System alerts tracking
 *
 * This script is idempotent - safe to run multiple times.
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';

const DATABASE_PATH = process.env.SQLITE_PATH || './data/polymarket.db';
const BACKUP_DIR = './backups';

interface ColumnInfo {
  name: string;
  type: string;
}

function backupDatabase(dbPath: string): string {
  // Ensure backup directory exists
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUP_DIR, `polymarket-pre-migration-${timestamp}.db`);

  console.log(`📦 Creating backup at: ${backupPath}`);
  fs.copyFileSync(dbPath, backupPath);
  console.log('✅ Backup created successfully');

  return backupPath;
}

function getExistingColumns(db: Database.Database, tableName: string): Set<string> {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as ColumnInfo[];
  return new Set(columns.map(col => col.name));
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const result = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
  ).get(tableName);
  return !!result;
}

function indexExists(db: Database.Database, indexName: string): boolean {
  const result = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='index' AND name=?`
  ).get(indexName);
  return !!result;
}

function migrateMarketsTable(db: Database.Database): void {
  console.log('\n📊 Migrating markets table...');

  if (!tableExists(db, 'markets')) {
    console.log('⚠️  markets table does not exist - will be created by SchemaBuilder');
    return;
  }

  const existingColumns = getExistingColumns(db, 'markets');
  console.log(`Found ${existingColumns.size} existing columns`);

  const columnsToAdd = [
    // Market Categorization (Phase 1-2)
    { name: 'category', sql: 'category VARCHAR(50)' },
    { name: 'category_score', sql: 'category_score DECIMAL' },
    { name: 'is_blacklisted', sql: 'is_blacklisted BOOLEAN DEFAULT 0' },

    // Market Tier Classification (Phase 3)
    { name: 'tier', sql: 'tier VARCHAR(20)' },
    { name: 'tier_reason', sql: 'tier_reason TEXT' },
    { name: 'tier_priority', sql: 'tier_priority INTEGER' },
    { name: 'tier_updated_at', sql: 'tier_updated_at TIMESTAMP' },

    // Opportunity Scoring (Phase 4)
    { name: 'opportunity_score', sql: 'opportunity_score DECIMAL' },
    { name: 'volume_score', sql: 'volume_score DECIMAL' },
    { name: 'edge_score', sql: 'edge_score DECIMAL' },
    { name: 'catalyst_score', sql: 'catalyst_score DECIMAL' },
    { name: 'quality_score', sql: 'quality_score DECIMAL' },
    { name: 'score_updated_at', sql: 'score_updated_at TIMESTAMP' }
  ];

  let addedCount = 0;
  for (const column of columnsToAdd) {
    if (!existingColumns.has(column.name)) {
      try {
        db.prepare(`ALTER TABLE markets ADD COLUMN ${column.sql}`).run();
        console.log(`  ✅ Added column: ${column.name}`);
        addedCount++;
      } catch (error) {
        console.error(`  ❌ Failed to add column ${column.name}:`, error);
        throw error;
      }
    } else {
      console.log(`  ⏭️  Column already exists: ${column.name}`);
    }
  }

  console.log(`✅ Markets table migration complete (${addedCount} columns added)`);
}

function createSystemAlertsTable(db: Database.Database): void {
  console.log('\n🚨 Creating system_alerts table...');

  if (tableExists(db, 'system_alerts')) {
    console.log('  ⏭️  Table already exists');
    return;
  }

  const createTableSQL = `
    CREATE TABLE system_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name VARCHAR(100) NOT NULL,
      level VARCHAR(20) NOT NULL CHECK (level IN ('warn', 'error', 'critical')),
      message TEXT NOT NULL,
      component VARCHAR(100),
      operation VARCHAR(100),
      context TEXT,
      timestamp VARCHAR(50) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `;

  try {
    db.prepare(createTableSQL).run();
    console.log('  ✅ Created system_alerts table');
  } catch (error) {
    console.error('  ❌ Failed to create system_alerts table:', error);
    throw error;
  }
}

function createIndexes(db: Database.Database): void {
  console.log('\n🔍 Creating indexes...');

  const indexes = [
    // System alerts indexes
    {
      name: 'idx_system_alerts_level_time',
      sql: 'CREATE INDEX IF NOT EXISTS idx_system_alerts_level_time ON system_alerts(level, created_at DESC)'
    },
    {
      name: 'idx_system_alerts_component',
      sql: 'CREATE INDEX IF NOT EXISTS idx_system_alerts_component ON system_alerts(component, created_at DESC)'
    },
    {
      name: 'idx_system_alerts_time',
      sql: 'CREATE INDEX IF NOT EXISTS idx_system_alerts_time ON system_alerts(created_at DESC)'
    },
    // Markets table indexes for new columns
    {
      name: 'idx_markets_category',
      sql: 'CREATE INDEX IF NOT EXISTS idx_markets_category ON markets(category)'
    },
    {
      name: 'idx_markets_tier',
      sql: 'CREATE INDEX IF NOT EXISTS idx_markets_tier ON markets(tier)'
    },
    {
      name: 'idx_markets_opportunity_score',
      sql: 'CREATE INDEX IF NOT EXISTS idx_markets_opportunity_score ON markets(opportunity_score DESC)'
    }
  ];

  let createdCount = 0;
  for (const index of indexes) {
    if (!indexExists(db, index.name)) {
      try {
        db.prepare(index.sql).run();
        console.log(`  ✅ Created index: ${index.name}`);
        createdCount++;
      } catch (error) {
        console.error(`  ❌ Failed to create index ${index.name}:`, error);
        // Continue with other indexes even if one fails
      }
    } else {
      console.log(`  ⏭️  Index already exists: ${index.name}`);
    }
  }

  console.log(`✅ Index creation complete (${createdCount} indexes created)`);
}

function verifyMigration(db: Database.Database): void {
  console.log('\n🔬 Verifying migration...');

  // Check markets table columns
  const marketsColumns = getExistingColumns(db, 'markets');
  const requiredColumns = [
    'category', 'category_score', 'is_blacklisted',
    'tier', 'tier_reason', 'tier_priority', 'tier_updated_at',
    'opportunity_score', 'volume_score', 'edge_score',
    'catalyst_score', 'quality_score', 'score_updated_at'
  ];

  const missingColumns = requiredColumns.filter(col => !marketsColumns.has(col));

  if (missingColumns.length > 0) {
    console.error('  ❌ Missing columns:', missingColumns);
    throw new Error('Migration verification failed: missing columns');
  }

  // Check system_alerts table exists
  if (!tableExists(db, 'system_alerts')) {
    console.error('  ❌ system_alerts table does not exist');
    throw new Error('Migration verification failed: system_alerts table missing');
  }

  console.log('  ✅ All required columns present');
  console.log('  ✅ system_alerts table exists');
  console.log('✅ Migration verified successfully');
}

function main(): void {
  console.log('🚀 Starting Database Migration');
  console.log(`📍 Database path: ${DATABASE_PATH}`);

  // Check if database exists
  if (!fs.existsSync(DATABASE_PATH)) {
    console.log('⚠️  Database does not exist yet - will be created on first run');
    console.log('✅ No migration needed');
    process.exit(0);
  }

  let backupPath: string | null = null;
  let db: Database.Database | null = null;

  try {
    // Create backup
    backupPath = backupDatabase(DATABASE_PATH);

    // Open database
    console.log('\n📂 Opening database...');
    db = new Database(DATABASE_PATH);

    // Enable foreign keys
    db.pragma('foreign_keys = ON');

    // Run migrations
    migrateMarketsTable(db);
    createSystemAlertsTable(db);
    createIndexes(db);

    // Verify migration
    verifyMigration(db);

    console.log('\n✅ Migration completed successfully!');
    console.log(`📦 Backup saved at: ${backupPath}`);
    console.log('\n🚀 You can now start the bot');

  } catch (error) {
    console.error('\n❌ Migration failed:', error);

    if (backupPath && fs.existsSync(backupPath)) {
      console.log('\n🔄 To restore from backup:');
      console.log(`   cp ${backupPath} ${DATABASE_PATH}`);
    }

    process.exit(1);
  } finally {
    if (db) {
      db.close();
    }
  }
}

// Run migration
main();
