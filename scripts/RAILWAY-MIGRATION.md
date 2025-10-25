# Railway Migration Guide

Your bot is crashing on Railway with:
```
[ERROR] Database initialization failed:
Error: SQLITE_ERROR: no such column: category
```

This means your Railway deployment has an old database that needs migration.

## Quick Fix (3 Steps)

### Step 1: Check if Volume Exists

In Railway dashboard:
1. Go to your bot service
2. Click **Settings** tab
3. Look for **Volumes** section

**If you DON'T see a volume:**
- Your database is ephemeral (resets on each deploy)
- **Skip to Option A below** (fresh start)

**If you DO see a volume mounted at `/app/data`:**
- Your database persists across deploys
- **Use Option B below** (run migration)

---

## Option A: Fresh Database (No Data Loss - Database Recreates Automatically)

This is the **easiest option** if you don't need to preserve existing market data.

### Steps:

1. **Stop the service** (in Railway dashboard)
   - Click on your service
   - Click **Settings**
   - Scroll to **Danger Zone**
   - Click **Stop Service**

2. **Delete the volume** (if it exists)
   - In **Settings** → **Volumes**
   - Click the trash icon on the volume
   - Confirm deletion

3. **Create new volume**
   - Click **+ New Volume**
   - Mount path: `/app/data`
   - Click **Add**

4. **Start the service**
   - Railway will redeploy
   - Database will be created with correct schema automatically
   - Should start successfully

5. **Verify**
   - Check **Deployments** tab → Click latest deployment → View logs
   - Should see: `[INFO] Database initialized successfully`

---

## Option B: Migrate Existing Database (Preserves Data)

Use this if you want to keep your existing market data.

### Method 1: Using Railway CLI (Recommended)

```bash
# Install Railway CLI if you haven't
npm i -g @railway/cli

# Login
railway login

# Link to your project
railway link

# Run migration
railway run npm run migrate

# Check logs
railway logs

# If successful, restart service
railway up --detach
```

### Method 2: Using Railway Dashboard

1. **Go to your service in Railway dashboard**

2. **Click on "Deployments" tab**

3. **Find your latest deployment** (even if it's failing)

4. **Click the "..." menu** on the deployment

5. **Select "Run Command"**

6. **Enter this command:**
   ```
   npm run migrate
   ```

7. **Wait for completion** (should take 5-10 seconds)
   - You should see migration output
   - Look for: "✅ Migration completed successfully!"

8. **Redeploy the service**
   - Go to **Settings** → **Service**
   - Click **Redeploy** button
   - Or push a new commit to trigger redeploy

9. **Check logs**
   - Go to **Deployments** → Latest deployment → Logs
   - Should see: `[INFO] Database initialized successfully`

### Method 3: Add Migration to Build/Deploy Process

If Railway keeps resetting your database, you can make migration run automatically:

**Create `railway.json` in project root:**

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "NIXPACKS"
  },
  "deploy": {
    "startCommand": "npm run migrate && npm start",
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 10
  }
}
```

This will:
- Run migration before each start
- Migration is idempotent (safe to run multiple times)
- Then start the bot normally

---

## Troubleshooting

### Issue: "Database is locked"

**Cause**: Bot is still trying to start while you run migration

**Fix**:
```bash
# Stop the service first
railway service stop

# Run migration
railway run npm run migrate

# Start service
railway service start
```

### Issue: "Cannot find module 'better-sqlite3'"

**Cause**: Dependencies not installed

**Fix**: This shouldn't happen since we added it to package.json, but if it does:
```bash
# In Railway dashboard, trigger a new build
# Settings → Service → Redeploy
```

### Issue: Migration succeeds but bot still crashes

**Cause**: Database changes weren't persisted (no volume)

**Fix**: Set up a persistent volume (see Option A above)

### Issue: "ENOENT: no such file or directory" for database

**Cause**: `/app/data` directory doesn't exist or isn't writable

**Fix**:
1. Ensure volume is mounted at `/app/data` in Railway settings
2. Or change `DATABASE_PATH` environment variable to `/app/polymarket.db` (root directory)

---

## Environment Variables

Make sure these are set in Railway **Variables** tab:

```bash
# Required
DISCORD_WEBHOOK_URL=your_webhook_url_here
DATABASE_TYPE=sqlite
DATABASE_PATH=/app/data/polymarket.db

# Optional but recommended
NODE_ENV=production
LOG_LEVEL=info
```

---

## Verifying Success

After migration and restart, check Railway logs. You should see:

```
✅ Migration completed successfully!  (if you see migration output)
[INFO] Database initialized successfully
[INFO] Bot initialized successfully
[INFO] Starting opportunity detection...
[INFO] Poly Early Bot is running
```

**No more "no such column: category" errors!**

---

## Railway Volume Best Practices

1. **Always use a volume for SQLite databases**
   - Mount path: `/app/data`
   - This persists data across deployments

2. **Don't commit database files to git**
   - Already handled in `.gitignore`
   - Each deployment should manage its own database

3. **Set up automated backups**
   - Railway doesn't auto-backup volumes
   - Consider periodic backups to external storage (S3, etc.)

---

## Need Help?

If you're still having issues:

1. **Check Railway logs**: Deployments → Latest → Logs
2. **Verify environment variables**: Settings → Variables
3. **Check volume is mounted**: Settings → Volumes
4. **Try fresh database approach** (Option A) if migration fails repeatedly

---

**Last Updated**: October 25, 2025
**For**: Railway deployment with existing database
