# Prioritized Discord Notification System

## Overview

The Prioritized Notification System is a production-grade alert orchestration framework that evaluates market signals through a sophisticated decision engine, applies quality filters and rate limits, and sends priority-aware Discord notifications only for the most valuable opportunities.

### Key Features

- **4-Tier Priority System**: CRITICAL, HIGH, MEDIUM, LOW
- **Intelligent Filtering**: Quality filters, score thresholds, category validation
- **Rate Limiting**: Hourly caps and per-market cooldowns by priority level
- **Rich Discord Embeds**: Priority-specific formatting with custom colors and emojis
- **Comprehensive Metrics**: Real-time tracking of alerts sent, filtered, and rate-limited
- **Production Reliability**: Retry logic, timeout handling, error recovery

## Architecture

### Component Overview

```
EarlySignal → AlertManager → PrioritizedDiscordNotifier → Discord
                ↓                        ↓
          (Evaluation)            (Formatting & Delivery)
                ↓                        ↓
         Alert Decision            Retry Logic + Metrics
```

### AlertManager

The AlertManager is the decision engine that evaluates whether a signal should trigger an alert:

1. **Quality Filters**:
   - Minimum opportunity score (default: 30/100)
   - Minimum category score (default: 2 keywords)
   - Non-blacklisted markets only
   - Tier validation (ACTIVE/WATCHLIST/IGNORED)

2. **Score-Based Priority Assignment**:
   - **CRITICAL**: Adjusted score ≥ 80
   - **HIGH**: Adjusted score ≥ 60
   - **MEDIUM**: Adjusted score ≥ 40
   - **LOW**: Adjusted score < 40

3. **Tier Adjustments**:
   - **ACTIVE tier**: +15 score boost, minimum MEDIUM priority
   - **WATCHLIST tier**: +5 score boost, minimum LOW priority
   - **IGNORED tier**: Filtered out

4. **Rate Limiting**:
   - **Per-Priority Hourly Caps**:
     - CRITICAL: 10/hour
     - HIGH: 20/hour
     - MEDIUM: 50/hour
     - LOW: 100/hour

   - **Per-Market Cooldowns**:
     - CRITICAL: 30 minutes
     - HIGH: 60 minutes
     - MEDIUM: 120 minutes
     - LOW: 240 minutes

### PrioritizedDiscordNotifier

Handles Discord notification delivery with priority-specific formatting:

- **Priority Colors**:
  - CRITICAL: Red (#FF0000)
  - HIGH: Orange (#FF6600)
  - MEDIUM: Yellow (#FFAA00)
  - LOW: Gray (#888888)

- **Priority Emojis**:
  - CRITICAL: 🚨
  - HIGH: ⚠️
  - MEDIUM: 📢
  - LOW: ℹ️

- **Embed Content** (varies by priority):
  - Opportunity Score breakdown (volume, edge, catalyst, quality)
  - Market details (volume, outcomes, days to close, tier)
  - Classification (category, spread, signal type)
  - Current prices (up to 5 outcomes)
  - Signal reasoning (CRITICAL and HIGH only)
  - Market link

- **Delivery Features**:
  - 3 retry attempts with exponential backoff (1s, 2s, 3s delays)
  - 10-second timeout per request
  - Optional @everyone mentions (configurable per priority)

## Configuration

### Config File Location

`config/detection-config.json`

### Alert Prioritization Section

```json
{
  "detection": {
    "alertPrioritization": {
      "enabled": true,

      "thresholds": {
        "critical": 80,
        "high": 60,
        "medium": 40
      },

      "tierAdjustments": {
        "active": {
          "scoreBoost": 15,
          "minPriority": "medium"
        },
        "watchlist": {
          "scoreBoost": 5,
          "minPriority": "low"
        }
      },

      "rateLimits": {
        "critical": {
          "maxPerHour": 10,
          "cooldownMinutes": 30
        },
        "high": {
          "maxPerHour": 20,
          "cooldownMinutes": 60
        },
        "medium": {
          "maxPerHour": 50,
          "cooldownMinutes": 120
        },
        "low": {
          "maxPerHour": 100,
          "cooldownMinutes": 240
        }
      },

      "qualityFilters": {
        "minOpportunityScore": 30,
        "minCategoryScore": 2,
        "requireNonBlacklisted": true,
        "minVolumeRatio": 1.0
      },

      "notifications": {
        "critical": {
          "enableDiscord": true,
          "mentionEveryone": true,
          "includeDetailedReasoning": true
        },
        "high": {
          "enableDiscord": true,
          "mentionEveryone": false,
          "includeDetailedReasoning": true
        },
        "medium": {
          "enableDiscord": true,
          "mentionEveryone": false,
          "includeDetailedReasoning": false
        },
        "low": {
          "enableDiscord": false,
          "mentionEveryone": false,
          "includeDetailedReasoning": false
        }
      }
    }
  }
}
```

### Configuration Options Explained

#### Priority Thresholds

Defines the minimum adjusted opportunity scores for each priority level:
- `critical`: Score ≥ 80 → CRITICAL priority
- `high`: Score ≥ 60 → HIGH priority
- `medium`: Score ≥ 40 → MEDIUM priority
- Below 40 → LOW priority

#### Tier Adjustments

- `scoreBoost`: Points added to base opportunity score for markets in this tier
- `minPriority`: Minimum alert priority for this tier (lowercase: "critical", "high", "medium", "low")

**Example**: An ACTIVE tier market with base score 50 gets +15 boost = 65, which is HIGH priority. Even if the adjusted score only qualifies for MEDIUM, the `minPriority: "medium"` ensures it's not downgraded to LOW.

#### Rate Limits

- `maxPerHour`: Maximum alerts of this priority per hour (rolling window)
- `cooldownMinutes`: Minutes before the same market can trigger another alert at this priority

**Example**: After sending a CRITICAL alert for market X, no more CRITICAL alerts for market X for 30 minutes, even if a new signal appears.

#### Quality Filters

- `minOpportunityScore`: Minimum base opportunity score (0-100)
- `minCategoryScore`: Minimum category keywords matched
- `requireNonBlacklisted`: Reject blacklisted markets
- `minVolumeRatio`: Minimum volume/threshold ratio (reserved for future use)

#### Notification Settings (Per Priority)

- `enableDiscord`: Whether to send Discord notifications for this priority
- `mentionEveryone`: Whether to include @everyone mention
- `includeDetailedReasoning`: Include "Why This Alert?" section in embed

**Tip**: Disable Discord for LOW priority to reduce notification spam while still tracking the alerts in the database.

## Testing

### Test Notifications

Send test alerts at all priority levels to verify Discord webhook and formatting:

```typescript
// In your bot code or test script
await bot.sendTestPrioritizedNotifications();
```

This will send 4 test messages (CRITICAL, HIGH, MEDIUM, LOW) to your Discord channel with 1-second delays to avoid rate limits.

### Manual Signal Testing

Create a test signal to evaluate through the system:

```typescript
import { AlertPriority } from './types';
import { alertManager } from './services/AlertManager';

// Create test signal
const testSignal: EarlySignal = {
  marketId: 'test-market-123',
  market: {
    id: 'test-market-123',
    question: 'Will this test notification work?',
    category: 'technology',
    categoryScore: 5,
    tier: 'ACTIVE',
    opportunityScore: 75,  // Should qualify for HIGH (60-79)
    volumeScore: 25,
    edgeScore: 20,
    catalystScore: 15,
    qualityScore: 15,
    volumeNum: 50000,
    outcomeCount: 2,
    timeToClose: 7 * 24 * 60 * 60 * 1000,  // 7 days
    // ... other market fields
  },
  signalType: 'test_signal',
  confidence: 0.85,
  timestamp: Date.now(),
  metadata: {
    testMode: true
  }
};

// Evaluate decision
const decision = alertManager.evaluateAlert(testSignal);
console.log('Decision:', decision);

// Process through notifier
const { sent, decision: finalDecision } = await prioritizedNotifier.processSignal(testSignal);
console.log('Sent:', sent, 'Priority:', finalDecision.priority);
```

### Health Check

Query the bot health status to see notification statistics:

```typescript
const health = await bot.getHealthStatus();
console.log('Notification Stats:', health.prioritizedNotifications);
```

Expected output:
```json
{
  "prioritizedNotifications": {
    "configured": true,
    "alertManagerStats": {
      "totalAlertsEvaluated": 150,
      "alertsSent": 45,
      "alertsFiltered": 105,
      "byPriority": {
        "CRITICAL": 5,
        "HIGH": 15,
        "MEDIUM": 20,
        "LOW": 5
      },
      "avgOpportunityScore": 52.3
    },
    "rateLimitStatus": {
      "CRITICAL": { "count": 2, "maxPerHour": 10, "resetTime": 1698765432000 },
      "HIGH": { "count": 8, "maxPerHour": 20, "resetTime": 1698765432000 },
      // ...
    }
  }
}
```

## Monitoring & Metrics

### Metrics Collected

The system tracks these metrics via MetricsCollector:

**Notification Metrics**:
- `notifications.sent` - Total notifications sent
- `notifications.failed` - Notification failures
- `notifications.filtered` - Signals filtered before sending
- `notifications.processing_time_ms` - Processing duration
- `notifications.sent_on_attempt_1/2/3` - Retry success tracking
- `notifications.exhausted_retries` - All retry attempts failed

**Alert Metrics**:
- `alerts.sent` - Alerts recorded (sent or not)
- `alerts.rate_limited` - Blocked by rate limits
- `alerts.cooldown_active` - Blocked by cooldown
- `alerts.{priority}_score` - Opportunity score per priority level

**Bot-Level Metrics**:
- `alerts.prioritized_sent` - Successfully sent prioritized alerts
- `alerts.prioritized_filtered` - Filtered by AlertManager
- `alerts.prioritized_errors` - Errors during processing

### Log Events

The system logs these events via AdvancedLogger:

**INFO Level**:
- Alert decisions (should alert, priority, score, reason)
- Successful notifications (priority, score)
- Filtered signals (reason)
- Configuration updates

**ERROR Level**:
- Discord webhook failures
- Processing errors
- Retry exhaustion

**Example Log Entry**:
```json
{
  "level": "info",
  "message": "Alert decision for Will Bitcoin hit $100k in 2024?",
  "component": "prioritized_notifier",
  "operation": "process_signal",
  "metadata": {
    "marketId": "0x123abc...",
    "shouldAlert": true,
    "priority": "HIGH",
    "score": 68,
    "reason": "Alert approved: score 68, priority HIGH"
  },
  "timestamp": "2024-10-25T12:34:56.789Z"
}
```

## Database Schema

### Alert History Table

All alerts are recorded in the `alert_history` table:

```sql
CREATE TABLE alert_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id VARCHAR(100) NOT NULL,
  signal_id INTEGER,
  signal_type VARCHAR(50) NOT NULL,
  priority VARCHAR(20) NOT NULL,  -- 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW'
  opportunity_score DECIMAL,
  adjusted_score DECIMAL,
  category VARCHAR(50),
  tier VARCHAR(20),
  timestamp TIMESTAMP NOT NULL,
  notification_sent BOOLEAN DEFAULT FALSE,
  rate_limited BOOLEAN DEFAULT FALSE,
  filtered_reason TEXT,
  metadata JSON,
  FOREIGN KEY (market_id) REFERENCES markets(id),
  FOREIGN KEY (signal_id) REFERENCES signals(id)
);
```

### Query Examples

**Top CRITICAL alerts in last 24 hours**:
```sql
SELECT market_id, opportunity_score, adjusted_score, notification_sent, timestamp
FROM alert_history
WHERE priority = 'CRITICAL'
  AND timestamp > datetime('now', '-24 hours')
ORDER BY adjusted_score DESC
LIMIT 10;
```

**Rate limit effectiveness**:
```sql
SELECT
  priority,
  COUNT(*) as total_evaluated,
  SUM(CASE WHEN notification_sent THEN 1 ELSE 0 END) as sent,
  SUM(CASE WHEN rate_limited THEN 1 ELSE 0 END) as rate_limited,
  ROUND(AVG(opportunity_score), 2) as avg_score
FROM alert_history
WHERE timestamp > datetime('now', '-1 day')
GROUP BY priority
ORDER BY
  CASE priority
    WHEN 'CRITICAL' THEN 1
    WHEN 'HIGH' THEN 2
    WHEN 'MEDIUM' THEN 3
    WHEN 'LOW' THEN 4
  END;
```

**Hourly alert distribution**:
```sql
SELECT
  strftime('%Y-%m-%d %H:00', timestamp) as hour,
  priority,
  COUNT(*) as alert_count
FROM alert_history
WHERE notification_sent = TRUE
  AND timestamp > datetime('now', '-24 hours')
GROUP BY hour, priority
ORDER BY hour DESC, priority;
```

## Best Practices

### Configuration Tuning

1. **Start Conservative**: Begin with strict thresholds and gradually relax:
   - Initial: CRITICAL ≥ 85, HIGH ≥ 70, MEDIUM ≥ 50
   - After validation: CRITICAL ≥ 80, HIGH ≥ 60, MEDIUM ≥ 40

2. **Monitor False Positives**: Track alerts that don't lead to profitable opportunities
   - Increase `minOpportunityScore` if too many low-quality alerts
   - Adjust category keywords if specific categories underperform

3. **Tier Strategy**:
   - Use ACTIVE tier for proven high-edge categories (politics, sports)
   - Use WATCHLIST for experimental or moderate-edge categories
   - Review tier assignments monthly based on performance data

4. **Rate Limit Tuning**:
   - If missing opportunities: Increase `maxPerHour` limits
   - If overwhelmed by alerts: Decrease `maxPerHour` or increase `cooldownMinutes`
   - Balance: CRITICAL should be rare (1-2/hour), HIGH occasional (3-5/hour)

### Discord Channel Setup

1. **Separate Channels by Priority**:
   - `#critical-alerts` - CRITICAL only
   - `#high-alerts` - HIGH + CRITICAL
   - `#all-alerts` - All priorities
   - Configure multiple webhooks, route by priority in code

2. **Role Mentions**:
   - Create `@trading-team` role for CRITICAL alerts
   - Use `@everyone` sparingly (only true emergencies)
   - Consider `@traders-active` role for HIGH priority

3. **Notification Settings**:
   - CRITICAL: Sound + push notification
   - HIGH: Sound notification
   - MEDIUM: Silent
   - LOW: Disabled or separate archive channel

### Operational Guidelines

1. **Daily Review**:
   - Check `alertManagerStats` for unexpected patterns
   - Verify rate limit counts are reasonable
   - Review any `exhausted_retries` errors

2. **Weekly Analysis**:
   - Query database for alert performance (did HIGH alerts lead to profit?)
   - Adjust thresholds based on win rate
   - Review filtered alerts to ensure not missing opportunities

3. **Monthly Optimization**:
   - Analyze category performance, adjust tier assignments
   - Review and update category keywords
   - Fine-tune opportunity score weightings

4. **Incident Response**:
   - If Discord webhook down: Alerts are still logged to database
   - If alert spam: Temporarily increase thresholds or disable lower priorities
   - If missing critical opportunities: Review filter logic and quality thresholds

## Troubleshooting

### No Alerts Being Sent

1. Check if alert system is enabled:
   ```bash
   # In config/detection-config.json
   "alertPrioritization": { "enabled": true }
   ```

2. Verify Discord webhook URL is configured:
   ```bash
   echo $DISCORD_WEBHOOK_URL
   ```

3. Check rate limit status:
   ```typescript
   const stats = prioritizedNotifier.getStats();
   console.log(stats.rateLimitStatus);
   ```

4. Review quality filters - may be too strict:
   ```json
   "qualityFilters": {
     "minOpportunityScore": 20,  // Lower from 30 temporarily
     "minCategoryScore": 1        // Lower from 2
   }
   ```

### Too Many Alerts

1. Increase priority thresholds:
   ```json
   "thresholds": {
     "critical": 85,  // Increase from 80
     "high": 70,      // Increase from 60
     "medium": 50     // Increase from 40
   }
   ```

2. Tighten rate limits:
   ```json
   "rateLimits": {
     "high": { "maxPerHour": 10 }  // Decrease from 20
   }
   ```

3. Disable lower priorities:
   ```json
   "notifications": {
     "medium": { "enableDiscord": false },
     "low": { "enableDiscord": false }
   }
   ```

### Webhook Timeout Errors

1. Check Discord API status: https://discordstatus.com/
2. Verify network connectivity
3. Increase timeout in PrioritizedDiscordNotifier (currently 10s)
4. Review retry metrics - should succeed on retry if transient

### Missing High-Priority Alerts

1. Check if markets are being categorized correctly
2. Verify opportunity scores are calculated
3. Review tier assignments - might be in IGNORED tier
4. Check if rate limited - query `alert_history` for `rate_limited = TRUE`

## Future Enhancements

Potential improvements to the prioritized notification system:

1. **Machine Learning Priority Assignment**:
   - Train model on historical alert performance
   - Predict probability of profitable opportunity
   - Use predicted profit as priority input

2. **Dynamic Rate Limiting**:
   - Adjust limits based on time of day (higher during market hours)
   - Reduce limits during low-volatility periods
   - Increase limits during major events

3. **Multi-Channel Routing**:
   - CRITICAL → Discord + SMS + Email
   - HIGH → Discord + Email
   - MEDIUM → Discord only
   - LOW → Database only

4. **Alert Clustering**:
   - Group related alerts (same event, multiple markets)
   - Send single notification with all related markets
   - Reduce notification fatigue

5. **Performance-Based Feedback Loop**:
   - Track P&L from each alert priority
   - Auto-adjust thresholds based on win rate
   - A/B test different configurations

6. **Alert Templates**:
   - Customizable embed templates per category
   - Add category-specific context (team stats for sports, poll data for politics)
   - Include relevant news/catalysts

## Support

For issues or questions:
- Review logs: `logs/advanced-bot.log`
- Check metrics: `http://localhost:3000/metrics` (if Prometheus enabled)
- Query database: `SELECT * FROM alert_history ORDER BY timestamp DESC LIMIT 20;`
- Test notifications: `await bot.sendTestPrioritizedNotifications();`

---

**Version**: 1.0.0
**Last Updated**: Phase 6 Implementation
**Status**: Production-Ready
