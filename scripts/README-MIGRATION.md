# Database Migration Guide

## Purpose

This migration script adds support for the following features to existing databases:

- **Market Categorization** (Phase 1-2): 13 categories with keyword matching
- **Market Tier Classification** (Phase 3): ACTIVE/WATCHLIST/IGNORED tiers
- **Opportunity Scoring** (Phase 4): 4-component scoring system (0-100 scale)
- **Alert Prioritization** (Phase 5-6): CRITICAL/HIGH/MEDIUM/LOW priority alerts
- **System Alerts**: Error and warning tracking

## When to Run

Run this migration if you encounter this error:

```
[ERROR] Database initialization failed:
Error: SQLITE_ERROR: no such column: category
```

This means you have an existing database from before Phases 1-6 were implemented.

## Pre-Migration Steps

### 1. Stop the Bot

```bash
# If using PM2
pm2 stop polymarket-bot

# If using Docker
docker stop polymarket-bot

# If running directly
# Press Ctrl+C to stop
```

### 2. Install Dependencies (if not already installed)

```bash
npm install
```

This will install `better-sqlite3` which is required for the migration script.

## Running the Migration

### Option 1: Using npm script (Recommended)

```bash
npm run migrate
```

### Option 2: Direct execution

```bash
ts-node scripts/migrate-database.ts
```

### Option 3: For Docker deployments

```bash
# Copy database out of container
docker cp polymarket-bot:/app/data/polymarket.db ./data/polymarket.db

# Run migration
npm run migrate

# Copy database back
docker cp ./data/polymarket.db polymarket-bot:/app/data/polymarket.db

# Restart container
docker restart polymarket-bot
```

## What the Migration Does

### 1. Creates Backup

Automatically creates a backup before making any changes:

```
./backups/polymarket-pre-migration-YYYY-MM-DDTHH-MM-SS.db
```

### 2. Adds Columns to markets Table

The script adds these columns if they don't exist:

- `category` (VARCHAR) - Market category (e.g., 'elections', 'crypto')
- `category_score` (DECIMAL) - Category match confidence score
- `is_blacklisted` (BOOLEAN) - Whether market is blacklisted
- `tier` (VARCHAR) - Market tier: ACTIVE, WATCHLIST, or IGNORED
- `tier_reason` (TEXT) - Explanation for tier assignment
- `tier_priority` (INTEGER) - Priority within tier
- `tier_updated_at` (TIMESTAMP) - Last tier update time
- `opportunity_score` (DECIMAL) - Overall opportunity score (0-100)
- `volume_score` (DECIMAL) - Volume component score
- `edge_score` (DECIMAL) - Trading edge component score
- `catalyst_score` (DECIMAL) - Catalyst timing component score
- `quality_score` (DECIMAL) - Market quality component score
- `score_updated_at` (TIMESTAMP) - Last score calculation time

### 3. Creates system_alerts Table

If the table doesn't exist, creates it with:

- `id` (PRIMARY KEY) - Auto-incrementing ID
- `name` (VARCHAR) - Alert name
- `level` (VARCHAR) - 'warn', 'error', or 'critical'
- `message` (TEXT) - Alert message
- `component` (VARCHAR) - Component that generated alert
- `operation` (VARCHAR) - Operation being performed
- `context` (TEXT) - Additional context (JSON)
- `timestamp` (VARCHAR) - Alert timestamp
- `created_at` (TIMESTAMP) - Database record creation time

### 4. Creates Indexes

Creates indexes for better query performance:

- `idx_system_alerts_level_time` - System alerts by level and time
- `idx_system_alerts_component` - System alerts by component
- `idx_system_alerts_time` - System alerts by time
- `idx_markets_category` - Markets by category
- `idx_markets_tier` - Markets by tier
- `idx_markets_opportunity_score` - Markets by opportunity score

### 5. Verifies Migration

Checks that all columns and tables were created successfully.

## Migration Output

### Successful Migration

```
🚀 Starting Database Migration
📍 Database path: ./data/polymarket.db
📦 Creating backup at: ./backups/polymarket-pre-migration-2025-10-25T14-30-00.db
✅ Backup created successfully

📊 Migrating markets table...
Found 15 existing columns
  ✅ Added column: category
  ✅ Added column: category_score
  ✅ Added column: is_blacklisted
  ✅ Added column: tier
  ✅ Added column: tier_reason
  ✅ Added column: tier_priority
  ✅ Added column: tier_updated_at
  ✅ Added column: opportunity_score
  ✅ Added column: volume_score
  ✅ Added column: edge_score
  ✅ Added column: catalyst_score
  ✅ Added column: quality_score
  ✅ Added column: score_updated_at
✅ Markets table migration complete (13 columns added)

🚨 Creating system_alerts table...
  ✅ Created system_alerts table

🔍 Creating indexes...
  ✅ Created index: idx_system_alerts_level_time
  ✅ Created index: idx_system_alerts_component
  ✅ Created index: idx_system_alerts_time
  ✅ Created index: idx_markets_category
  ✅ Created index: idx_markets_tier
  ✅ Created index: idx_markets_opportunity_score
✅ Index creation complete (6 indexes created)

🔬 Verifying migration...
  ✅ All required columns present
  ✅ system_alerts table exists
✅ Migration verified successfully

✅ Migration completed successfully!
📦 Backup saved at: ./backups/polymarket-pre-migration-2025-10-25T14-30-00.db

🚀 You can now start the bot
```

### Already Migrated

If you run the migration on an already-migrated database:

```
🚀 Starting Database Migration
📍 Database path: ./data/polymarket.db
📦 Creating backup at: ./backups/polymarket-pre-migration-2025-10-25T14-35-00.db
✅ Backup created successfully

📊 Migrating markets table...
Found 28 existing columns
  ⏭️  Column already exists: category
  ⏭️  Column already exists: category_score
  ...
✅ Markets table migration complete (0 columns added)

🚨 Creating system_alerts table...
  ⏭️  Table already exists

🔍 Creating indexes...
  ⏭️  Index already exists: idx_system_alerts_level_time
  ...
✅ Index creation complete (0 indexes created)

🔬 Verifying migration...
  ✅ All required columns present
  ✅ system_alerts table exists
✅ Migration verified successfully

✅ Migration completed successfully!
```

The script is **idempotent** - safe to run multiple times.

## Post-Migration Steps

### 1. Verify Migration

Check that the backup was created:

```bash
ls -lh backups/
```

### 2. Start the Bot

```bash
# PM2
pm2 start polymarket-bot

# Docker
docker start polymarket-bot

# Direct
npm start
```

### 3. Verify Bot Starts Successfully

```bash
# Check logs
tail -f logs/advanced-bot.log

# Or for PM2
pm2 logs polymarket-bot

# Or for Docker
docker logs -f polymarket-bot
```

You should see:

```
[INFO] Database initialized successfully
[INFO] Bot initialized successfully
[INFO] Poly Early Bot is running
```

## Troubleshooting

### Error: Database is locked

**Cause**: Bot is still running

**Fix**:
```bash
pm2 stop polymarket-bot
# or
docker stop polymarket-bot

# Then run migration again
npm run migrate
```

### Error: Cannot find module 'better-sqlite3'

**Cause**: Dependencies not installed

**Fix**:
```bash
npm install
npm run migrate
```

### Migration Failed

**Fix**: Restore from backup

```bash
# Find your backup
ls -lt backups/

# Restore it
cp backups/polymarket-pre-migration-YYYY-MM-DDTHH-MM-SS.db ./data/polymarket.db

# Check logs for specific error
cat logs/advanced-bot.log | grep ERROR
```

### Still Getting "no such column" Error

**Option 1**: Delete database and start fresh (loses all data)

```bash
rm ./data/polymarket.db
npm start  # Will create new database with correct schema
```

**Option 2**: Manual SQL migration

```bash
sqlite3 ./data/polymarket.db

-- Check existing columns
PRAGMA table_info(markets);

-- Add missing columns manually
ALTER TABLE markets ADD COLUMN category VARCHAR(50);
ALTER TABLE markets ADD COLUMN category_score DECIMAL;
-- ... (add all missing columns)

-- Exit
.exit
```

## Alternative: Fresh Database

If you don't need to preserve existing data:

```bash
# 1. Stop bot
pm2 stop polymarket-bot

# 2. Delete old database
rm ./data/polymarket.db

# 3. Start bot (creates new database)
pm2 start polymarket-bot
```

## Rollback

To rollback to pre-migration state:

```bash
# 1. Stop bot
pm2 stop polymarket-bot

# 2. Find your backup
ls -lt backups/

# 3. Restore backup
cp backups/polymarket-pre-migration-YYYY-MM-DDTHH-MM-SS.db ./data/polymarket.db

# 4. DO NOT start bot yet - it will fail with same error
# You need to either:
#   - Use an older version of the code before Phases 1-6
#   - Or delete database and start fresh
```

## Support

If you encounter issues:

1. Check backup exists in `./backups/`
2. Review migration output for specific errors
3. Check bot logs: `logs/advanced-bot.log`
4. Try running migration again (it's idempotent)
5. As last resort: delete database and start fresh

## Database Backup Best Practices

After successful migration:

```bash
# Create manual backup
cp ./data/polymarket.db ./backups/polymarket-$(date +%Y%m%d).db

# Setup automated daily backups (add to crontab)
0 2 * * * cp /path/to/poly-market-micro-structure/data/polymarket.db /path/to/poly-market-micro-structure/backups/polymarket-$(date +\%Y\%m\%d).db

# Clean old backups (keep last 30 days)
find ./backups/ -name "polymarket-*.db" -mtime +30 -delete
```

---

**Migration Version**: 1.0.0
**Last Updated**: October 25, 2025
**Compatible With**: poly-early-bot v1.0.0+
