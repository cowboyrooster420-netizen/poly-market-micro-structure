# 🚀 Production Deployment Checklist

Use this checklist to ensure a smooth deployment to production.

---

## PRE-DEPLOYMENT (30 minutes)

### ✅ Environment Setup

- [ ] **Copy `.env.example` to `.env`**
  ```bash
  cp .env.example .env
  ```

- [ ] **Configure Discord Webhook**
  - [ ] Create webhook in Discord Server Settings → Integrations
  - [ ] Copy webhook URL
  - [ ] Add to `.env`: `DISCORD_WEBHOOK_URL=...`
  - [ ] Test: `curl -X POST $DISCORD_WEBHOOK_URL -H "Content-Type: application/json" -d '{"content": "Test"}'`

- [ ] **Set Database Configuration**
  - [ ] SQLite: `DATABASE_TYPE=sqlite` and `DATABASE_PATH=./data/polymarket.db`
  - [ ] OR PostgreSQL: `DATABASE_TYPE=postgres` and `DATABASE_URL=postgresql://...`

- [ ] **Verify API URLs**
  - [ ] `CLOB_API_URL=https://clob.polymarket.com` (default is fine)
  - [ ] `GAMMA_API_URL=https://gamma-api.polymarket.com` (default is fine)

- [ ] **Set Log Level**
  - [ ] Production: `LOG_LEVEL=info`
  - [ ] Debug: `LOG_LEVEL=debug` (for troubleshooting)

- [ ] **Set Node Environment**
  - [ ] `NODE_ENV=production`

### ✅ Dependencies & Build

- [ ] **Install dependencies**
  ```bash
  npm ci --production
  # OR for dev dependencies: npm install
  ```

- [ ] **Build TypeScript**
  ```bash
  npm run build
  ```

- [ ] **Verify build output**
  ```bash
  ls -la dist/
  # Should see compiled JavaScript files
  ```

### ✅ Database Migration (if upgrading from old version)

- [ ] **Check if migration needed**
  ```bash
  # If data/polymarket.db exists, you may need migration
  ls -lh data/polymarket.db
  ```

- [ ] **Run migration** (if database exists from before Phases 1-6)
  ```bash
  npm run migrate
  # Creates backup in ./backups/ before migrating
  # Adds 13 new columns to markets table
  # Creates system_alerts table
  # Creates performance indexes
  ```

- [ ] **Verify migration success**
  - [ ] Should see: "✅ Migration completed successfully!"
  - [ ] Backup created in `./backups/` directory
  - [ ] No error messages

- [ ] **Skip if fresh installation**
  - [ ] If no existing database, skip migration
  - [ ] Schema will be created automatically on first run

### ✅ Configuration Validation

- [ ] **Check detection config exists**
  ```bash
  cat config/detection-config.json | jq .
  ```

- [ ] **Verify required sections present**
  - [ ] `detection.markets`
  - [ ] `detection.marketFiltering`
  - [ ] `detection.alertPrioritization`
  - [ ] `features`
  - [ ] `performance`

- [ ] **Review alert thresholds** (in `config/detection-config.json`)
  - [ ] CRITICAL threshold: 80 (default)
  - [ ] HIGH threshold: 60 (default)
  - [ ] MEDIUM threshold: 40 (default)
  - [ ] Adjust based on your risk tolerance

### ✅ Directory Structure

- [ ] **Create required directories**
  ```bash
  mkdir -p data logs backups
  ```

- [ ] **Set permissions** (if needed)
  ```bash
  chmod 755 data logs
  ```

---

## DEPLOYMENT (15 minutes)

### Option A: Direct Deployment (Simple)

- [ ] **Start the bot**
  ```bash
  npm start
  ```

- [ ] **Verify startup messages**
  - [ ] "Starting Poly Early Bot..."
  - [ ] "Bot initialized successfully"
  - [ ] "Discord webhook connection successful"
  - [ ] "Poly Early Bot is running"

- [ ] **Check Discord for test alert**
  - [ ] Should receive a test message in your Discord channel

### Option B: PM2 Deployment (Recommended)

- [ ] **Install PM2** (if not already installed)
  ```bash
  npm install -g pm2
  ```

- [ ] **Start with PM2**
  ```bash
  pm2 start npm --name "polymarket-bot" -- start
  ```

- [ ] **Save PM2 config**
  ```bash
  pm2 save
  ```

- [ ] **Setup auto-restart**
  ```bash
  pm2 startup
  # Follow the instructions it provides
  ```

- [ ] **Verify running**
  ```bash
  pm2 status
  # Should show "online" status
  ```

### Option C: Docker Deployment

- [ ] **Build Docker image**
  ```bash
  docker build -t polymarket-bot .
  ```

- [ ] **Run container**
  ```bash
  docker run -d \
    --name polymarket-bot \
    --env-file .env \
    -v $(pwd)/data:/app/data \
    -v $(pwd)/logs:/app/logs \
    polymarket-bot
  ```

- [ ] **Check logs**
  ```bash
  docker logs -f polymarket-bot
  ```

---

## POST-DEPLOYMENT VALIDATION (First Hour)

### ✅ Immediate Checks (First 5 Minutes)

- [ ] **Bot is running**
  ```bash
  # PM2: pm2 status
  # Docker: docker ps | grep polymarket
  # Direct: ps aux | grep "node.*polymarket"
  ```

- [ ] **No startup errors**
  ```bash
  # Check last 50 log lines
  tail -n 50 logs/advanced-bot.log
  # OR: pm2 logs polymarket-bot --lines 50
  ```

- [ ] **Discord test alert received**
  - [ ] Check your Discord channel for "Discord webhook connection successful"

- [ ] **Database created**
  ```bash
  ls -lh data/polymarket.db
  # Should see database file (5-10MB initially)
  ```

### ✅ First 30 Minutes

- [ ] **Monitor logs for errors**
  ```bash
  tail -f logs/advanced-bot.log | grep -E "ERROR|CRITICAL"
  ```

- [ ] **Check memory usage**
  ```bash
  # PM2: pm2 monit
  # Direct: top -p $(pgrep -f "node.*polymarket")
  # Should be 150-250 MB
  ```

- [ ] **Verify markets being fetched**
  ```bash
  grep "Found.*markets above volume" logs/advanced-bot.log
  # Should see periodic market discovery logs
  ```

- [ ] **Check for signals detected**
  ```bash
  grep "signals detected" logs/advanced-bot.log
  # May not see signals immediately (markets need to move)
  ```

### ✅ First Hour

- [ ] **Review Discord alerts**
  - [ ] Alerts are being sent (if market activity warrants)
  - [ ] Alert rate is reasonable (not spam, not silent)
  - [ ] Alert formatting looks correct (embeds, colors, priority)

- [ ] **Database health**
  ```bash
  sqlite3 data/polymarket.db "SELECT COUNT(*) FROM markets;"
  sqlite3 data/polymarket.db "SELECT COUNT(*) FROM signals;"
  # Should see data accumulating
  ```

- [ ] **Check system alerts**
  ```bash
  sqlite3 data/polymarket.db "SELECT * FROM system_alerts ORDER BY created_at DESC LIMIT 5;"
  # Should be empty or have minor warnings only
  ```

- [ ] **Memory stable**
  ```bash
  # Check memory hasn't grown significantly
  ps aux | grep polymarket
  # Should still be 150-300 MB
  ```

---

## FIRST 24 HOURS MONITORING

### ✅ Every 4-6 Hours

- [ ] **Check bot is still running**
  ```bash
  pm2 status  # or docker ps
  ```

- [ ] **Memory usage stable**
  ```bash
  # Should NOT grow beyond 300-400 MB
  # Alert if > 500 MB
  ```

- [ ] **Review error count**
  ```bash
  grep -c ERROR logs/advanced-bot.log
  # Should be < 20 errors per 24 hours
  ```

- [ ] **Check cleanup is running**
  ```bash
  grep "cleanup completed" logs/advanced-bot.log
  # Should run every hour
  ```

### ✅ After 24 Hours

- [ ] **Performance review**
  - [ ] CPU usage: < 20% average
  - [ ] Memory: Stable (not growing)
  - [ ] Disk: Database < 100 MB
  - [ ] Network: Minimal bandwidth usage

- [ ] **Alert quality review**
  - [ ] CRITICAL alerts: 0-3 per day (should be rare)
  - [ ] HIGH alerts: 5-15 per day (good opportunities)
  - [ ] MEDIUM alerts: 20-50 per day (moderate opportunities)
  - [ ] Adjust thresholds if needed

- [ ] **Database backup**
  ```bash
  cp data/polymarket.db backups/polymarket-$(date +%Y%m%d).db
  ```

---

## CONFIGURATION TUNING (After 24-48 Hours)

Based on initial performance, tune these settings:

### ✅ If Too Many Alerts

- [ ] **Increase priority thresholds** (in `config/detection-config.json`)
  ```json
  {
    "thresholds": {
      "critical": 85,  // Up from 80
      "high": 70,      // Up from 60
      "medium": 55     // Up from 40
    }
  }
  ```

- [ ] **Tighten rate limits**
  ```json
  {
    "rateLimits": {
      "high": { "maxPerHour": 10 },    // Down from 20
      "medium": { "maxPerHour": 20 }   // Down from 50
    }
  }
  ```

- [ ] **Increase quality filters**
  ```json
  {
    "qualityFilters": {
      "minOpportunityScore": 40,  // Up from 30
      "minCategoryScore": 3        // Up from 2
    }
  }
  ```

- [ ] **Restart bot to apply**
  ```bash
  pm2 restart polymarket-bot
  ```

### ✅ If Too Few Alerts

- [ ] **Lower priority thresholds**
  ```json
  {
    "thresholds": {
      "critical": 75,  // Down from 80
      "high": 50,      // Down from 60
      "medium": 35     // Down from 40
    }
  }
  ```

- [ ] **Relax quality filters**
  ```json
  {
    "qualityFilters": {
      "minOpportunityScore": 25,  // Down from 30
      "minCategoryScore": 1        // Down from 2
    }
  }
  ```

- [ ] **Restart bot to apply**

---

## TROUBLESHOOTING

### ❌ Bot won't start

**Check**:
- [ ] `.env` file exists and has correct values
- [ ] Discord webhook URL is valid
- [ ] Dependencies installed: `npm install`
- [ ] TypeScript compiled: `npm run build`
- [ ] No port conflicts

**Fix**:
```bash
# Check detailed logs
npm start 2>&1 | tee startup.log

# Verify environment
node -e "require('dotenv').config(); console.log(process.env.DISCORD_WEBHOOK_URL)"
```

### ❌ No Discord alerts

**Check**:
- [ ] Webhook URL correct in `.env`
- [ ] Discord webhook not deleted
- [ ] Bot has detected signals: `grep "signals detected" logs/advanced-bot.log`
- [ ] Rate limiting not blocking all alerts

**Fix**:
```bash
# Test webhook manually
curl -X POST $DISCORD_WEBHOOK_URL \
  -H "Content-Type: application/json" \
  -d '{"content": "Manual test"}'

# Lower alert thresholds temporarily
# Edit config/detection-config.json
```

### ❌ High memory usage

**Check**:
- [ ] Memory growing over time (memory leak)
- [ ] Cleanup running: `grep cleanup logs/advanced-bot.log`
- [ ] Too many markets being tracked

**Fix**:
```bash
# Restart bot to clear memory
pm2 restart polymarket-bot

# Reduce max markets in config
# Set maxMarketsToTrack lower
```

### ❌ Database errors

**Check**:
- [ ] Database file permissions
- [ ] Disk space available
- [ ] SQLite not corrupted

**Fix**:
```bash
# Check permissions
ls -la data/polymarket.db

# Fix permissions
chmod 666 data/polymarket.db

# Verify database integrity
sqlite3 data/polymarket.db "PRAGMA integrity_check;"
```

---

## SUCCESS CRITERIA ✅

Your deployment is successful when:

- ✅ Bot runs for 24+ hours without crashes
- ✅ Memory usage stable (no leaks)
- ✅ Discord alerts flowing at reasonable rate
- ✅ No critical errors in logs
- ✅ Database growing normally (< 100MB/day)
- ✅ CPU usage < 30% average
- ✅ Markets being monitored and signals detected

---

## NEXT STEPS

Once deployed and stable:

1. **Continue monitoring** for first week
2. **Fine-tune configuration** based on real data
3. **Add unit tests** while bot runs (see ACTION_ITEMS.md)
4. **Implement improvements** from TODO list
5. **Set up automated backups** (daily database backups)
6. **Document any issues** for future reference

---

**Deployment Date**: ________________
**Deployed By**: ________________
**Environment**: [ ] Production  [ ] Staging  [ ] Development
**Status**: [ ] Success  [ ] Issues (document below)

**Notes**:
_____________________________________
_____________________________________
_____________________________________

