# Detection Settings Reference

**Version:** 1.0.0
**Last Updated:** October 25, 2025
**Bot Version:** poly-early-bot v1.0.0

---

## Overview

This document provides comprehensive documentation for all 135+ detection settings that control the Polymarket information leak detection bot's behavior. Use this reference to understand what each setting does, how to tune it, and when to adjust it.

### Quick Links

- [📊 Settings Inventory CSV](./settings-inventory.csv) - Sortable spreadsheet of all settings
- [🎯 Tuning Playbook](./TUNING_PLAYBOOK.md) - Practical tuning scenarios
- [⚙️ Config Files](#config-file-locations) - Where settings are defined

### Setting Categories

1. [**Alert Prioritization**](#alert-prioritization) (16 settings) - Control alert levels and rate limiting
2. [**Opportunity Scoring**](#opportunity-scoring) (20 settings) - How markets are scored 0-100
3. [**Market Filtering**](#market-filtering) (7 settings) - Which markets to monitor
4. [**Signal Detection**](#signal-detection) (12 settings) - Leak detection sensitivity
5. [**Tier Classification**](#tier-classification) (11 settings) - ACTIVE/WATCHLIST/IGNORED tiers
6. [**Category Volumes**](#category-volumes) (13 settings) - Per-category thresholds
7. [**Microstructure**](#microstructure) (9 settings) - Orderbook analysis
8. [**Statistical**](#statistical) (7 settings) - Anomaly and trend detection
9. [**Performance**](#performance) (16 settings) - System optimization
10. [**Features & Environment**](#features--environment) (8 settings) - Feature toggles

---

## Config File Locations

Settings are defined in two places:

1. **`src/config/ConfigManager.ts`** - TypeScript interface with defaults and documentation
2. **`config/detection-config.json`** - Runtime configuration (overrides defaults)

To change a setting:
1. Edit `config/detection-config.json`
2. Restart the bot (Railway auto-restarts on push)
3. Monitor impact via logs and Discord alerts

---

## Alert Prioritization

Controls how markets are prioritized and which alerts reach Discord.

### Priority Levels

Markets are scored 0-100, then assigned priority:
- **CRITICAL** (80-100): Immediate action opportunities
- **HIGH** (60-79): Strong opportunities
- **MEDIUM** (40-59): Moderate opportunities
- **LOW** (0-39): Marginal opportunities

---

### 🔴 `criticalThreshold`

**Current Value:** `80`
**Type:** Integer (60-100)
**Location:** `ConfigManager.ts:710` → `detection.alertPrioritization.thresholds.critical`
**Priority:** 🔴 CRITICAL

**What It Controls:**
Minimum opportunity score required for a CRITICAL alert. Markets scoring 80+ trigger immediate Discord notifications with @everyone mention.

**Impact:**
- **Lower (70-75)**: More CRITICAL alerts
  - ✅ Catch more opportunities
  - ⚠️ Alert fatigue, reduced urgency perception
  - ⚠️ More false positives at CRITICAL level
- **Current (80)**: Balanced, proven in testing
  - ✅ True high-value opportunities
  - ✅ Maintains urgency and attention
- **Higher (85-90)**: Fewer CRITICAL alerts
  - ✅ Only exceptional opportunities
  - ⚠️ May miss some good opportunities
  - ✅ Maximum signal-to-noise ratio

**Recommended Range:** 75-85
**Production Tested:** 80 (baseline)

**Related Settings:**
- `highThreshold` - Must be lower than CRITICAL
- `maxPerHourCritical` - Rate limit for CRITICAL
- `minOpportunityScore` - Absolute floor before any alert

**Tuning Strategy:**
1. **Start at 80** (default)
2. **Monitor for 48 hours** - Track CRITICAL alert frequency
3. **If <2 CRITICAL/day** → Consider lowering to 75
4. **If >20 CRITICAL/day** → Increase to 85
5. **Check P&L data** - Are CRITICAL alerts profitable?

**Example Scenarios:**
```
Score 82 → CRITICAL Alert
- Discord: @everyone mention
- Includes: Full analysis, chart, historical P&L
- Cooldown: 30 minutes same-market

Score 78 → HIGH Alert
- Discord: Regular notification
- Less detail than CRITICAL
- Cooldown: 60 minutes same-market
```

**Code Reference:**
```typescript
// src/services/AlertManager.ts:156
if (adjustedScore >= this.config.thresholds.critical) {
  return AlertPriority.CRITICAL;
}
```

---

### 🔴 `highThreshold`

**Current Value:** `60`
**Type:** Integer (40-80)
**Location:** `ConfigManager.ts:711` → `detection.alertPrioritization.thresholds.high`
**Priority:** 🔴 CRITICAL

**What It Controls:**
Minimum score for HIGH priority alerts. Markets scoring 60-79 are strong opportunities worth attention.

**Impact:**
- **Lower (50-55)**: More HIGH alerts
  - ✅ More opportunities
  - ⚠️ Discord notification volume increases
  - ⚠️ May dilute HIGH category quality
- **Current (60)**: Balanced
  - ✅ Genuine opportunities
  - ✅ Manageable alert volume
- **Higher (65-70)**: Fewer HIGH alerts
  - ✅ Higher quality HIGH signals
  - ⚠️ May miss moderate opportunities
  - ✅ Focus on best opportunities

**Recommended Range:** 55-70
**Production Tested:** 60 (baseline)

**Related Settings:**
- `criticalThreshold` - Must be higher than HIGH
- `mediumThreshold` - Must be lower than HIGH
- `maxPerHourHigh` - Rate limit (default: 20/hour)

**Tuning Strategy:**
1. **Monitor HIGH alert win rate** in P&L data
2. **If win rate <50%** → Increase threshold to 65-70
3. **If missing opportunities** → Decrease to 55
4. **Balance with rate limits** - Adjust both together

**Interaction with Tiers:**
- ACTIVE tier: No adjustment (score as-is)
- WATCHLIST tier: +5 score boost (55 becomes 60, reaches HIGH)

---

### 🟠 `mediumThreshold`

**Current Value:** `40`
**Type:** Integer (20-60)
**Location:** `ConfigManager.ts:712` → `detection.alertPrioritization.thresholds.medium`
**Priority:** 🟠 HIGH

**What It Controls:**
Minimum score for MEDIUM priority alerts. Markets scoring 40-59 are moderate opportunities.

**Impact:**
- **Lower (30-35)**: More MEDIUM alerts
  - ✅ Broader opportunity coverage
  - ⚠️ Higher notification volume
  - ⚠️ Lower average quality
- **Current (40)**: Conservative filter
  - ✅ Reasonable quality floor
  - ✅ Manageable volume
- **Higher (45-50)**: Fewer MEDIUM alerts
  - ✅ Higher quality MEDIUM tier
  - ⚠️ May miss emerging opportunities

**Recommended Range:** 35-50
**Production Tested:** 40 (baseline)

**Discord Notification:**
- MEDIUM alerts: Sent to Discord (no @mention)
- LOW alerts (<40): NOT sent to Discord (database only)

**Tuning Tip:**
MEDIUM is your "noise floor" - set based on Discord tolerance. If too many alerts → raise to 45-50.

---

### 🟠 Rate Limits: `maxPerHour` Settings

Control maximum alerts per hour per priority level.

#### `maxPerHourCritical`

**Current Value:** `10`
**Type:** Integer (1-100)
**Location:** `ConfigManager.ts:131`
**Priority:** 🟠 HIGH

**What It Controls:**
Maximum CRITICAL alerts per hour (global limit, all markets combined).

**Impact:**
- **Lower (5)**: Very strict
  - ✅ Only truly exceptional alerts get through
  - ⚠️ May miss simultaneous opportunities
- **Current (10)**: Allows bursts during major events
  - ✅ Catches event-driven clusters
  - ✅ Prevents total spam
- **Higher (20+)**: Permissive
  - ⚠️ Alert fatigue risk
  - ✅ Good for high-volatility periods

**Recommended:** 5-15 depending on market conditions

**Code Behavior:**
```
Hour 1: 10 CRITICAL alerts → 11th alert blocked
Hour 2: Counter resets → 10 more allowed
```

---

#### `maxPerHourHigh`

**Current Value:** `20`
**Type:** Integer (5-100)
**Priority:** 🟠 HIGH

Most important rate limit to tune. Balance between coverage and fatigue.

**Recommended:** 10-30

---

#### `maxPerHourMedium`

**Current Value:** `50`
**Type:** Integer (10-200)
**Priority:** 🟡 MEDIUM

Can be generous since MEDIUM doesn't @mention.

**Recommended:** 30-100

---

###  Cooldown Settings

Prevent same-market alert spam.

#### `cooldownMinutesCritical`

**Current Value:** `30`
**Type:** Integer (5-120)
**Priority:** 🟡 MEDIUM

**What It Controls:**
Minimum minutes between CRITICAL alerts for the same market.

**Example:**
```
10:00 AM - Market ABC triggers CRITICAL (score 85)
10:15 AM - Market ABC score now 90 → BLOCKED (cooldown)
10:30 AM - Cooldown expires
10:31 AM - Market ABC score 92 → Alert sent
```

**Tuning:**
- **Shorter (15-20 min)**: Get updates on rapidly evolving situations
- **Longer (45-60 min)**: Reduce repeat notifications

**Recommended:** 15-45 minutes

**Other Cooldowns:**
- `cooldownMinutesHigh`: 60 minutes (recommended: 30-120)
- `cooldownMinutesMedium`: 120 minutes (recommended: 60-180)
- `cooldownMinutesLow`: 240 minutes (recommended: 120-360)

---

### 🟠 Quality Filters

#### `minOpportunityScore`

**Current Value:** `30`
**Type:** Integer (0-80)
**Location:** `ConfigManager.ts:150`
**Priority:** 🟠 HIGH

**What It Controls:**
Absolute floor - don't alert on markets scoring below this, regardless of priority.

**Impact:**
- **Lower (20-25)**: Allow more marginal alerts
- **Current (30)**: Conservative quality floor
- **Higher (40-50)**: Only strong opportunities

**Use Case:**
Set this to define "not worth my time" threshold. Even if a market qualifies for MEDIUM (40+), if it scores 28, it's filtered out.

**Recommended:** 20-40

---

#### `minCategoryScore`

**Current Value:** `2`
**Type:** Integer (0-10)
**Location:** `ConfigManager.ts:151`
**Priority:** 🟡 MEDIUM

**What It Controls:**
Minimum category keyword matches required for alerts. Prevents uncategorized/poor-match markets from alerting.

**Example:**
```
Market: "Will Tesla stock hit $300?"
Category: crypto_events (1 keyword match: "Tesla")
Result: BLOCKED (need 2+ matches)

Market: "Will Bitcoin ETF be approved by SEC in December?"
Category: crypto_events (4 matches: bitcoin, ETF, approved, SEC)
Result: ALLOWED
```

**Recommended:** 1-5 (2 is good default)

---

#### `minVolumeRatio`

**Current Value:** `0.2`
**Type:** Float (0.1-1.0)
**Location:** `ConfigManager.ts:153`
**Priority:** 🟡 MEDIUM

**What It Controls:**
Minimum volume/threshold ratio. Market must have at least 20% of its category's volume threshold.

**Example:**
```
Category: politics (threshold: $10,000)
Market volume: $1,500
Ratio: 1500/10000 = 0.15
Result: BLOCKED (need 0.2+ = $2,000+)
```

**Tuning:**
- **Lower (0.1)**: Allow thinner markets
- **Higher (0.5)**: Only well-traded markets

**Recommended:** 0.1-0.5

---

## Opportunity Scoring

Controls how markets are scored from 0-100. The score combines 4 components.

### Score Components

**Formula:**
`Total Score = (Volume × 0.3) + (Edge × 0.25) + (Catalyst × 0.25) + (Quality × 0.2)`

Must sum to 1.0 (100%)

---

### 🔴 Weight Distribution

#### `volumeScoreWeight`

**Current Value:** `0.3` (30%)
**Type:** Float (0.1-0.5)
**Location:** `ConfigManager.ts:664`
**Priority:** 🔴 CRITICAL

**What It Controls:**
How much the volume component affects the final score.

**Impact:**
- **Lower (0.2)**: Less emphasis on liquidity
  - ✅ Favor smaller, undiscovered markets
  - ⚠️ Execution risk on thin markets
- **Current (0.3)**: Balanced
  - ✅ Values liquidity without dominating
- **Higher (0.4)**: More emphasis on volume
  - ✅ Favor liquid, tradeable markets
  - ⚠️ May miss small-cap opportunities

**Tuning Constraint:**
All 4 weights must sum to 1.0:
- `volumeWeight + edgeWeight + catalystWeight + qualityWeight = 1.0`

**Example Adjustment:**
```
Want more edge-focused scoring?
- volumeWeight: 0.3 → 0.25 (-0.05)
- edgeWeight: 0.25 → 0.30 (+0.05)
- catalystWeight: 0.25 (unchanged)
- qualityWeight: 0.20 (unchanged)
Total: 1.0 ✓
```

---

#### Other Weights

- **`edgeScoreWeight`**: 0.25 (25%) - Information advantage importance
- **`catalystScoreWeight`**: 0.25 (25%) - Time urgency importance
- **`qualityScoreWeight`**: 0.20 (20%) - Market efficiency importance

**Recommended Adjustments:**

**For Day Trading:**
```
volume: 0.35 (need liquidity)
edge: 0.20
catalyst: 0.30 (time matters)
quality: 0.15
```

**For Information Edge:**
```
volume: 0.20 (can wait for liquidity)
edge: 0.40 (maximize edge)
catalyst: 0.20
quality: 0.20
```

**For Swing Trading:**
```
volume: 0.25
edge: 0.25
catalyst: 0.20 (less time-sensitive)
quality: 0.30 (want efficient markets)
```

---

### 🟠 Volume Scoring Parameters

#### `optimalVolumeMultiplier`

**Current Value:** `1.5`
**Type:** Float (1.0-3.0)
**Location:** `ConfigManager.ts:666`
**Priority:** 🟠 HIGH

**What It Controls:**
Optimal volume = category threshold × multiplier. Markets at this volume get maximum volume score (30 points).

**Example:**
```
Category: politics (threshold: $10,000)
Optimal: 10,000 × 1.5 = $15,000

Market at $15,000 volume → 30/30 volume points
Market at $10,000 volume → ~25/30 points
Market at $5,000 volume → ~15/30 points (penalty)
Market at $50,000 volume → ~20/30 points (efficiency penalty)
```

**Impact:**
- **Lower (1.2)**: Favor smaller markets
- **Higher (2.0)**: Favor larger markets

**Recommended:** 1.2-2.0

---

### 🟠 Edge Scoring Parameters

#### `highEdgeCategories`

**Location:** `ConfigManager.ts:680-692`
**Priority:** 🟠 HIGH

**What It Controls:**
Which categories get edge multipliers (information advantage).

**Current Values:**
```typescript
{
  earnings: 1.5,        // Small-cap earnings often misprice
  ceo_changes: 1.3,     // Executive turnover insider info
  mergers: 1.4,         // M&A deal leak opportunities
  court_cases: 1.3,     // Legal insider knowledge
  pardons: 1.2,         // Political insider access
  fed: 1.1,             // Moderate edge on Fed meetings
  politics: 1.2         // Election insider polls
}
```

**How It Works:**
```
Base edge score: 15/25
Category: earnings (multiplier 1.5)
Final edge score: 15 × 1.5 = 22.5/25
```

**Tuning:**
Add categories where you have information advantage. Remove categories where you don't.

---

### 🟠 Catalyst Scoring Parameters

#### `optimalDaysToClose`

**Current Value:** `4.0`
**Type:** Float (1.0-14.0)
**Location:** `ConfigManager.ts:688`
**Priority:** 🟠 HIGH

**What It Controls:**
Sweet spot for market timing. Markets closing in ~4 days get maximum catalyst score.

**Logic:**
- **Too soon** (<0.5 days): Not enough time to act
- **Optimal** (4 days): Perfect window for research + execution
- **Too far** (>30 days): Loses urgency

**Scoring Curve:**
```
30+ days → 5/25 points
14 days → 12/25 points
7 days → 20/25 points (urgency bonus)
4 days → 25/25 points (optimal)
2 days → 22/25 points
0.5 days → 10/25 points (too soon)
```

**Tuning:**
- **Shorter (2-3 days)**: For faster-moving strategies
- **Longer (7-10 days)**: For research-heavy approaches

**Recommended:** 3-7 days

---

## Market Filtering

Controls which markets enter the detection system.

### 🔴 `minVolumeThreshold`

**Current Value:** `15,000`
**Type:** Integer (1,000-100,000)
**Location:** `detection-config.json:142` / `ConfigManager.ts:245`
**Priority:** 🔴 CRITICAL

**What It Controls:**
Primary volume filter. Markets below this volume are ignored (unless they qualify for WATCHLIST tier).

**Impact:**
- **Lower (5,000)**: Monitor more markets
  - ✅ Catch emerging opportunities early
  - ⚠️ More noise, lower quality average
  - ⚠️ Higher system load
- **Current (15,000)**: Conservative, proven
  - ✅ Liquid, tradeable markets
  - ✅ Manageable market count
- **Higher (30,000)**: Only major markets
  - ✅ Highest quality
  - ⚠️ Miss small-cap opportunities

**Production Data:**
```
At 15k threshold: ~400-500 markets monitored
At 10k threshold: ~600-800 markets monitored
At 25k threshold: ~200-300 markets monitored
```

**Recommended Range:** 5,000-50,000

**Per-Category Override:**
See [Category Volumes](#category-volumes) section - some categories use lower thresholds.

---

### 🟠 `maxDaysToResolution` and `minDaysToResolution`

**Current Values:** `90` days (max), `1` day (min)
**Location:** `detection-config.json:5-6`
**Priority:** 🟠 HIGH

**What They Control:**
Time-based filter. Ignore markets resolving too far out or too soon.

**Max Days Logic:**
```
Market closes in 95 days → IGNORED (too far)
Market closes in 85 days → MONITORED
Market closes in 30 days → MONITORED
```

**Min Days Logic:**
```
Market closes in 6 hours → IGNORED (too soon)
Market closes in 2 days → MONITORED
```

**Tuning:**
- **maxDays**: 30-180 (shorter = more urgent focus)
- **minDays**: 0.5-3 (longer = avoid last-minute chaos)

**Recommended:**
- Day trading: max 30, min 1
- Swing trading: max 90, min 2
- Research-heavy: max 180, min 7

---

## Signal Detection

Controls leak detection sensitivity.

### 🔴 `volumeSpikeMultiplier`

**Current Value:** `1.2` ⚠️ (Very sensitive!)
**Type:** Float (1.1-10.0)
**Location:** `detection-config.json:91`
**Priority:** 🔴 CRITICAL

**What It Controls:**
How much volume increase triggers a volume spike signal. Detects unusual trading activity indicating potential information leaks.

**Formula:**
```
Spike detected if:
current_volume > (average_volume × multiplier)
```

**Impact:**
- **Very Low (1.1-1.3)**: EXTREMELY sensitive ⚠️
  - ✅ Catch subtle leaks
  - ⚠️ MANY false positives
  - ⚠️ Alert flood risk
- **Low (1.5-2.0)**: Sensitive
  - ✅ Good leak detection
  - ✅ Manageable false positive rate
- **Medium (2.5-3.5)**: Balanced
  - ✅ Clear spikes only
  - ⚠️ May miss subtle leaks
- **High (4.0-6.0)**: Conservative
  - ✅ Very high confidence
  - ⚠️ Miss moderate leaks

**Current Setting Analysis:**
`1.2` is VERY sensitive - a 20% volume increase triggers. This will generate many signals.

**Recommended:**
- **For leak detection**: 1.5-2.5
- **For high-confidence only**: 3.0-5.0
- **Current 1.2**: Increase to 2.0-2.5 to reduce noise

**Example:**
```
Market average volume: 10,000/hour
Multiplier: 2.0

Hour 1: 25,000 volume → 25k > (10k × 2.0) → SPIKE! 🚨
Hour 2: 18,000 volume → 18k < (10k × 2.0) → Normal
Hour 3: 21,000 volume → 21k > (10k × 2.0) → SPIKE! 🚨
```

---

### 🔴 `priceMovementThreshold`

**Current Value:** `1.5`% ⚠️ (Very sensitive!)
**Type:** Float (0.5-20.0)
**Location:** `detection-config.json:96`
**Priority:** 🔴 CRITICAL

**What It Controls:**
Price change percentage that triggers a price movement signal. Detects unusual price action indicating leak trading.

**Impact:**
- **Very Low (1-2%)**: Extremely sensitive ⚠️
  - ✅ Catch small moves
  - ⚠️ Normal volatility triggers
- **Low (3-5%)**: Sensitive
  - ✅ Meaningful moves
  - ✅ Good signal/noise ratio
- **Medium (6-10%)**: Balanced
  - ✅ Clear directional moves
  - ⚠️ May miss early signals
- **High (>10%)**: Conservative
  - ✅ Major moves only
  - ⚠️ Leak may be fully priced

**Current Setting Analysis:**
`1.5%` is VERY sensitive - will trigger on normal market volatility.

**Recommended:**
- **For leak detection**: 3-7%
- **For high-confidence**: 8-15%
- **Current 1.5%**: Increase to 3-5% to reduce noise

---

### 🟠 Window and Timing Settings

- **`volumeSpikeWindowMs`**: 180,000 (3 minutes) - Volume comparison window
- **`priceMovementWindowMs`**: 300,000 (5 minutes) - Price comparison window

**Recommended:**
- Volume window: 120,000-600,000 (2-10 minutes)
- Price window: 180,000-900,000 (3-15 minutes)

---

## Category Volumes

Per-category volume thresholds. Markets in these categories can be monitored at lower volumes than the global threshold.

### High-Edge Categories (Lower Thresholds)

```
earnings: $2,000          - Small-cap earnings edge
ceo_changes: $2,000       - Executive turnover
court_cases: $3,000       - Legal outcomes
pardons: $2,000           - Presidential pardons
hollywood_awards: $3,000  - Oscars, Emmys
```

### Standard Categories

```
mergers: $5,000           - M&A markets
sports_awards: $5,000     - MVP, championships
crypto_events: $8,000     - ETF, mainnet launches
```

### High-Volume Categories

```
fed: $10,000              - Federal Reserve
economic_data: $10,000    - CPI, jobs, GDP
politics: $10,000         - Elections (most liquid)
world_events: $15,000     - Geopolitics
macro: $20,000            - Recessions, crashes
```

### Default

```
uncategorized: $15,000    - Conservative default
```

**Tuning Strategy:**

1. **Identify your edge categories** - Where do you have information advantage?
2. **Lower thresholds** for those categories (but keep above $500 minimum)
3. **Raise thresholds** for categories where you have no edge
4. **Monitor P&L by category** - Optimize based on profitability

---

## Tier Classification

Markets are assigned to one of three tiers:

- **ACTIVE**: Above volume threshold, monitored every 30 seconds
- **WATCHLIST**: Below volume threshold but interesting signals, monitored every 5 minutes
- **IGNORED**: Blacklisted or no signals

### WATCHLIST Tier Criteria

Markets below volume threshold qualify for WATCHLIST if they meet criteria:

- **`minCategoryScore`**: 3+ keyword matches
- **`minOutcomeCount`**: 5+ outcomes (multi-outcome markets)
- **`maxDaysToClose`**: Closing within 14 days
- **`highEdgeCategories`**: In a high-edge category
- **`requireMultipleSignals`**: true (need 2+ criteria)

**Example:**
```
Market: Small earnings market ($3,000 volume)
- Below global threshold ($15,000) ❌
- Category: earnings (high-edge) ✓
- Category score: 4 keywords ✓
- Days to close: 7 days ✓
- Multiple signals: Yes (3/3) ✓
Result: WATCHLIST tier
```

---

## Microstructure

Orderbook analysis settings. Requires WebSocket connection.

### `orderbookImbalanceThreshold`

**Current Value:** `0.15`
**Recommended:** 0.10-0.30

Buy/sell imbalance ratio. Lower = more sensitive to orderbook asymmetry.

---

## Performance

System optimization settings.

### Key Settings

- **`maxMarketsToTrack`**: 100 (system capacity)
- **`refreshIntervalMs`**: 300,000 (5 min market refresh)
- **`maxConcurrentRequests`**: 10 (API rate limiting)
- **`maxHistoricalDataPoints`**: 10,000 (memory limit)

**Tuning for Resources:**

**Low Resources (1-2 GB RAM):**
```
maxMarketsToTrack: 50
maxHistoricalDataPoints: 5,000
refreshIntervalMs: 600,000 (10 min)
```

**Medium Resources (2-4 GB RAM):**
```
maxMarketsToTrack: 100
maxHistoricalDataPoints: 10,000
refreshIntervalMs: 300,000 (5 min)
```

**High Resources (4+ GB RAM):**
```
maxMarketsToTrack: 200
maxHistoricalDataPoints: 20,000
refreshIntervalMs: 180,000 (3 min)
```

---

## Quick Reference: Most Important Settings

### To Reduce Alert Volume

1. ↑ Increase `criticalThreshold` (80 → 85)
2. ↑ Increase `highThreshold` (60 → 70)
3. ↓ Decrease `maxPerHourHigh` (20 → 10)
4. ↑ Increase `minOpportunityScore` (30 → 40)
5. ↑ Increase `minVolumeThreshold` (15k → 25k)

### To Catch More Opportunities

1. ↓ Decrease `criticalThreshold` (80 → 75)
2. ↓ Decrease `highThreshold` (60 → 55)
3. ↓ Decrease `volumeSpikeMultiplier` (2.5 → 2.0)
4. ↓ Decrease `minVolumeThreshold` (15k → 10k)
5. ↓ Decrease `minCategoryScore` (2 → 1)

### To Focus on Leak Detection

1. ↓ Decrease `volumeSpikeMultiplier` (current 1.2 → keep or slightly increase to 1.5)
2. ↓ Decrease `priceMovementThreshold` (current 1.5% → keep or increase to 3%)
3. ↑ Increase `edgeScoreWeight` (0.25 → 0.30)
4. ↓ Decrease `volumeScoreWeight` (0.30 → 0.25)
5. Enable cross-market correlation detection (currently disabled)

### To Reduce False Positives

1. ↑ Increase `volumeSpikeMultiplier` (1.2 → 2.5)
2. ↑ Increase `priceMovementThreshold` (1.5% → 5%)
3. ↑ Increase `minCategoryScore` (2 → 3)
4. ↑ Increase `minVolumeRatio` (0.2 → 0.4)
5. ↑ Increase cooldown times (all +50%)

---

## Next Steps

1. **Review [Settings CSV](./settings-inventory.csv)** - Browse all 135+ settings
2. **Read [Tuning Playbook](./TUNING_PLAYBOOK.md)** - Practical adjustment scenarios
3. **Monitor bot for 48 hours** - Establish baseline metrics
4. **Make incremental changes** - Adjust 1-2 settings at a time
5. **Track P&L by setting** - Optimize based on profitability

---

**Version History:**
- v1.0.0 (2025-10-25): Initial comprehensive reference

**Feedback:**
Found an error or have suggestions? Create an issue or update this document.
