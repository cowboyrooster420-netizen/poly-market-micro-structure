import { Market, EarlySignal, AlertPriority, MarketTier } from '../types';
import { logger } from '../utils/logger';
import { advancedLogger } from '../utils/AdvancedLogger';
import { metricsCollector } from '../monitoring/MetricsCollector';
import { configManager } from '../config/ConfigManager';

export interface AlertDecision {
  shouldAlert: boolean;
  priority: AlertPriority;
  reason: string;
  adjustedScore: number;
  rateLimitStatus: {
    allowed: boolean;
    hourlyCount: number;
    maxPerHour: number;
    cooldownRemaining: number;
  };
}

export interface AlertRecord {
  marketId: string;
  signalType: string;
  priority: AlertPriority;
  opportunityScore: number;
  timestamp: number;
  notificationSent: boolean;
}

export interface AlertStats {
  totalAlertsEvaluated: number;
  alertsSent: number;
  alertsFiltered: number;
  alertsRateLimited: number;
  byPriority: Record<AlertPriority, number>;
  byCategory: Record<string, number>;
  avgOpportunityScore: number;
}

/**
 * AlertManager - Manages alert prioritization, rate limiting, and deduplication
 *
 * Production-grade alert orchestration with:
 * - Score-based priority assignment (CRITICAL/HIGH/MEDIUM/LOW)
 * - Tier-specific score adjustments
 * - Per-priority rate limiting
 * - Market-level cooldown tracking
 * - Quality filtering
 * - Comprehensive metrics and observability
 */
export class AlertManager {
  private alertHistory: Map<string, AlertRecord[]>;
  private hourlyAlertCounts: Map<AlertPriority, { count: number; resetTime: number }>;
  private marketCooldowns: Map<string, Map<AlertPriority, number>>; // marketId -> priority -> lastAlertTime
  private readonly config;

  constructor() {
    this.alertHistory = new Map();
    this.hourlyAlertCounts = new Map();
    this.marketCooldowns = new Map();
    this.config = configManager.getConfig().detection.alertPrioritization;

    // Initialize hourly counters
    this.resetHourlyCounts();

    // Subscribe to config changes
    configManager.onConfigChange('alert_manager', (newConfig) => {
      // Config automatically updates via this.config reference
      advancedLogger.info('Alert configuration reloaded', {
        component: 'alert_manager',
        operation: 'config_update'
      });
    });

    // Schedule hourly cleanup to prevent memory leaks
    setInterval(() => {
      this.cleanupHistory(); // Also cleans expired cooldowns
      advancedLogger.info('Alert manager cleanup completed', {
        component: 'alert_manager',
        operation: 'cleanup',
        metadata: {
          historySize: this.alertHistory.size,
          cooldownMapsSize: this.marketCooldowns.size
        }
      });
    }, 60 * 60 * 1000); // Run every hour

    logger.info('Alert Manager initialized with automated cleanup');
  }

  /**
   * Evaluate whether to send an alert for a signal and determine its priority
   */
  evaluateAlert(signal: EarlySignal): AlertDecision {
    const market = signal.market;
    const config = this.config;

    // Check if system is enabled
    if (!config.enabled) {
      return this.createDecision(false, AlertPriority.LOW, 'Alert system disabled', 0);
    }

    // Apply quality filters
    const qualityCheck = this.checkQualityFilters(market);
    if (!qualityCheck.passed) {
      return this.createDecision(false, AlertPriority.LOW, qualityCheck.reason, market.opportunityScore || 0);
    }

    // Calculate adjusted score (base score + tier adjustment)
    const adjustedScore = this.calculateAdjustedScore(market);

    // Assign priority based on adjusted score
    const priority = this.assignPriority(adjustedScore);

    // Check tier-specific minimum priority
    const tierMinPriority = this.getTierMinimumPriority(market.tier);
    if (this.priorityLessThan(priority, tierMinPriority)) {
      return this.createDecision(
        false,
        priority,
        `Priority ${priority} below tier minimum ${tierMinPriority}`,
        adjustedScore
      );
    }

    // Check rate limits
    const rateLimitStatus = this.checkRateLimits(market.id, priority);
    if (!rateLimitStatus.allowed) {
      metricsCollector.incrementCounter('alerts.rate_limited');
      return {
        shouldAlert: false,
        priority,
        reason: `Rate limit exceeded: ${rateLimitStatus.hourlyCount}/${rateLimitStatus.maxPerHour} per hour`,
        adjustedScore,
        rateLimitStatus
      };
    }

    // Check market-specific cooldown
    const cooldownCheck = this.checkMarketCooldown(market.id, priority);
    if (!cooldownCheck.allowed) {
      metricsCollector.incrementCounter('alerts.cooldown_active');
      return {
        shouldAlert: false,
        priority,
        reason: `Market cooldown active: ${Math.round(cooldownCheck.remainingMinutes)}min remaining`,
        adjustedScore,
        rateLimitStatus: {
          ...rateLimitStatus,
          cooldownRemaining: cooldownCheck.remainingMinutes
        }
      };
    }

    // All checks passed - alert should be sent
    return {
      shouldAlert: true,
      priority,
      reason: `Alert approved: score ${adjustedScore}, priority ${priority}`,
      adjustedScore,
      rateLimitStatus: {
        ...rateLimitStatus,
        cooldownRemaining: 0
      }
    };
  }

  /**
   * Record that an alert was sent (for rate limiting and history)
   */
  recordAlert(signal: EarlySignal, priority: AlertPriority, notificationSent: boolean): void {
    const market = signal.market;
    const timestamp = Date.now();

    // Record in alert history
    const record: AlertRecord = {
      marketId: market.id,
      signalType: signal.signalType,
      priority,
      opportunityScore: market.opportunityScore || 0,
      timestamp,
      notificationSent
    };

    if (!this.alertHistory.has(market.id)) {
      this.alertHistory.set(market.id, []);
    }
    this.alertHistory.get(market.id)!.push(record);

    // Update hourly count
    this.incrementHourlyCount(priority);

    // Update market cooldown
    if (!this.marketCooldowns.has(market.id)) {
      this.marketCooldowns.set(market.id, new Map());
    }
    this.marketCooldowns.get(market.id)!.set(priority, timestamp);

    // Record metrics
    metricsCollector.incrementCounter('alerts.sent');
    metricsCollector.setGauge(`alerts.${priority.toLowerCase()}_score`, market.opportunityScore || 0);

    advancedLogger.info(`Alert recorded`, {
      component: 'alert_manager',
      operation: 'record_alert',
      metadata: {
        marketId: market.id,
        question: market.question?.substring(0, 80),
        priority,
        score: market.opportunityScore,
        category: market.category,
        tier: market.tier,
        notificationSent
      }
    });
  }

  /**
   * Check if market meets quality filters for alerting
   */
  private checkQualityFilters(market: Market): { passed: boolean; reason: string } {
    const filters = this.config.qualityFilters;

    // Blacklist check
    if (filters.requireNonBlacklisted && market.isBlacklisted) {
      return { passed: false, reason: 'Market is blacklisted' };
    }

    // Opportunity score check
    const oppScore = market.opportunityScore || 0;
    if (oppScore < filters.minOpportunityScore) {
      return { passed: false, reason: `Opportunity score ${oppScore} below minimum ${filters.minOpportunityScore}` };
    }

    // Category score check
    const catScore = market.categoryScore || 0;
    if (catScore < filters.minCategoryScore) {
      return { passed: false, reason: `Category score ${catScore} below minimum ${filters.minCategoryScore}` };
    }

    // Volume ratio check
    const volume = market.volumeNum || 0;
    const category = market.category || 'uncategorized';
    // We'd need access to volume thresholds here - for now, use a simple check
    if (market.tier === MarketTier.IGNORED) {
      return { passed: false, reason: 'Market in IGNORED tier' };
    }

    return { passed: true, reason: 'Quality filters passed' };
  }

  /**
   * Calculate adjusted opportunity score with tier bonus
   */
  private calculateAdjustedScore(market: Market): number {
    const baseScore = market.opportunityScore || 0;
    const tier = market.tier || MarketTier.IGNORED;

    let adjustment = 0;
    if (tier === MarketTier.ACTIVE) {
      adjustment = this.config.tierAdjustments.active.scoreBoost;
    } else if (tier === MarketTier.WATCHLIST) {
      adjustment = this.config.tierAdjustments.watchlist.scoreBoost;
    }

    return Math.min(100, Math.max(0, baseScore + adjustment));
  }

  /**
   * Assign alert priority based on adjusted score
   */
  private assignPriority(adjustedScore: number): AlertPriority {
    const thresholds = this.config.thresholds;

    if (adjustedScore >= thresholds.critical) {
      return AlertPriority.CRITICAL;
    } else if (adjustedScore >= thresholds.high) {
      return AlertPriority.HIGH;
    } else if (adjustedScore >= thresholds.medium) {
      return AlertPriority.MEDIUM;
    } else {
      return AlertPriority.LOW;
    }
  }

  /**
   * Get minimum priority allowed for a tier
   */
  private getTierMinimumPriority(tier: MarketTier | undefined): AlertPriority {
    if (tier === MarketTier.WATCHLIST) {
      return this.config.tierAdjustments.watchlist.minPriority.toUpperCase() as AlertPriority;
    } else if (tier === MarketTier.ACTIVE) {
      return this.config.tierAdjustments.active.minPriority.toUpperCase() as AlertPriority;
    }
    return AlertPriority.LOW;
  }

  /**
   * Compare priority levels (returns true if a < b)
   */
  private priorityLessThan(a: AlertPriority, b: AlertPriority): boolean {
    const order = [AlertPriority.LOW, AlertPriority.MEDIUM, AlertPriority.HIGH, AlertPriority.CRITICAL];
    return order.indexOf(a) < order.indexOf(b);
  }

  /**
   * Check if alert would exceed hourly rate limit
   */
  private checkRateLimits(marketId: string, priority: AlertPriority): {
    allowed: boolean;
    hourlyCount: number;
    maxPerHour: number;
    cooldownRemaining: number;
  } {
    this.resetExpiredHourlyCounts();

    const counter = this.hourlyAlertCounts.get(priority);
    const priorityKey = priority.toLowerCase() as 'critical' | 'high' | 'medium' | 'low';

    if (!counter) {
      return { allowed: true, hourlyCount: 0, maxPerHour: this.config.rateLimits[priorityKey].maxPerHour, cooldownRemaining: 0 };
    }

    const maxPerHour = this.config.rateLimits[priorityKey].maxPerHour;
    const allowed = counter.count < maxPerHour;

    return { allowed, hourlyCount: counter.count, maxPerHour, cooldownRemaining: 0 };
  }

  /**
   * Check if market is still in cooldown period for this priority level
   */
  private checkMarketCooldown(marketId: string, priority: AlertPriority): {
    allowed: boolean;
    remainingMinutes: number;
  } {
    const marketCooldowns = this.marketCooldowns.get(marketId);
    if (!marketCooldowns) {
      return { allowed: true, remainingMinutes: 0 };
    }

    const lastAlertTime = marketCooldowns.get(priority);
    if (!lastAlertTime) {
      return { allowed: true, remainingMinutes: 0 };
    }

    const priorityKey = priority.toLowerCase() as 'critical' | 'high' | 'medium' | 'low';
    const cooldownMs = this.config.rateLimits[priorityKey].cooldownMinutes * 60 * 1000;
    const elapsed = Date.now() - lastAlertTime;
    const remaining = cooldownMs - elapsed;

    if (remaining > 0) {
      return { allowed: false, remainingMinutes: remaining / (60 * 1000) };
    }

    return { allowed: true, remainingMinutes: 0 };
  }

  /**
   * Increment hourly alert count for a priority level
   */
  private incrementHourlyCount(priority: AlertPriority): void {
    const counter = this.hourlyAlertCounts.get(priority);
    if (counter) {
      counter.count++;
    } else {
      this.hourlyAlertCounts.set(priority, {
        count: 1,
        resetTime: Date.now() + 3600000 // 1 hour from now
      });
    }
  }

  /**
   * Reset hourly counts that have expired
   */
  private resetExpiredHourlyCounts(): void {
    const now = Date.now();
    for (const [priority, counter] of this.hourlyAlertCounts.entries()) {
      if (now >= counter.resetTime) {
        this.hourlyAlertCounts.set(priority, {
          count: 0,
          resetTime: now + 3600000
        });
      }
    }
  }

  /**
   * Reset all hourly counts (called on initialization)
   */
  private resetHourlyCounts(): void {
    const now = Date.now();
    for (const priority of [AlertPriority.CRITICAL, AlertPriority.HIGH, AlertPriority.MEDIUM, AlertPriority.LOW]) {
      this.hourlyAlertCounts.set(priority, {
        count: 0,
        resetTime: now + 3600000
      });
    }
  }

  /**
   * Helper to create a decision object
   */
  private createDecision(
    shouldAlert: boolean,
    priority: AlertPriority,
    reason: string,
    adjustedScore: number
  ): AlertDecision {
    return {
      shouldAlert,
      priority,
      reason,
      adjustedScore,
      rateLimitStatus: {
        allowed: shouldAlert,
        hourlyCount: 0,
        maxPerHour: 0,
        cooldownRemaining: 0
      }
    };
  }

  /**
   * Get alert statistics
   */
  getStats(): AlertStats {
    const stats: AlertStats = {
      totalAlertsEvaluated: 0,
      alertsSent: 0,
      alertsFiltered: 0,
      alertsRateLimited: 0,
      byPriority: {
        [AlertPriority.CRITICAL]: 0,
        [AlertPriority.HIGH]: 0,
        [AlertPriority.MEDIUM]: 0,
        [AlertPriority.LOW]: 0
      },
      byCategory: {},
      avgOpportunityScore: 0
    };

    let totalScore = 0;
    let scoreCount = 0;

    for (const records of this.alertHistory.values()) {
      for (const record of records) {
        stats.totalAlertsEvaluated++;
        if (record.notificationSent) {
          stats.alertsSent++;
          stats.byPriority[record.priority]++;
        }
        totalScore += record.opportunityScore;
        scoreCount++;
      }
    }

    stats.avgOpportunityScore = scoreCount > 0 ? totalScore / scoreCount : 0;
    stats.alertsFiltered = stats.totalAlertsEvaluated - stats.alertsSent;

    return stats;
  }

  /**
   * Get current rate limit status
   */
  getRateLimitStatus(): Record<AlertPriority, { count: number; maxPerHour: number; resetTime: number }> {
    this.resetExpiredHourlyCounts();

    const status: any = {};
    for (const priority of [AlertPriority.CRITICAL, AlertPriority.HIGH, AlertPriority.MEDIUM, AlertPriority.LOW]) {
      const counter = this.hourlyAlertCounts.get(priority);
      const priorityKey = priority.toLowerCase() as 'critical' | 'high' | 'medium' | 'low';
      const maxPerHour = this.config.rateLimits[priorityKey].maxPerHour;
      status[priority] = {
        count: counter?.count || 0,
        maxPerHour,
        resetTime: counter?.resetTime || Date.now() + 3600000
      };
    }
    return status;
  }

  /**
   * Clear old alert history (memory management)
   */
  cleanupHistory(maxAgeMs: number = 86400000): void {
    const cutoff = Date.now() - maxAgeMs; // Default 24 hours
    let removedCount = 0;

    for (const [marketId, records] of this.alertHistory.entries()) {
      const filtered = records.filter(r => r.timestamp > cutoff);
      if (filtered.length === 0) {
        this.alertHistory.delete(marketId);
        removedCount += records.length;
      } else if (filtered.length < records.length) {
        this.alertHistory.set(marketId, filtered);
        removedCount += records.length - filtered.length;
      }
    }

    // Clean up old cooldowns
    for (const [marketId, cooldowns] of this.marketCooldowns.entries()) {
      const activeCooldowns = new Map();
      for (const [priority, timestamp] of cooldowns.entries()) {
        const priorityKey = priority.toLowerCase() as 'critical' | 'high' | 'medium' | 'low';
        const cooldownMs = this.config.rateLimits[priorityKey].cooldownMinutes * 60 * 1000;
        if (Date.now() - timestamp < cooldownMs) {
          activeCooldowns.set(priority, timestamp);
        }
      }
      if (activeCooldowns.size === 0) {
        this.marketCooldowns.delete(marketId);
      } else {
        this.marketCooldowns.set(marketId, activeCooldowns);
      }
    }

    if (removedCount > 0) {
      advancedLogger.info(`Alert history cleanup completed`, {
        component: 'alert_manager',
        operation: 'cleanup_history',
        metadata: {
          removedRecords: removedCount,
          remainingMarkets: this.alertHistory.size,
          cutoffAge: maxAgeMs / 3600000 + ' hours'
        }
      });
    }
  }
}

// Singleton instance
export const alertManager = new AlertManager();
