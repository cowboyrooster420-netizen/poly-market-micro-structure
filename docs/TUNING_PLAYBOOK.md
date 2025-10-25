# Detection Settings Tuning Playbook

**Version:** 1.0.0
**Last Updated:** October 25, 2025

---

## Overview

This playbook provides practical, scenario-based guidance for tuning your Polymarket leak detection bot. Use these recipes to solve common problems and optimize performance.

### Prerequisites

- Bot running and collecting data
- At least 48 hours of operational data
- Access to P&L tracking data
- Discord webhook configured

### Related Documentation

- [📊 Settings Reference](./DETECTION_SETTINGS_REFERENCE.md) - Detailed setting explanations
- [📋 Settings CSV](./settings-inventory.csv) - All settings at a glance

---

## Quick Start: First 7 Days

### Day 1-2: Baseline Collection

**DO NOT** adjust settings yet. Let the bot run with defaults to establish baselines:

✅ **Monitor:**
- Alert frequency (CRITICAL/HIGH/MEDIUM/LOW)
- Markets monitored count
- Signal types triggering (volume spike vs price movement)
- Memory and CPU usage

✅ **Track:**
```
Total alerts: _____
CRITICAL alerts: _____
HIGH alerts: _____
MEDIUM alerts: _____

Markets monitored: _____
Avg opportunity score: _____
Max opportunity score: _____
```

### Day 3-4: Initial Tuning

Based on baseline data, make **ONE** adjustment:

**If overwhelmed by alerts (>50/day):**
```json
{
  "detection": {
    "alertPrioritization": {
      "thresholds": {
        "high": 65  // Was 60
      },
      "rateLimits": {
        "high": {
          "maxPerHour": 10  // Was 20
        }
      }
    }
  }
}
```

**If too few alerts (<5/day):**
```json
{
  "detection": {
    "alertPrioritization": {
      "thresholds": {
        "high": 55,  // Was 60
        "medium": 35  // Was 40
      }
    }
  }
}
```

### Day 5-7: Monitor and Iterate

- Evaluate impact of Day 3-4 changes
- Check P&L data (if any signals have resolved)
- Make second adjustment if needed

---

## Common Scenarios

### 🚨 Scenario 1: "Too Many Alerts - Can't Keep Up"

**Symptoms:**
- 50+ Discord notifications per day
- Alert fatigue, missing important signals
- MEDIUM alerts dominating feed

**Diagnosis:**
```bash
# Check alert distribution
grep "Alert sent" logs/advanced-bot.log | grep "priority" | sort | uniq -c
```

**Solution A: Raise Thresholds (Recommended)**

Edit `config/detection-config.json`:
```json
{
  "detection": {
    "alertPrioritization": {
      "thresholds": {
        "critical": 85,  // Was 80 - fewer CRITICAL
        "high": 70,      // Was 60 - fewer HIGH
        "medium": 50     // Was 40 - fewer MEDIUM
      }
    }
  }
}
```

**Expected Impact:**
- 60-80% reduction in alerts
- Higher average quality
- <10 alerts/day

**Solution B: Tighten Rate Limits**

```json
{
  "detection": {
    "alertPrioritization": {
      "rateLimits": {
        "critical": {
          "maxPerHour": 5  // Was 10
        },
        "high": {
          "maxPerHour": 10  // Was 20
        },
        "medium": {
          "maxPerHour": 20  // Was 50
        }
      }
    }
  }
}
```

**Expected Impact:**
- Rate-based cap on alerts
- Keeps highest-scoring signals
- Predictable alert volume

**Solution C: Raise Volume Floor**

```json
{
  "detection": {
    "markets": {
      "minVolumeThreshold": 25000  // Was 15000
    }
  }
}
```

**Expected Impact:**
- Monitor fewer markets (~200-300)
- Higher quality markets only
- Significant alert reduction

**Test Period:** 24 hours
**Rollback if:** Missing obviously good opportunities

---

### 📈 Scenario 2: "Missing Opportunities"

**Symptoms:**
- Manual research finding good markets not alerted
- Low CRITICAL alert frequency (<1/day)
- High-scoring markets (75+) not reaching HIGH threshold

**Diagnosis:**
```bash
# Check recent opportunity scores
grep "opportunity_score" logs/advanced-bot.log | tail -100 | sort -k5 -nr
```

**Solution A: Lower Alert Thresholds**

```json
{
  "detection": {
    "alertPrioritization": {
      "thresholds": {
        "critical": 75,  // Was 80
        "high": 55,      // Was 60
        "medium": 35     // Was 40
      }
    }
  }
}
```

**Expected Impact:**
- 50-100% more alerts
- Catch more opportunities
- More noise (acceptable trade-off)

**Solution B: Increase Detection Sensitivity**

```json
{
  "detection": {
    "signals": {
      "volumeSpike": {
        "multiplier": 2.0  // Was 2.5 - more sensitive
      },
      "priceMovement": {
        "percentageThreshold": 3.0  // Was 5.0 - more sensitive
      }
    }
  }
}
```

**Expected Impact:**
- More signals detected
- Catch earlier in leak cycle
- Monitor P&L to validate quality

**Solution C: Lower Volume Threshold**

```json
{
  "detection": {
    "markets": {
      "minVolumeThreshold": 10000  // Was 15000
    }
  }
}
```

**Expected Impact:**
- Monitor 600-800 markets (was 400-500)
- Catch smaller, emerging markets
- Increased system load

**Test Period:** 48 hours
**Success Metric:** Alert frequency increases without P&L decline

---

### 🎯 Scenario 3: "Too Many False Positives"

**Symptoms:**
- HIGH/CRITICAL alerts not profitable
- Normal volatility triggering signals
- Win rate <50% on signals

**Diagnosis:**
Check P&L by signal type:
```sql
SELECT signalType,
       COUNT(*) as total,
       AVG(pnl1hr) as avg_pnl,
       SUM(CASE WHEN pnl1hr > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as win_rate
FROM signal_performance
GROUP BY signalType;
```

**Solution A: Increase Signal Thresholds**

```json
{
  "detection": {
    "signals": {
      "volumeSpike": {
        "multiplier": 3.5,  // Was 2.5 - less sensitive
        "minConfidence": 0.7  // Was 0.5 - require higher confidence
      },
      "priceMovement": {
        "percentageThreshold": 7.0,  // Was 5.0 - bigger moves only
        "minVolume": 10000  // Was 5000 - require more volume
      }
    }
  }
}
```

**Expected Impact:**
- Fewer signals
- Higher quality signals
- Better win rate

**Solution B: Add Quality Filters**

```json
{
  "detection": {
    "alertPrioritization": {
      "qualityFilters": {
        "minOpportunityScore": 40,  // Was 30
        "minCategoryScore": 3,  // Was 2
        "minVolumeRatio": 0.4  // Was 0.2
      }
    }
  }
}
```

**Expected Impact:**
- Stricter quality requirements
- Only well-matched, confident signals
- Lower alert volume, higher quality

**Solution C: Adjust Scoring Weights**

If volumeSpike false positives are high:
```json
{
  "detection": {
    "opportunityScoring": {
      "volumeScore": {
        "weight": 0.25  // Was 0.30 - reduce volume influence
      },
      "edgeScore": {
        "weight": 0.30  // Was 0.25 - increase edge influence
      }
    }
  }
}
```

**Test Period:** 7 days (need enough signals to measure win rate)
**Success Metric:** Win rate increases to >55%

---

### 🔍 Scenario 4: "Optimize for Leak Detection"

**Goal:**
Focus on catching information leaks early, before they're fully priced in.

**Strategy:**

1. **Increase leak signal sensitivity**
2. **Reduce volume/liquidity emphasis**
3. **Focus on high-edge categories**

**Configuration:**

```json
{
  "detection": {
    "signals": {
      "volumeSpike": {
        "multiplier": 1.8,  // Was 2.5 - very sensitive
        "windowMs": 120000,  // 2 minutes - shorter window
        "minConfidence": 0.5
      },
      "priceMovement": {
        "percentageThreshold": 3.0,  // Was 5.0 - sensitive
        "timeWindowMs": 180000,  // 3 minutes - shorter window
        "minVolume": 3000  // Lower minimum
      },
      "crossMarketCorrelation": {
        "correlationThreshold": 0.5,  // Moderate correlation
        "minMarkets": 2,
        "zScoreThreshold": 1.5
      }
    },
    "opportunityScoring": {
      "volumeScore": {
        "weight": 0.20  // Reduce from 0.30
      },
      "edgeScore": {
        "weight": 0.35,  // Increase from 0.25
        "highEdgeCategories": {
          "earnings": 1.6,  // Boost edge categories
          "ceo_changes": 1.4,
          "mergers": 1.5,
          "court_cases": 1.4
        }
      },
      "catalystScore": {
        "weight": 0.25
      },
      "qualityScore": {
        "weight": 0.20
      }
    },
    "marketFiltering": {
      "minDaysToResolution": 0.5,  // Allow very soon closing
      "maxDaysToResolution": 30  // Reduce from 90 - focus near-term
    },
    "alertPrioritization": {
      "thresholds": {
        "critical": 75,  // Lower for leak detection
        "high": 50
      },
      "rateLimits": {
        "critical": {
          "maxPerHour": 15  // Allow more leak alerts
        },
        "high": {
          "maxPerHour": 30
        }
      }
    }
  }
}
```

**Trade-offs:**
- ✅ Catch leaks earlier
- ✅ Favor information advantage
- ⚠️ More false positives
- ⚠️ Higher alert volume
- ⚠️ May include thin markets

**Monitor:**
- Time from signal to market resolution
- P&L at early intervals (30min, 1hr)
- Signal → price movement correlation

---

### 💼 Scenario 5: "Optimize for Trading Execution"

**Goal:**
Focus on liquid, tradeable markets with clear opportunities.

**Strategy:**

1. **Emphasize volume and liquidity**
2. **Reduce noise from thin markets**
3. **Focus on established categories**

**Configuration:**

```json
{
  "detection": {
    "markets": {
      "minVolumeThreshold": 25000  // Raise from 15000
    },
    "opportunityScoring": {
      "volumeScore": {
        "weight": 0.35,  // Increase from 0.30
        "optimalVolumeMultiplier": 2.0,  // Increase from 1.5
        "illiquidityPenaltyThreshold": 0.5  // Stricter penalty
      },
      "edgeScore": {
        "weight": 0.20  // Reduce from 0.25
      },
      "catalystScore": {
        "weight": 0.25
      },
      "qualityScore": {
        "weight": 0.20,
        "spreadWeight": 0.5,  // Emphasize tight spreads
        "liquidityWeight": 0.4  // Emphasize depth
      }
    },
    "signals": {
      "volumeSpike": {
        "multiplier": 3.0,  // Less sensitive - clear spikes only
        "minConfidence": 0.7
      },
      "priceMovement": {
        "percentageThreshold": 6.0,  // Clear moves
        "minVolume": 15000  // Must be liquid
      }
    },
    "alertPrioritization": {
      "thresholds": {
        "critical": 80,
        "high": 65  // Raise from 60
      },
      "qualityFilters": {
        "minVolumeRatio": 0.5  // Must be well above threshold
      }
    }
  }
}
```

**Trade-offs:**
- ✅ Easy to execute trades
- ✅ Lower slippage
- ✅ Fewer false positives
- ⚠️ Miss small-cap opportunities
- ⚠️ May be late to some leaks

---

### 📊 Scenario 6: "Balance Alert Volume"

**Goal:**
Get ~10-20 actionable alerts per day, balanced across priorities.

**Target Distribution:**
- CRITICAL: 2-5/day
- HIGH: 5-10/day
- MEDIUM: 5-15/day
- Total: 12-30/day

**Configuration:**

```json
{
  "detection": {
    "alertPrioritization": {
      "thresholds": {
        "critical": 82,  // Slightly raised
        "high": 62,      // Slightly raised
        "medium": 42     // Slightly raised
      },
      "rateLimits": {
        "critical": {
          "maxPerHour": 5,
          "cooldownMinutes": 30
        },
        "high": {
          "maxPerHour": 15,
          "cooldownMinutes": 60
        },
        "medium": {
          "maxPerHour": 30,
          "cooldownMinutes": 120
        }
      },
      "qualityFilters": {
        "minOpportunityScore": 35,
        "minCategoryScore": 2,
        "minVolumeRatio": 0.3
      }
    },
    "signals": {
      "volumeSpike": {
        "multiplier": 2.5
      },
      "priceMovement": {
        "percentageThreshold": 5.0
      }
    }
  }
}
```

**Monitoring Strategy:**

Track daily for 7 days:
```
Day 1: __ CRIT, __ HIGH, __ MED (total: __)
Day 2: __ CRIT, __ HIGH, __ MED (total: __)
...

Target: 2-5 CRIT, 5-10 HIGH, 5-15 MED
```

**Adjustments:**
- If CRIT >5/day → Raise critical threshold +3
- If CRIT <2/day → Lower critical threshold -3
- If total >30/day → Raise all thresholds +2-5
- If total <12/day → Lower all thresholds -2-5

---

## A/B Testing Framework

### Setting Up A/B Test

**Goal:** Test if lowering `highThreshold` from 60 to 55 improves P&L.

**Step 1: Baseline Period (7 days)**
```
Current setting: highThreshold = 60
Track: All HIGH alerts, record P&L at 1hr, 24hr, resolution
```

**Step 2: Change Period (7 days)**
```
New setting: highThreshold = 55
Track: All HIGH alerts, record P&L at 1hr, 24hr, resolution
```

**Step 3: Analysis**

```sql
-- Baseline period P&L
SELECT
  AVG(pnl1hr) as avg_pnl_1hr,
  AVG(pnl24hr) as avg_pnl_24hr,
  COUNT(*) as signal_count,
  SUM(CASE WHEN pnl1hr > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as win_rate
FROM signal_performance
WHERE priority = 'HIGH'
  AND entryTime BETWEEN '2025-10-18' AND '2025-10-25';

-- Test period P&L
SELECT
  AVG(pnl1hr) as avg_pnl_1hr,
  AVG(pnl24hr) as avg_pnl_24hr,
  COUNT(*) as signal_count,
  SUM(CASE WHEN pnl1hr > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as win_rate
FROM signal_performance
WHERE priority = 'HIGH'
  AND entryTime BETWEEN '2025-10-26' AND '2025-11-02';
```

**Decision Criteria:**
- If test period P&L > baseline → **Keep new setting**
- If test period P&L < baseline → **Revert**
- If inconclusive (similar P&L) → Consider alert volume preference

**Statistical Significance:**
Need at least 30 signals in each period for meaningful comparison.

---

## Setting Interaction Patterns

### Pattern 1: Threshold + Rate Limit Balance

**Scenario:** Lower thresholds without increasing alert flood.

```json
{
  "thresholds": {
    "high": 55  // Lower threshold (was 60)
  },
  "rateLimits": {
    "high": {
      "maxPerHour": 15  // Tighter limit (was 20)
    }
  }
}
```

**Effect:** More markets qualify, but hourly cap prevents flood.

---

### Pattern 2: Scoring Weight Shifts

**Scenario:** Rebalance scoring without changing total.

```json
{
  "volumeScore": { "weight": 0.25 },  // -0.05
  "edgeScore": { "weight": 0.30 },    // +0.05
  "catalystScore": { "weight": 0.25 },
  "qualityScore": { "weight": 0.20 }
  // Total: 1.00 ✓
}
```

**Effect:** Same scale (0-100) but different priorities.

---

### Pattern 3: Multi-Setting Adjustments

**Scenario:** Comprehensive tuning for specific strategy.

**For Day Trading:**
```json
{
  "opportunityScoring": {
    "volumeScore": { "weight": 0.35 },
    "catalystScore": {
      "weight": 0.30,
      "optimalDaysToClose": 2.0
    }
  },
  "markets": {
    "minVolumeThreshold": 20000,
    "maxDaysToResolution": 14
  },
  "alertPrioritization": {
    "qualityFilters": {
      "minVolumeRatio": 0.5
    }
  }
}
```

All settings work together to favor liquid, near-term markets.

---

## Performance Optimization

### Reduce System Load

**If CPU/Memory high:**

```json
{
  "detection": {
    "markets": {
      "maxMarketsToTrack": 75,  // Reduce from 100
      "refreshIntervalMs": 600000  // 10min (was 5min)
    }
  },
  "performance": {
    "memory": {
      "maxHistoricalDataPoints": 5000,  // Reduce from 10000
      "maxRingBufferSize": 500  // Reduce from 1000
    },
    "processing": {
      "maxConcurrentRequests": 5  // Reduce from 10
    }
  }
}
```

---

## Monitoring & Metrics

### Daily Health Check

```bash
# Alert distribution
grep "\[INFO\] Alert sent" logs/advanced-bot.log | \
  grep -oP 'priority":\s*"\K[^"]+' | sort | uniq -c

# Opportunity score distribution
grep "opportunity_score" logs/advanced-bot.log | \
  grep -oP 'score":\s*\K[0-9]+' | \
  awk '{
    if ($1 >= 80) crit++;
    else if ($1 >= 60) high++;
    else if ($1 >= 40) med++;
    else low++;
  }
  END {
    print "CRITICAL: " crit;
    print "HIGH: " high;
    print "MEDIUM: " med;
    print "LOW: " low;
  }'

# Markets monitored count
grep "monitoredMarkets" logs/advanced-bot.log | tail -1
```

### Weekly P&L Review

```sql
-- P&L by priority level
SELECT
  priority,
  COUNT(*) as signals,
  AVG(pnl1hr) as avg_pnl_1hr,
  AVG(pnl24hr) as avg_pnl_24hr,
  SUM(CASE WHEN pnl1hr > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as win_rate,
  AVG(confidence) as avg_confidence
FROM signal_performance
WHERE entryTime > datetime('now', '-7 days')
GROUP BY priority;

-- P&L by signal type
SELECT
  signalType,
  COUNT(*) as signals,
  AVG(pnl1hr) as avg_pnl_1hr,
  SUM(CASE WHEN pnl1hr > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as win_rate
FROM signal_performance
WHERE entryTime > datetime('now', '-7 days')
GROUP BY signalType
ORDER BY avg_pnl_1hr DESC;
```

---

## Emergency Procedures

### Alert Storm (>100 alerts/hour)

**Immediate action:**

```json
{
  "detection": {
    "alertPrioritization": {
      "rateLimits": {
        "critical": { "maxPerHour": 3 },
        "high": { "maxPerHour": 5 },
        "medium": { "maxPerHour": 10 }
      }
    }
  }
}
```

Restart bot. Investigate root cause after storm passes.

---

### No Alerts for 24+ Hours

**Check:**
1. Is bot running? `pm2 status` or Railway logs
2. Are markets being fetched? Check logs for "Fetched and tiered markets"
3. Are scores being calculated? Check logs for "opportunity_score"
4. Are thresholds too high? Review alert thresholds

**Temporary fix:**
```json
{
  "detection": {
    "alertPrioritization": {
      "thresholds": {
        "high": 50,  // Lower significantly
        "medium": 30
      }
    }
  }
}
```

---

## Best Practices

### 1. Change One Thing at a Time

❌ **Bad:**
```
Change 5 settings at once
Can't tell which change had impact
```

✅ **Good:**
```
Change highThreshold: 60 → 55
Wait 48 hours
Measure impact
Then change next setting
```

### 2. Document Changes

Keep a tuning log:
```
2025-10-25: Lowered highThreshold 60→55
Reason: Missing opportunities
Result: +40% alerts, P&L TBD

2025-10-27: Result measured
Win rate: 58% (was 55%)
Avg P&L 1hr: +3.2% (was +2.8%)
Decision: KEEP new setting ✓
```

### 3. Monitor, Don't Overfit

Don't chase every metric daily. Give settings 3-7 days to show impact.

### 4. Seasonal Adjustments

**High-volatility periods** (elections, Fed meetings):
- Raise signal thresholds
- Tighten rate limits
- Focus on quality over quantity

**Low-volatility periods:**
- Lower signal thresholds
- Increase market coverage
- Look for hidden opportunities

---

## Tuning Checklist

Before making changes:
- [ ] Collected at least 48 hours of baseline data
- [ ] Identified specific problem/goal
- [ ] Documented current setting values
- [ ] Planned rollback procedure
- [ ] Set measurable success criteria

After making changes:
- [ ] Documented change in tuning log
- [ ] Set calendar reminder to review (3-7 days)
- [ ] Monitoring logs and alerts
- [ ] Tracking P&L metrics
- [ ] Ready to revert if needed

---

## Support

Having trouble tuning? Check:
1. [Settings Reference](./DETECTION_SETTINGS_REFERENCE.md) - Detailed setting docs
2. [Settings CSV](./settings-inventory.csv) - Quick lookup
3. Railway logs - Real-time monitoring
4. P&L database - Historical performance data

---

**Version History:**
- v1.0.0 (2025-10-25): Initial playbook

**Next Update:** Based on production tuning experience
