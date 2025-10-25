# Production Deployment Guide

**Last Updated**: After Critical Fixes (Commit f22a650)
**Status**: ✅ Ready for Production Deployment
**Risk Level**: MEDIUM (acceptable for production with monitoring)

---

## ⚠️ EXISTING DATABASE MIGRATION

**IMPORTANT**: If you have an existing database from before Phases 1-6 (market categorization, opportunity scoring, etc.), you **MUST** run the migration script first.

### Check if You Need Migration

If you see this error when starting the bot:

```
[ERROR] Database initialization failed:
Error: SQLITE_ERROR: no such column: category
```

You need to run the migration.

### Run Migration

```bash
# Install dependencies (if not already installed)
npm install

# Run the migration
npm run migrate
```

The migration will:
- Create a backup in `./backups/`
- Add 13 new columns to the `markets` table
- Create the `system_alerts` table
- Add database indexes for performance
- Verify everything worked correctly

See `scripts/README-MIGRATION.md` for detailed migration instructions.

### Fresh Installation

If this is a new installation (no existing database), skip the migration step. The database will be created automatically with the correct schema on first run.

---

## 🎯 PRE-DEPLOYMENT CHECKLIST

### 1. Environment Setup

#### Required Environment Variables

Create a `.env` file in the project root with these variables:

```bash
# Database Configuration
DATABASE_TYPE=sqlite                    # or 'postgres' for production
DATABASE_PATH=./data/polymarket.db      # SQLite path (if using SQLite)
# DATABASE_URL=postgresql://...         # PostgreSQL URL (if using Postgres)

# API Configuration
CLOB_API_URL=https://clob.polymarket.com
GAMMA_API_URL=https://gamma-api.polymarket.com

# Discord Webhook (REQUIRED for alerts)
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/YOUR_WEBHOOK_URL_HERE

# Optional: Discord Settings
DISCORD_RICH_EMBEDS=true
DISCORD_RATE_LIMIT=60

# Logging
LOG_LEVEL=info                          # debug, info, warn, error

# Node Environment
NODE_ENV=production
```

#### Verify Configuration Files

```bash
# Check detection config exists and is valid
cat config/detection-config.json

# Verify it has all required sections:
# - detection.markets
# - detection.marketFiltering
# - detection.alertPrioritization
# - detection.signals
# - features
# - performance
```

### 2. Dependencies Installation

```bash
# Install production dependencies
npm ci --production

# Or install all dependencies (includes dev tools)
npm install
```

### 3. Database Initialization

```bash
# The database will auto-initialize on first run
# Tables are created automatically from SchemaBuilder

# To manually verify schema:
sqlite3 ./data/polymarket.db ".schema"

# Expected tables:
# - markets
# - market_prices
# - orderbook_snapshots
# - trade_ticks
# - signals
# - alert_history
# - system_alerts (NEW - added in critical fixes)
# - signal_performance
# - signal_type_performance
# - microstructure_metrics
# - front_running_scores
# - backtest_results
# - anomaly_scores
```

### 4. Build the Application

```bash
# Compile TypeScript to JavaScript
npm run build

# Verify build succeeded
ls -la dist/

# Expected output: JavaScript files in dist/ directory
```

### 5. Discord Webhook Setup

**CRITICAL**: Set up Discord webhook for alerts

1. Go to your Discord server
2. Server Settings → Integrations → Webhooks
3. Create New Webhook
4. Name it "Polymarket Trading Bot"
5. Select channel (recommend: #trading-alerts)
6. Copy Webhook URL
7. Add to `.env`: `DISCORD_WEBHOOK_URL=...`

**Recommended Channel Structure**:
- `#critical-alerts` - CRITICAL priority only (production issues)
- `#trading-signals` - HIGH/MEDIUM trading opportunities
- `#bot-logs` - General bot status and performance

### 6. Test Discord Connection

```bash
# Start the bot (it will send a test alert on startup)
npm start

# Check Discord for test message
# Should see: "✅ Discord webhook connection successful"
```

---

## 🚀 DEPLOYMENT STEPS

### Method 1: Direct Deployment (Simple)

```bash
# 1. Navigate to project directory
cd /home/user/poly-market-micro-structure

# 2. Set environment variables
cp .env.example .env
nano .env  # Edit with your values

# 3. Build
npm run build

# 4. Start bot
npm start

# Bot is now running! Press Ctrl+C to stop.
```

### Method 2: Production Deployment (PM2 - Recommended)

```bash
# 1. Install PM2 globally
npm install -g pm2

# 2. Start bot with PM2
pm2 start npm --name "polymarket-bot" -- start

# 3. Save PM2 configuration
pm2 save

# 4. Setup auto-restart on system reboot
pm2 startup

# 5. View logs
pm2 logs polymarket-bot

# 6. Monitor status
pm2 status
pm2 monit
```

### Method 3: Docker Deployment

```bash
# 1. Build Docker image
docker build -t polymarket-bot .

# 2. Run container
docker run -d \
  --name polymarket-bot \
  --env-file .env \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/logs:/app/logs \
  polymarket-bot

# 3. View logs
docker logs -f polymarket-bot

# 4. Stop container
docker stop polymarket-bot
```

---

## 📊 POST-DEPLOYMENT MONITORING

### Health Checks (First 30 Minutes)

```bash
# Monitor logs
tail -f logs/advanced-bot.log
tail -f logs/alerts.log

# Check for errors
grep ERROR logs/advanced-bot.log
grep CRITICAL logs/advanced-bot.log

# Verify Discord alerts are working
# Should see messages in your Discord channel

# Check system resource usage
top -p $(pgrep -f "node.*polymarket")
```

### Key Metrics to Monitor

**1. Memory Usage** (Critical - we fixed memory leak)
```bash
# Check every hour for first 24 hours
ps aux | grep node | grep polymarket

# Memory should stay stable around 150-300MB
# Alert if > 500MB
```

**2. Alert Volume**
- Check Discord channel
- Should see CRITICAL alerts only for severe issues
- HIGH alerts for good trading opportunities
- Monitor alert rate (not too spammy, not silent)

**3. Database Growth**
```bash
# Check database size
ls -lh data/polymarket.db

# Should grow slowly (~10-50MB per day)
# Alert if > 500MB (retention policies will clean up)
```

**4. Error Rates**
```bash
# Count errors in last hour
grep ERROR logs/advanced-bot.log | tail -n 100

# Should be < 5 errors per hour
# Investigate if > 20 errors per hour
```

### Health Status Endpoint (If Enabled)

```bash
# Query bot health
curl http://localhost:3000/health

# Expected response:
{
  "running": true,
  "overall": "healthy",
  "score": 95,
  "uptime": 3600,
  "microstructureDetector": { "healthy": true },
  "polymarketService": { "healthy": true },
  "prioritizedNotifications": {
    "configured": true,
    "alertManagerStats": { ... }
  }
}
```

---

## 🔧 CONFIGURATION TUNING

### After First 24 Hours

Review and adjust these settings in `config/detection-config.json`:

#### 1. Alert Priority Thresholds

```json
{
  "detection": {
    "alertPrioritization": {
      "thresholds": {
        "critical": 80,  // Adjust if too many/few CRITICAL alerts
        "high": 60,      // Adjust based on signal quality
        "medium": 40
      }
    }
  }
}
```

**Guidelines**:
- CRITICAL: Should see 1-3 per day max
- HIGH: Should see 5-10 per day
- MEDIUM: 20-50 per day
- If seeing too many: Increase thresholds
- If seeing too few: Decrease thresholds

#### 2. Rate Limits

```json
{
  "rateLimits": {
    "critical": {
      "maxPerHour": 10,         // Reduce to 5 if too noisy
      "cooldownMinutes": 30     // Increase to 60 if getting duplicates
    },
    "high": {
      "maxPerHour": 20,         // Adjust based on volume
      "cooldownMinutes": 60
    }
  }
}
```

#### 3. Quality Filters

```json
{
  "qualityFilters": {
    "minOpportunityScore": 30,    // Increase to 40 if too many low-quality alerts
    "minCategoryScore": 2,        // Increase to 3 for stricter categorization
    "requireNonBlacklisted": true,
    "minVolumeRatio": 1.0
  }
}
```

---

## 🚨 TROUBLESHOOTING

### Issue: No Alerts Being Sent

**Symptoms**: Bot running but no Discord messages

**Checks**:
```bash
# 1. Verify Discord webhook configured
echo $DISCORD_WEBHOOK_URL

# 2. Check if alerts are being evaluated
grep "Alert decision" logs/advanced-bot.log

# 3. Check rate limiting
grep "rate_limited" logs/advanced-bot.log

# 4. Test Discord connection
curl -X POST $DISCORD_WEBHOOK_URL \
  -H "Content-Type: application/json" \
  -d '{"content": "Test message"}'
```

**Solutions**:
- Verify DISCORD_WEBHOOK_URL is set correctly
- Check Discord webhook hasn't been deleted
- Lower `minOpportunityScore` threshold
- Disable rate limiting temporarily for testing

### Issue: Too Many Alerts

**Symptoms**: Discord channel flooded with messages

**Quick Fix**:
```json
// In config/detection-config.json
{
  "alertPrioritization": {
    "thresholds": {
      "critical": 85,  // Increase from 80
      "high": 70,      // Increase from 60
      "medium": 55     // Increase from 40
    },
    "rateLimits": {
      "medium": {
        "maxPerHour": 10  // Reduce from 50
      }
    }
  }
}
```

**Restart bot** to apply changes:
```bash
pm2 restart polymarket-bot
```

### Issue: Memory Growing

**Symptoms**: Bot memory usage increasing over time

**Checks**:
```bash
# Monitor memory every hour
watch -n 3600 'ps aux | grep polymarket'

# Check cleanup logs
grep "cleanup completed" logs/advanced-bot.log
```

**Solutions**:
- Verify cleanup is running (should see log every hour)
- If still growing: Reduce retention in AlertManager.cleanupHistory()
- Restart bot daily until fixed

### Issue: Database Errors

**Symptoms**: "Database locked" or "Connection failed"

**Solutions**:
```bash
# For SQLite: Check file permissions
ls -la data/polymarket.db
chmod 666 data/polymarket.db

# For SQLite: Optimize database
sqlite3 data/polymarket.db "VACUUM;"

# For Postgres: Check connection
psql $DATABASE_URL -c "SELECT 1;"
```

### Issue: Bot Crashes

**Check logs**:
```bash
# Last 50 lines before crash
tail -n 50 logs/advanced-bot.log

# Look for stack traces
grep -A 20 "Error:" logs/advanced-bot.log
```

**Common causes**:
1. **Out of Memory**: Increase memory limit or restart more frequently
2. **Unhandled Promise Rejection**: Fixed in code, update to latest
3. **API Rate Limiting**: Increase delays between requests
4. **Network Issues**: Implement retry logic (already in code)

---

## 📈 PERFORMANCE BENCHMARKS

### Expected Resource Usage

**CPU**:
- Idle: 1-5%
- Active (processing signals): 10-30%
- Alert if sustained > 50%

**Memory**:
- Initial: 150-200 MB
- After 24h: 200-250 MB
- After 1 week: 250-300 MB
- Alert if > 500 MB (memory leak)

**Network**:
- Incoming: 1-5 KB/s (WebSocket + API)
- Outgoing: < 1 KB/s (Discord webhooks)
- Alert if > 100 KB/s sustained

**Database**:
- Size: ~10-50 MB per day
- Queries: 10-100 per minute
- Write latency: < 10ms
- Alert if latency > 100ms

### Scaling Guidelines

**Up to 100 markets**: Single instance sufficient
**100-500 markets**: Consider increasing memory (2GB)
**500+ markets**: Multi-instance with load balancer

---

## 🔄 ONGOING MAINTENANCE

### Daily Tasks

```bash
# Check bot is running
pm2 status polymarket-bot

# Review error logs
grep ERROR logs/advanced-bot.log | tail -n 20

# Check alert volume
wc -l logs/alerts.log
```

### Weekly Tasks

```bash
# Check database size
ls -lh data/polymarket.db

# Review alert statistics
sqlite3 data/polymarket.db "SELECT priority, COUNT(*) FROM alert_history WHERE timestamp > datetime('now', '-7 days') GROUP BY priority;"

# Backup database
cp data/polymarket.db backups/polymarket-$(date +%Y%m%d).db

# Clean old backups (keep last 30 days)
find backups/ -name "polymarket-*.db" -mtime +30 -delete
```

### Monthly Tasks

```bash
# Review configuration effectiveness
sqlite3 data/polymarket.db "
  SELECT
    category,
    AVG(opportunity_score) as avg_score,
    COUNT(*) as alert_count
  FROM alert_history
  WHERE timestamp > datetime('now', '-30 days')
  GROUP BY category
  ORDER BY alert_count DESC;
"

# Optimize database
sqlite3 data/polymarket.db "VACUUM; ANALYZE;"

# Update dependencies (carefully)
npm outdated
npm update --save
npm run build
npm test
```

---

## 🎬 POST-DEPLOYMENT IMPROVEMENTS

Continue development while bot runs:

### Week 1 Priorities (While Monitoring Production)

1. **Add Unit Tests** (2-3 days)
   - AlertManager: 25 tests
   - MarketCategorizer: 25 tests
   - PrioritizedDiscordNotifier: 20 tests

2. **Remove Hardcoded Values** (2 hours)
   - Move volume thresholds to config only
   - Make retry settings configurable

3. **Add Database Indexes** (30 minutes)
   - Foreign key indexes for better performance
   - See ACTION_ITEMS.md for details

### Week 2 Priorities (Based on Production Data)

4. **Cross-Market Leak Detection** (3-5 days)
   - Implement real price history tracking
   - Replace Math.random() with actual correlation

5. **Database Retention Policies** (1 day)
   - Auto-delete old records
   - Keep database size manageable

6. **Integration Tests** (2 days)
   - End-to-end testing
   - Load testing

---

## 📞 SUPPORT & CONTACT

### Logs Location

- **Main logs**: `logs/advanced-bot.log`
- **Alert logs**: `logs/alerts.log`
- **System alerts**: Database table `system_alerts`
- **PM2 logs**: `~/.pm2/logs/`

### Useful Commands

```bash
# View real-time logs
pm2 logs polymarket-bot --lines 100

# Restart bot
pm2 restart polymarket-bot

# Stop bot
pm2 stop polymarket-bot

# Delete from PM2
pm2 delete polymarket-bot

# View bot metrics
pm2 monit

# Export PM2 logs
pm2 logs polymarket-bot --out > bot-logs-$(date +%Y%m%d).log
```

### Emergency Stop

```bash
# Graceful shutdown
pm2 stop polymarket-bot

# Force kill if not responding
pm2 delete polymarket-bot
pkill -9 -f "node.*polymarket"
```

---

## ✅ DEPLOYMENT SUCCESS CRITERIA

Your deployment is successful when:

- ✅ Bot starts without errors
- ✅ Discord test alert received
- ✅ Database tables created
- ✅ No memory leaks after 24 hours
- ✅ Alerts being sent at reasonable rate (not silent, not spam)
- ✅ No critical errors in logs
- ✅ System resource usage stable

**Congratulations! Your bot is now live and monitoring Polymarket opportunities.**

Continue development and improvements while it runs in production.

---

**Last Updated**: Post-Critical Fixes
**Version**: 1.0.0-production-ready
**Status**: ✅ Ready to Deploy
