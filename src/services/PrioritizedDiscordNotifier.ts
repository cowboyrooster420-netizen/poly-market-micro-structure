import { EarlySignal, AlertPriority, BotConfig } from '../types';
import { logger } from '../utils/logger';
import { advancedLogger } from '../utils/AdvancedLogger';
import { metricsCollector } from '../monitoring/MetricsCollector';
import { alertManager, AlertDecision } from './AlertManager';
import { configManager } from '../config/ConfigManager';

interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: Array<{
    name: string;
    value: string;
    inline?: boolean;
  }>;
  footer?: {
    text: string;
  };
  timestamp?: string;
  author?: {
    name: string;
    icon_url?: string;
  };
}

interface DiscordWebhookPayload {
  content?: string;
  embeds?: DiscordEmbed[];
  username?: string;
  avatar_url?: string;
}

/**
 * PrioritizedDiscordNotifier - Priority-aware Discord notification service
 *
 * Production-grade notification orchestration that:
 * - Evaluates signals through AlertManager
 * - Formats Discord embeds based on priority level
 * - Implements priority-specific notification strategies
 * - Handles retries and error recovery
 * - Tracks comprehensive metrics
 */
export class PrioritizedDiscordNotifier {
  private config: BotConfig;
  private webhookUrl: string | null = null;
  private readonly maxRetries = 3;
  private readonly retryDelayMs = 1000;

  // Priority-specific colors
  private readonly PRIORITY_COLORS = {
    [AlertPriority.CRITICAL]: 0xFF0000,  // Red
    [AlertPriority.HIGH]: 0xFF6600,       // Orange
    [AlertPriority.MEDIUM]: 0xFFAA00,     // Yellow
    [AlertPriority.LOW]: 0x888888,        // Gray
  };

  // Priority-specific emojis
  private readonly PRIORITY_EMOJIS = {
    [AlertPriority.CRITICAL]: '🚨',
    [AlertPriority.HIGH]: '⚠️',
    [AlertPriority.MEDIUM]: '📢',
    [AlertPriority.LOW]: 'ℹ️',
  };

  constructor(config: BotConfig) {
    this.config = config;
    this.webhookUrl = config.discord.webhookUrl || null;
  }

  /**
   * Process signal through alert manager and send notification if approved
   */
  async processSignal(signal: EarlySignal): Promise<{ sent: boolean; decision: AlertDecision }> {
    const startTime = Date.now();

    try {
      // Evaluate signal through AlertManager
      const decision = alertManager.evaluateAlert(signal);

      // Log the decision
      advancedLogger.info(`Alert decision for ${signal.market.question}`, {
        component: 'prioritized_notifier',
        operation: 'process_signal',
        metadata: {
          marketId: signal.marketId,
          shouldAlert: decision.shouldAlert,
          priority: decision.priority,
          score: decision.adjustedScore,
          reason: decision.reason
        }
      });

      // If alert should not be sent, record and return
      if (!decision.shouldAlert) {
        metricsCollector.incrementCounter('notifications.filtered');
        advancedLogger.info(`Signal filtered: ${decision.reason}`, {
          component: 'prioritized_notifier',
          operation: 'process_signal',
          metadata: {
            marketId: signal.marketId,
            priority: decision.priority,
            score: decision.adjustedScore,
            reason: decision.reason
          }
        });
        return { sent: false, decision };
      }

      // Check if Discord is configured
      if (!this.webhookUrl) {
        logger.warn('Discord webhook not configured, skipping notification');
        alertManager.recordAlert(signal, decision.priority, false);
        return { sent: false, decision };
      }

      // Get notification config for this priority
      const priorityKey = decision.priority.toLowerCase() as 'critical' | 'high' | 'medium' | 'low';
      const notificationConfig = configManager.getConfig().detection.alertPrioritization.notifications[priorityKey];

      // Check if Discord is enabled for this priority
      if (!notificationConfig.enableDiscord) {
        advancedLogger.info(`Discord disabled for ${decision.priority} priority`, {
          component: 'prioritized_notifier',
          operation: 'process_signal',
          metadata: {
            marketId: signal.marketId,
            priority: decision.priority
          }
        });
        alertManager.recordAlert(signal, decision.priority, false);
        return { sent: false, decision };
      }

      // Send notification with priority-specific formatting
      const sent = await this.sendPrioritizedNotification(signal, decision, notificationConfig);

      // Record alert in AlertManager
      alertManager.recordAlert(signal, decision.priority, sent);

      // Record metrics
      const duration = Date.now() - startTime;
      metricsCollector.incrementCounter(sent ? 'notifications.sent' : 'notifications.failed');
      metricsCollector.setGauge('notifications.processing_time_ms', duration);

      return { sent, decision };
    } catch (error) {
      advancedLogger.error('Error processing signal notification', error as Error, {
        component: 'prioritized_notifier',
        operation: 'process_signal',
        metadata: {
          marketId: signal.marketId,
          signalType: signal.signalType
        }
      });

      metricsCollector.incrementCounter('notifications.errors');
      return {
        sent: false,
        decision: {
          shouldAlert: false,
          priority: AlertPriority.LOW,
          reason: 'Error during processing',
          adjustedScore: 0,
          rateLimitStatus: {
            allowed: false,
            hourlyCount: 0,
            maxPerHour: 0,
            cooldownRemaining: 0
          }
        }
      };
    }
  }

  /**
   * Send prioritized notification with retry logic
   */
  private async sendPrioritizedNotification(
    signal: EarlySignal,
    decision: AlertDecision,
    notificationConfig: any
  ): Promise<boolean> {
    const embed = this.buildPrioritizedEmbed(signal, decision, notificationConfig);
    const content = notificationConfig.mentionEveryone ? '@everyone' : undefined;

    const payload: DiscordWebhookPayload = {
      content,
      embeds: [embed],
      username: 'Poly Early Bot - Prioritized Alerts',
      avatar_url: 'https://i.imgur.com/polymarket-logo.png'
    };

    // Send with retry logic
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const success = await this.sendWebhook(payload);

        if (success) {
          metricsCollector.incrementCounter('notifications.sent_on_attempt_' + attempt);
          return true;
        }

        // If not last attempt, wait before retrying
        if (attempt < this.maxRetries) {
          await this.sleep(this.retryDelayMs * attempt); // Exponential backoff
        }
      } catch (error) {
        advancedLogger.error(`Notification attempt ${attempt} failed`, error as Error, {
          component: 'prioritized_notifier',
          operation: 'send_prioritized_notification',
          metadata: {
            attempt,
            maxRetries: this.maxRetries,
            marketId: signal.marketId,
            priority: decision.priority
          }
        });

        if (attempt === this.maxRetries) {
          metricsCollector.incrementCounter('notifications.exhausted_retries');
          return false;
        }
      }
    }

    return false;
  }

  /**
   * Build Discord embed with priority-specific formatting
   */
  private buildPrioritizedEmbed(
    signal: EarlySignal,
    decision: AlertDecision,
    notificationConfig: any
  ): DiscordEmbed {
    const market = signal.market;
    const priority = decision.priority;
    const emoji = this.PRIORITY_EMOJIS[priority];
    const color = this.PRIORITY_COLORS[priority];

    // Build title
    const title = `${emoji} ${priority} OPPORTUNITY - ${market.category?.toUpperCase() || 'UNKNOWN'}`;

    // Build description with market question
    const question = market.question || 'Unknown Market';
    const truncatedQuestion = question.length > 200 ? question.substring(0, 197) + '...' : question;

    // Build fields
    const fields: Array<{ name: string; value: string; inline?: boolean }> = [];

    // Opportunity Score section (always shown)
    fields.push({
      name: '📊 Opportunity Score',
      value: `\`\`\`\n` +
             `Total Score:    ${decision.adjustedScore}/100\n` +
             `Volume:         ${market.volumeScore?.toFixed(1) || 'N/A'}/30\n` +
             `Edge:           ${market.edgeScore?.toFixed(1) || 'N/A'}/25\n` +
             `Catalyst:       ${market.catalystScore?.toFixed(1) || 'N/A'}/25\n` +
             `Quality:        ${market.qualityScore?.toFixed(1) || 'N/A'}/20\n` +
             `\`\`\``,
      inline: false
    });

    // Market Details
    const volume = market.volumeNum || 0;
    const daysToClose = market.timeToClose ? (market.timeToClose / (1000 * 60 * 60 * 24)).toFixed(1) : 'Unknown';
    const outcomes = market.outcomeCount || market.outcomes?.length || 2;

    fields.push({
      name: '💰 Market Details',
      value: `Volume: $${volume.toFixed(0)}\n` +
             `Outcomes: ${outcomes}\n` +
             `Closes in: ${daysToClose} days\n` +
             `Tier: ${market.tier || 'UNKNOWN'}`,
      inline: true
    });

    // Category & Confidence
    fields.push({
      name: '🎯 Classification',
      value: `Category: ${market.category || 'uncategorized'}\n` +
             `Cat. Score: ${market.categoryScore || 0} keywords\n` +
             `Spread: ${market.spread?.toFixed(0) || 'N/A'} bps\n` +
             `Signal: ${signal.signalType}`,
      inline: true
    });

    // Current Prices (if available)
    if (market.outcomePrices && market.outcomes) {
      const priceStr = market.outcomes
        .slice(0, 5) // Max 5 outcomes to avoid overflow
        .map((outcome, i) => {
          const price = parseFloat(market.outcomePrices[i] || '0');
          return `${outcome}: ${(price * 100).toFixed(0)}%`;
        })
        .join('\n');

      fields.push({
        name: '💹 Current Prices',
        value: priceStr,
        inline: false
      });
    }

    // Signal Reasoning (if HIGH or CRITICAL)
    if (priority === AlertPriority.CRITICAL || priority === AlertPriority.HIGH) {
      const reasoning = this.buildSignalReasoning(signal, decision);
      if (reasoning) {
        fields.push({
          name: '🔍 Why This Alert?',
          value: reasoning,
          inline: false
        });
      }
    }

    // Market Link
    const slug = market.metadata?.slug;
    const marketUrl = slug
      ? `https://polymarket.com/event/${slug}`
      : `https://polymarket.com/event/${market.id}`;

    fields.push({
      name: '🔗 Action',
      value: `[View Market on Polymarket](${marketUrl})`,
      inline: false
    });

    // Build embed
    const embed: DiscordEmbed = {
      title,
      description: `**${truncatedQuestion}**`,
      color,
      fields,
      footer: {
        text: `${priority} Priority • Score: ${decision.adjustedScore}/100 • Poly Early Bot`
      },
      timestamp: new Date().toISOString(),
      author: {
        name: `${priority} ALERT`,
        icon_url: priority === AlertPriority.CRITICAL ? 'https://i.imgur.com/critical.png' : undefined
      }
    };

    return embed;
  }

  /**
   * Build signal reasoning text
   */
  private buildSignalReasoning(signal: EarlySignal, decision: AlertDecision): string | null {
    const parts: string[] = [];

    // Priority assignment reason
    parts.push(`Priority: ${decision.priority} (Score ${decision.adjustedScore})`);

    // Tier bonus
    if (signal.market.tier) {
      const tierConfig = configManager.getConfig().detection.alertPrioritization.tierAdjustments;
      const boost = signal.market.tier === 'watchlist' ? tierConfig.watchlist.scoreBoost : tierConfig.active.scoreBoost;
      if (boost !== 0) {
        parts.push(`Tier Bonus: +${boost} (${signal.market.tier.toUpperCase()} tier)`);
      }
    }

    // Category edge
    if (signal.market.category) {
      parts.push(`Category: ${signal.market.category} (high edge)`);
    }

    // Time urgency
    if (signal.market.timeToClose) {
      const days = signal.market.timeToClose / (1000 * 60 * 60 * 24);
      if (days <= 7) {
        parts.push(`Urgent: Closes in ${days.toFixed(1)} days`);
      }
    }

    // Multi-outcome
    if ((signal.market.outcomeCount || 0) >= 5) {
      parts.push(`Multi-outcome: ${signal.market.outcomeCount} outcomes`);
    }

    return parts.length > 0 ? parts.join('\n') : null;
  }

  /**
   * Send webhook with timeout and error handling
   */
  private async sendWebhook(payload: DiscordWebhookPayload): Promise<boolean> {
    if (!this.webhookUrl) {
      return false;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

    try {
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        advancedLogger.error(`Discord webhook failed: ${response.status}`, new Error(errorText), {
          component: 'prioritized_notifier',
          operation: 'send_webhook',
          metadata: {
            status: response.status,
            statusText: response.statusText
          }
        });
        return false;
      }

      return true;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === 'AbortError') {
        advancedLogger.error('Discord webhook timeout', error, {
          component: 'prioritized_notifier',
          operation: 'send_webhook'
        });
      } else {
        advancedLogger.error('Discord webhook error', error as Error, {
          component: 'prioritized_notifier',
          operation: 'send_webhook'
        });
      }

      return false;
    }
  }

  /**
   * Sleep helper for retry delays
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Send test notification at each priority level
   */
  async sendTestNotifications(): Promise<Record<AlertPriority, boolean>> {
    const results: Record<AlertPriority, boolean> = {
      [AlertPriority.CRITICAL]: false,
      [AlertPriority.HIGH]: false,
      [AlertPriority.MEDIUM]: false,
      [AlertPriority.LOW]: false,
    };

    for (const priority of [AlertPriority.CRITICAL, AlertPriority.HIGH, AlertPriority.MEDIUM, AlertPriority.LOW]) {
      const embed: DiscordEmbed = {
        title: `${this.PRIORITY_EMOJIS[priority]} ${priority} Test Alert`,
        description: 'This is a test notification to verify priority-specific formatting.',
        color: this.PRIORITY_COLORS[priority],
        fields: [
          {
            name: 'Priority Level',
            value: priority,
            inline: true
          },
          {
            name: 'Test Status',
            value: '✅ Successfully Sent',
            inline: true
          },
          {
            name: 'Configuration',
            value: `Color: ${this.PRIORITY_COLORS[priority].toString(16)}\nEmoji: ${this.PRIORITY_EMOJIS[priority]}`,
            inline: false
          }
        ],
        footer: {
          text: `Test Alert • ${priority} Priority • Poly Early Bot`
        },
        timestamp: new Date().toISOString()
      };

      const payload: DiscordWebhookPayload = {
        embeds: [embed],
        username: 'Poly Early Bot - Priority Test',
      };

      try {
        results[priority] = await this.sendWebhook(payload);
        // Wait 1 second between test messages to avoid rate limits
        await this.sleep(1000);
      } catch (error) {
        logger.error(`Test notification failed for ${priority}:`, error);
        results[priority] = false;
      }
    }

    advancedLogger.info('Test notifications completed', {
      component: 'prioritized_notifier',
      operation: 'send_test_notifications',
      metadata: results
    });

    return results;
  }

  /**
   * Get notification statistics
   */
  getStats(): {
    configured: boolean;
    webhookUrl: string | null;
    alertManagerStats: any;
    rateLimitStatus: any;
  } {
    return {
      configured: this.webhookUrl !== null,
      webhookUrl: this.webhookUrl ? '***configured***' : null,
      alertManagerStats: alertManager.getStats(),
      rateLimitStatus: alertManager.getRateLimitStatus()
    };
  }
}

// Singleton instance (can be created with config from main)
export function createPrioritizedNotifier(config: BotConfig): PrioritizedDiscordNotifier {
  return new PrioritizedDiscordNotifier(config);
}
