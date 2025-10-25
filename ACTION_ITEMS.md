# PRIORITIZED ACTION ITEMS

Quick reference for implementing audit findings.

---

## 🔴 CRITICAL (Week 1) - Production Blockers

### 1. Implement Phase 4 Opportunity Scoring (2-3 days)
**Status**: NOT IMPLEMENTED
**File**: `src/services/MarketCategorizer.ts`
**Priority**: #1 - HIGHEST

```typescript
// Add this method to MarketCategorizer class
calculateOpportunityScore(market: Market): OpportunityScore {
  const volumeScore = this.calculateVolumeScore(market);      // 0-30
  const edgeScore = this.calculateEdgeScore(market);          // 0-25
  const catalystScore = this.calculateCatalystScore(market);  // 0-25
  const qualityScore = this.calculateQualityScore(market);    // 0-20

  return {
    overall: volumeScore + edgeScore + catalystScore + qualityScore,
    volumeScore,
    edgeScore,
    catalystScore,
    qualityScore
  };
}
```

**Sub-tasks**:
- [ ] Implement `calculateVolumeScore()` - Gaussian distribution around target
- [ ] Implement `calculateEdgeScore()` - Spread analysis + volatility
- [ ] Implement `calculateCatalystScore()` - Time to close + outcome count
- [ ] Implement `calculateQualityScore()` - Category + tier + blacklist
- [ ] Call from `categorizeMarket()` and populate market fields
- [ ] Add unit tests (20 tests)
- [ ] Verify AlertManager receives scores

**Impact**: Without this, alert prioritization doesn't work correctly.

---

### 2. Implement AdvancedLogger Alert Channels (1-2 days)
**Status**: STUB ONLY (4 TODOs)
**File**: `src/utils/AdvancedLogger.ts:283-290`
**Priority**: #2

```typescript
private checkAlerts(level: 'warn' | 'error' | 'critical', message: string, context?: LogContext): void {
  // Create system alert
  const alert: SystemAlert = {
    level,
    message,
    timestamp: Date.now(),
    context,
    source: 'system'
  };

  // Send to Discord via PrioritizedDiscordNotifier
  if (level === 'critical' || level === 'error') {
    this.prioritizedNotifier.sendSystemAlert(alert);
  }

  // Save to database
  this.database.saveSystemAlert(alert);

  // Append to alerts log file
  this.alertLogStream.write(JSON.stringify(alert) + '\n');
}
```

**Sub-tasks**:
- [ ] Create `SystemAlert` interface in types
- [ ] Add `system_alerts` table to SchemaBuilder
- [ ] Add `sendSystemAlert()` to PrioritizedDiscordNotifier
- [ ] Implement log file rotation (daily, keep 30 days)
- [ ] Add rate limiting (max 5 critical per hour)
- [ ] Test with simulated errors
- [ ] Add unit tests (15 tests)

**Impact**: System errors are silently ignored without this.

---

### 3. Fix AlertManager Memory Leak (1 hour)
**Status**: CLEANUP METHOD NEVER CALLED
**File**: `src/services/AlertManager.ts:352`
**Priority**: #3

```typescript
// In AlertManager constructor or initialize()
constructor() {
  // ... existing code ...

  // Schedule cleanup every hour
  setInterval(() => {
    this.cleanupHistory();
    this.cleanupCooldowns();
  }, 60 * 60 * 1000);
}

// Add new method
private cleanupCooldowns(): void {
  const now = Date.now();
  for (const [marketId, cooldowns] of this.marketCooldowns.entries()) {
    for (const [priority, expiryTime] of cooldowns.entries()) {
      if (expiryTime < now) {
        cooldowns.delete(priority);
      }
    }
    if (cooldowns.size === 0) {
      this.marketCooldowns.delete(marketId);
    }
  }
}
```

**Sub-tasks**:
- [ ] Schedule `cleanupHistory()` to run hourly
- [ ] Implement `cleanupCooldowns()` method
- [ ] Add database retention policy (30-day alert history)
- [ ] Add memory metrics to health check
- [ ] Verify memory stable over 24 hours

**Impact**: Long-running deployments will leak memory and crash.

---

### 4. Add Test Coverage - Critical Services (2-3 days)
**Status**: 8.3% coverage (4/48 files)
**Target**: 50% minimum
**Priority**: #4

**Test Files to Create**:

1. **`AlertManager.test.ts`** (25 tests)
   - Priority assignment based on score thresholds
   - Hourly rate limiting enforcement
   - Per-market cooldown enforcement
   - Quality filter validation
   - Tier adjustment logic

2. **`DataAccessLayer.test.ts`** (30 tests)
   - CRUD operations (create, read, update, delete)
   - Cache behavior (hit, miss, invalidation)
   - Error handling (connection loss, timeout)
   - Query limits and pagination

3. **`PrioritizedDiscordNotifier.test.ts`** (20 tests)
   - Priority-specific formatting
   - Retry logic (3 attempts with backoff)
   - Error handling (timeout, webhook failure)
   - Rate limit coordination with AlertManager

4. **`MarketCategorizer.test.ts`** (25 tests)
   - Category detection (13 categories)
   - Opportunity scoring (all 4 components)
   - Tier assignment (ACTIVE/WATCHLIST/IGNORED)
   - Volume threshold filtering

**Commands**:
```bash
npm test                    # Run all tests
npm test -- --coverage      # With coverage report
npm test AlertManager       # Run specific test
```

**Impact**: No validation that code works correctly without tests.

---

## 🟡 HIGH (Week 2) - Pre-Launch

### 5. Implement Cross-Market Leak Detection (3-5 days)
**Status**: DISABLED (uses Math.random())
**File**: `src/bot/EarlyBot.ts:398-400`
**Priority**: #5

**Current Code**:
```typescript
// DISABLED: Uses fake random data instead of real price data
// TODO: Reimplement with actual historical price data tracking
// await this.detectCrossMarketLeaks(topMarkets);
```

**Fix Required**:

1. Add `price_history` table:
```sql
CREATE TABLE price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id VARCHAR(100) NOT NULL,
  outcome_index INTEGER NOT NULL,
  price DECIMAL NOT NULL,
  volume DECIMAL,
  timestamp TIMESTAMP NOT NULL,
  FOREIGN KEY (market_id) REFERENCES markets(id)
);
CREATE INDEX idx_price_history_market_time ON price_history(market_id, timestamp);
```

2. Schedule price snapshots:
```typescript
// In EarlyBot.start()
setInterval(async () => {
  await this.savePriceSnapshots();
}, 5 * 60 * 1000); // Every 5 minutes
```

3. Replace Math.random() with real calculation:
```typescript
// In detectCrossMarketLeaks()
const priceChanges = new Map<string, number>();
for (const market of entityMarkets) {
  const history = await this.dataLayer.getPriceHistory(market.id, 60); // Last hour
  const priceChange = this.calculatePriceChange(history);
  priceChanges.set(market.id, priceChange);
}
```

4. Enable detection:
```typescript
// In EarlyBot.refreshMarkets() - line 398
await this.detectCrossMarketLeaks(topMarkets); // UNCOMMENT
```

**Impact**: Major feature completely disabled.

---

### 6. Remove Hardcoded Values (2 hours)
**Status**: Config duplicated in code
**Files**: Multiple
**Priority**: #6

**Changes Required**:

1. **MarketCategorizer.ts:413-420** - Delete hardcoded thresholds:
```typescript
// DELETE THIS:
private readonly volumeThresholds: Record<string, number> = {
  earnings: 2000,
  ceo_changes: 3000,
  // ...
};

// REPLACE WITH:
private get volumeThresholds(): Record<string, number> {
  return configManager.getConfig().detection.marketFiltering.categoryVolumeThresholds;
}
```

2. **WebSocketService.ts:23-27** - Make configurable:
```typescript
// DELETE:
private static readonly MAX_MESSAGES_PER_SECOND = 100;
private static readonly MAX_ORDERBOOK_LEVELS = 20;

// ADD to config:
"performance": {
  "websocket": {
    "maxMessagesPerSecond": 100,
    "maxOrderbookLevels": 20
  }
}
```

3. **PrioritizedDiscordNotifier.ts:47-48** - Make retries configurable:
```typescript
// Add to alertPrioritization config:
"delivery": {
  "maxRetryAttempts": 3,
  "retryDelayMs": 1000,
  "timeoutMs": 10000
}
```

**Impact**: Operators cannot tune parameters without code changes.

---

### 7. Complete Test Suite (2 days)
**Priority**: #7

**Additional Test Files**:
- `EnhancedPolymarketService.test.ts` (20 tests)
- `WebSocketService.test.ts` (15 tests)
- `DiscordAlerter.test.ts` (15 tests)
- `OpportunityScoring.test.ts` (20 tests)

**Integration Tests** (10 tests):
1. End-to-end market flow
2. Signal to Discord notification
3. Rate limiting enforcement
4. Database persistence
5. WebSocket market updates
6. Config hot-reload
7. Error recovery
8. Memory stability (24h)
9. Concurrent signal handling
10. Alert filtering pipeline

---

## 🟢 MEDIUM (Week 3) - Polish

### 8. Add Database Indexes (30 minutes)
**Priority**: #8

```sql
CREATE INDEX idx_signals_market_id ON signals(market_id);
CREATE INDEX idx_alert_history_market_id ON alert_history(market_id);
CREATE INDEX idx_alert_history_signal_id ON alert_history(signal_id);
CREATE INDEX idx_alert_history_priority ON alert_history(priority);
```

---

### 9. Add Missing CRUD Operations (1 day)
**Priority**: #9

Add to `DataAccessLayer.ts`:
- `deleteSignal(signalId: number)`
- `updateMarketTier(marketId: string, tier: MarketTier)`
- `updateOpportunityScore(marketId: string, score: OpportunityScore)`
- `getMarketsByCategory(category: string, limit?: number)`
- `getAlertsByPriority(priority: AlertPriority, limit?: number)`

---

### 10. Add Query Pagination (2 hours)
**Priority**: #10

Update methods:
- `getSignals(filters?, limit = 100, offset = 0)`
- `getMarketHistory(marketId, limit = 100, offset = 0)`
- `getPriceHistory(marketId, minutes, limit = 1000)`

---

### 11. Align Cache TTLs (30 minutes)
**Priority**: #11

```typescript
// DataAccessLayer.ts - Reduce cache TTL to match sync
this.cacheTTLMs = 60 * 1000; // 1 minute (was 5 minutes)

// OR invalidate on sync
async syncMarkets() {
  this.cache.invalidate('markets');
  // ... sync logic
}
```

---

### 12. News API Integration (4-5 days)
**Priority**: #12

1. Sign up for NewsAPI (https://newsapi.org/)
2. Add to `.env`:
```
NEWS_API_KEY=your_key_here
```
3. Implement in `BacktestEngine.ts`:
```typescript
async fetchNewsForMarket(market: Market, dateRange: DateRange): Promise<NewsEvent[]> {
  const keywords = this.extractKeywords(market.question);
  const news = await fetch(`https://newsapi.org/v2/everything?q=${keywords}&from=${dateRange.start}&to=${dateRange.end}`);
  return news.articles.map(article => ({
    title: article.title,
    publishedAt: new Date(article.publishedAt),
    url: article.url
  }));
}
```

---

## ⚪ LOW (Optional) - Post-Launch

### 13. Add Null Checks (1 day)
- Defensive checks for undefined market fields
- Validate database query results
- Handle missing config gracefully

### 14. Implement Unused Config (1 day)
- `config.detection.alerts.discordRateLimit`
- `config.performance.websocket.maxConnections`
- `config.performance.database.vacuumIntervalMs`

### 15. Document Algorithms (1 day)
- JSDoc comments on scoring methods
- Statistical model explanations
- Heuristic calculation details

---

## QUICK START GUIDE

### For Week 1 (Critical Fixes):

```bash
# 1. Create feature branch
git checkout -b fix/critical-audit-items

# 2. Implement opportunity scoring
# Edit: src/services/MarketCategorizer.ts
# Add calculateOpportunityScore() and sub-methods

# 3. Implement alert channels
# Edit: src/utils/AdvancedLogger.ts
# Complete checkAlerts() method

# 4. Fix memory leak
# Edit: src/services/AlertManager.ts
# Schedule cleanup in constructor

# 5. Add tests
npm test -- --watch

# 6. Build and verify
npm run build
npm test

# 7. Commit
git add -A
git commit -m "Fix critical audit items: scoring, alerts, memory leak, tests"
git push origin fix/critical-audit-items
```

---

## TESTING CHECKLIST

Before considering each phase complete:

**Week 1 - Critical**:
- [ ] Opportunity scoring returns valid scores (0-100)
- [ ] Alert channels deliver Discord + database + logs
- [ ] Memory stable after 24-hour run
- [ ] 100+ unit tests passing
- [ ] All builds passing (npm run build)

**Week 2 - High Priority**:
- [ ] Cross-market detection using real prices
- [ ] Config changes take effect without code edits
- [ ] Integration tests passing (10+ scenarios)
- [ ] Load test: 1000 markets in <30s

**Week 3 - Polish**:
- [ ] Database queries optimized (<100ms)
- [ ] All CRUD operations working
- [ ] Documentation complete
- [ ] Code review approved

---

## DEPLOYMENT READINESS

### Minimum Viable Product (Week 1):
✅ Core functionality working
✅ No memory leaks
✅ Basic test coverage
✅ Alert delivery functioning
🚀 **Ready for staging/beta**

### Production Ready (Week 2-3):
✅ All features implemented
✅ Comprehensive tests (50%+ coverage)
✅ Performance validated
✅ Documentation complete
✅ Load tested
🚀 **Ready for production**

---

**Last Updated**: October 25, 2025
**Status**: Audit complete, awaiting implementation
**Next Review**: After Week 1 critical fixes
