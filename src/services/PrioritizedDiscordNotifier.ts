import { EarlySignal, AlertPriority, BotConfig } from '../types';
import { logger } from '../utils/logger';
import { advancedLogger } from '../utils/AdvancedLogger';
import { metricsCollector } from '../monitoring/MetricsCollector';
import { alertManager, AlertDecision } from './AlertManager';
import { configManager } from '../config/ConfigManager';
import type { SignalPerformanceTracker } from './SignalPerformanceTracker';

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
  private performanceTracker?: SignalPerformanceTracker;

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
   * Set the performance tracker (can be set after construction)
   */
  setPerformanceTracker(tracker: SignalPerformanceTracker): void {
    this.performanceTracker = tracker;
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
    const embed = await this.buildPrioritizedEmbed(signal, decision, notificationConfig);
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
  private async buildPrioritizedEmbed(
    signal: EarlySignal,
    decision: AlertDecision,
    notificationConfig: any
  ): Promise<DiscordEmbed> {
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
    if (market.outcomePrices && market.outcomes && Array.isArray(market.outcomes)) {
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

    // Add rich explanation fields for all priorities

    // Plain English interpretation - what this signal means
    const interpretationField = this.buildPlainEnglishInterpretation(signal);
    if (interpretationField) {
      fields.push(interpretationField);
    }

    // Signal strength/severity explanation
    const severityField = this.buildSeverityExplanation(signal);
    if (severityField) {
      fields.push(severityField);
    }

    // Market health dashboard
    const healthField = this.buildMarketHealthDashboard(signal);
    if (healthField) {
      fields.push(healthField);
    }

    // Detailed reasoning section based on signal type
    const reasoningField = this.buildReasoningSection(signal);
    if (reasoningField) {
      fields.push(reasoningField);
    }

    // Historical performance context (async)
    if (priority === AlertPriority.CRITICAL || priority === AlertPriority.HIGH) {
      const whatThisMeansField = await this.buildWhatThisMeans(signal);
      if (whatThisMeansField) {
        fields.push(whatThisMeansField);
      }

      const performanceField = await this.buildPerformanceStatsField(signal);
      if (performanceField) {
        fields.push(performanceField);
      }
    }

    // Actionable "what to watch next" guidance
    const whatToWatchField = this.buildWhatToWatch(signal);
    if (whatToWatchField) {
      fields.push(whatToWatchField);
    }

    // Old signal reasoning for context (kept for backwards compatibility)
    if (priority === AlertPriority.CRITICAL || priority === AlertPriority.HIGH) {
      const reasoning = this.buildSignalReasoning(signal, decision);
      if (reasoning) {
        fields.push({
          name: '📋 Priority Context',
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
   * Build plain English interpretation of the signal
   */
  private buildPlainEnglishInterpretation(signal: EarlySignal): { name: string; value: string; inline: boolean } | null {
    const metadata = signal.metadata;
    if (!metadata) return null;

    let interpretation = '';

    switch (signal.signalType) {
      case 'volume_spike':
        if (metadata.volumeChangePercent !== undefined) {
          const multiplier = metadata.spikeMultiplier || (metadata.volumeChangePercent / 100);
          interpretation = `📊 **Volume is ${multiplier.toFixed(1)}x higher than normal** - ${metadata.volumeChangePercent.toFixed(0)}% increase suggests significant new interest in this market. This could indicate informed traders entering positions or news catalyzing activity.`;
        }
        break;

      case 'price_movement':
        if (metadata.maxChange !== undefined) {
          const direction = metadata.maxChange > 0 ? 'upward' : 'downward';
          interpretation = `📈 **Sharp ${direction} price movement** - ${Math.abs(metadata.maxChange).toFixed(1)}% change indicates market sentiment is shifting rapidly. This magnitude of movement typically signals new information or large order flow.`;
        }
        break;

      case 'orderbook_imbalance':
        if (metadata.microstructureData?.context) {
          const bidVolume = metadata.microstructureData.context.bidVolume || 0;
          const askVolume = metadata.microstructureData.context.askVolume || 0;
          const ratio = askVolume > 0 ? bidVolume / askVolume : 0;

          if (ratio > 1.5) {
            interpretation = `🐂 **Aggressive buying pressure** - There's ${ratio.toFixed(1)}x more money waiting to buy than sell. This imbalance often precedes upward price movement as buyers overwhelm sellers.`;
          } else if (ratio < 0.67) {
            interpretation = `🐻 **Aggressive selling pressure** - There's ${(1/ratio).toFixed(1)}x more money waiting to sell than buy. This imbalance typically leads to downward price movement as sellers overwhelm buyers.`;
          } else {
            interpretation = `⚖️ **Orderbook becoming imbalanced** - Buy and sell pressure are starting to diverge. Watch for this imbalance to strengthen or reverse.`;
          }
        }
        break;

      case 'spread_anomaly':
        if (metadata.microstructureData) {
          const data = metadata.microstructureData;
          const changePercent = data.baseline ? ((data.change || 0) / data.baseline) * 100 : 0;
          if (changePercent > 50) {
            interpretation = `📐 **Market makers pulling back** - Spread widened ${changePercent.toFixed(0)}%, indicating reduced liquidity. This often happens before significant price moves when informed traders are active.`;
          } else {
            interpretation = `📐 **Spread tightening** - Market makers are more confident and competing aggressively. This usually indicates a more stable market with good liquidity.`;
          }
        }
        break;

      case 'market_maker_withdrawal':
        interpretation = `🚨 **Liquidity drying up** - Market makers are pulling their orders, leaving less depth in the orderbook. This often precedes volatility as fewer orders can absorb large trades.`;
        break;

      case 'liquidity_shift':
        interpretation = `💧 **Significant liquidity movement** - The available depth in the orderbook is changing dramatically. This can signal informed trading or preparation for a large move.`;
        break;

      case 'front_running_detected':
        interpretation = `🏃 **Potential front-running pattern** - Order flow suggests someone may be trading ahead of larger orders. This pattern typically appears when informed traders spot incoming volume.`;
        break;

      case 'information_leak':
        interpretation = `🔓 **Unusual cross-market activity** - Multiple related markets are moving in coordinated ways, suggesting information may be leaking before official announcements.`;
        break;

      case 'new_market':
        if (metadata.initialVolume) {
          interpretation = `🆕 **New market with immediate activity** - $${metadata.initialVolume.toFixed(0)} volume within minutes of creation suggests strong initial interest or insider knowledge.`;
        }
        break;

      default:
        return null;
    }

    if (!interpretation) return null;

    return {
      name: '💡 What This Means',
      value: interpretation,
      inline: false,
    };
  }

  /**
   * Get visual severity indicator
   */
  private getSeverityEmoji(confidence: number, metadata?: any): string {
    // Determine severity level
    if (confidence >= 0.9 || metadata?.severity === 'critical') {
      return '🔥🔥🔥'; // EXTREME
    } else if (confidence >= 0.75 || metadata?.severity === 'high') {
      return '🔥🔥'; // HIGH
    } else if (confidence >= 0.6 || metadata?.severity === 'medium') {
      return '🔥'; // ELEVATED
    } else {
      return '📊'; // NORMAL
    }
  }

  /**
   * Build severity explanation with context
   */
  private buildSeverityExplanation(signal: EarlySignal): { name: string; value: string; inline: boolean } | null {
    const emoji = this.getSeverityEmoji(signal.confidence, signal.metadata);
    const confidence = signal.confidence;

    let severity = '';
    let percentile = '';

    if (confidence >= 0.9) {
      severity = '**EXTREME**';
      percentile = 'top 1%';
    } else if (confidence >= 0.75) {
      severity = '**HIGH**';
      percentile = 'top 10%';
    } else if (confidence >= 0.6) {
      severity = '**ELEVATED**';
      percentile = 'top 25%';
    } else {
      severity = '**MODERATE**';
      percentile = 'top 50%';
    }

    // Add comparison to baseline if available
    let comparison = '';
    if (signal.metadata?.microstructureData?.baseline && signal.metadata?.microstructureData?.current) {
      const baseline = signal.metadata.microstructureData.baseline;
      const current = signal.metadata.microstructureData.current;
      const multiplier = baseline !== 0 ? (current / baseline) : 0;

      if (multiplier > 1) {
        comparison = `\n📊 This is **${multiplier.toFixed(1)}x** the typical level for this market`;
      }
    }

    const explanation = `${emoji} ${severity} (${percentile} of all signals)\nConfidence: ${(confidence * 100).toFixed(0)}%${comparison}`;

    return {
      name: '⚡ Signal Strength',
      value: explanation,
      inline: false,
    };
  }

  /**
   * Build detailed reasoning section based on signal type
   */
  private buildReasoningSection(signal: EarlySignal): { name: string; value: string; inline: boolean } | null {
    const metadata = signal.metadata;
    if (!metadata) return null;

    let reasoning = '```\n━━━━━ DETECTION REASONING ━━━━━\n';

    switch (signal.signalType) {
      case 'volume_spike':
        if (metadata.volumeChangePercent !== undefined && metadata.averageVolumeChange !== undefined) {
          reasoning += `Current Volume Change: +${metadata.volumeChangePercent.toFixed(1)}%\n`;
          reasoning += `Recent Average Change: +${metadata.averageVolumeChange.toFixed(1)}%\n`;
          reasoning += `Spike Multiplier: ${metadata.spikeMultiplier?.toFixed(1)}x\n`;
          reasoning += `Current Volume: $${metadata.currentVolume?.toFixed(0) || 'N/A'}\n`;
          reasoning += `Threshold: Must exceed ${metadata.averageVolumeChange.toFixed(1)}% avg\n`;
          if (signal.confidence) {
            reasoning += `Confidence: ${(signal.confidence * 100).toFixed(0)}%\n`;
          }
        }
        break;

      case 'price_movement':
        if (metadata.maxChange !== undefined) {
          // Show per-outcome changes
          if (metadata.priceChanges) {
            const outcomes = signal.market?.outcomes || ['YES', 'NO'];
            reasoning += `Outcome Changes:\n`;
            Object.entries(metadata.priceChanges).forEach(([key, value]) => {
              const index = parseInt(key.replace('outcome_', ''));
              const outcomeName = outcomes[index] || `Outcome ${index}`;
              const change = value as number;
              const sign = change > 0 ? '+' : '';
              reasoning += `  ${outcomeName}: ${sign}${change.toFixed(2)}%\n`;
            });
          } else {
            reasoning += `Max Price Change: ${metadata.maxChange.toFixed(2)}%\n`;
          }
          if (metadata.immediateChange !== undefined) {
            reasoning += `Immediate Change: ${metadata.immediateChange.toFixed(2)}%\n`;
          }
          if (metadata.cumulativeChange !== undefined) {
            reasoning += `Cumulative Change: ${metadata.cumulativeChange.toFixed(2)}%\n`;
          }
          if (metadata.movementType) {
            reasoning += `Movement Type: ${metadata.movementType}\n`;
          }
          reasoning += `Threshold: 1.5% minimum change\n`;
          if (signal.confidence) {
            reasoning += `Confidence: ${(signal.confidence * 100).toFixed(0)}%\n`;
          }
        }
        break;

      case 'orderbook_imbalance':
        if (metadata.microstructureData) {
          const data = metadata.microstructureData;
          const bidVolume = data.context?.bidVolume || 0;
          const askVolume = data.context?.askVolume || 0;
          const ratio = askVolume > 0 ? bidVolume / askVolume : 0;

          // Determine direction
          let direction = 'NEUTRAL';
          if (ratio > 1.5) {
            direction = 'BULLISH (bid-heavy)';
          } else if (ratio < 0.67) {
            direction = 'BEARISH (ask-heavy)';
          }

          reasoning += `Direction: ${direction}\n`;
          reasoning += `Bid Volume: $${bidVolume.toFixed(0)}\n`;
          reasoning += `Ask Volume: $${askVolume.toFixed(0)}\n`;
          reasoning += `Bid/Ask Ratio: ${ratio.toFixed(2)}:1\n`;
          reasoning += `Current Imbalance: ${data.current?.toFixed(4) || 'N/A'}\n`;
          reasoning += `Baseline: ${data.baseline?.toFixed(4) || 'N/A'}\n`;
          reasoning += `Change: ${data.change > 0 ? '+' : ''}${data.change?.toFixed(4) || 'N/A'}\n`;
          reasoning += `Threshold: 15% imbalance\n`;
          if (signal.confidence) {
            reasoning += `Confidence: ${(signal.confidence * 100).toFixed(0)}%\n`;
          }
        }
        break;

      case 'spread_anomaly':
        if (metadata.microstructureData) {
          const data = metadata.microstructureData;
          reasoning += `Current Spread: ${data.current?.toFixed(4) || 'N/A'}\n`;
          reasoning += `Baseline Spread: ${data.baseline?.toFixed(4) || 'N/A'}\n`;
          reasoning += `Change: ${data.change > 0 ? '+' : ''}${data.change?.toFixed(4) || 'N/A'}\n`;
          reasoning += `Detection: Abnormal spread change\n`;
          if (signal.confidence) {
            reasoning += `Confidence: ${(signal.confidence * 100).toFixed(0)}%\n`;
          }
        }
        break;

      case 'market_maker_withdrawal':
        if (metadata.microstructureData) {
          const data = metadata.microstructureData;
          reasoning += `Current Depth: ${data.current?.toFixed(4) || 'N/A'}\n`;
          reasoning += `Baseline Depth: ${data.baseline?.toFixed(4) || 'N/A'}\n`;
          reasoning += `Depth Reduction: ${data.change?.toFixed(4) || 'N/A'}\n`;
          reasoning += `Threshold: >15% depth reduction\n`;
          if (signal.confidence) {
            reasoning += `Confidence: ${(signal.confidence * 100).toFixed(0)}%\n`;
          }
        }
        break;

      case 'liquidity_shift':
        if (metadata.microstructureData) {
          const data = metadata.microstructureData;
          reasoning += `Current Liquidity: ${data.current?.toFixed(2) || 'N/A'}\n`;
          reasoning += `Baseline Liquidity: ${data.baseline?.toFixed(2) || 'N/A'}\n`;
          reasoning += `Change: ${data.change > 0 ? '+' : ''}${data.change?.toFixed(2) || 'N/A'}\n`;
          reasoning += `Threshold: 20+ point change\n`;
          if (signal.confidence) {
            reasoning += `Confidence: ${(signal.confidence * 100).toFixed(0)}%\n`;
          }
        }
        break;

      default:
        // Generic metadata display for other signal types
        if (metadata.microstructureData) {
          const data = metadata.microstructureData;
          reasoning += `Current: ${data.current?.toFixed(4) || 'N/A'}\n`;
          reasoning += `Baseline: ${data.baseline?.toFixed(4) || 'N/A'}\n`;
          reasoning += `Change: ${data.change > 0 ? '+' : ''}${data.change?.toFixed(4) || 'N/A'}\n`;
          if (signal.confidence) {
            reasoning += `Confidence: ${(signal.confidence * 100).toFixed(0)}%\n`;
          }
        } else {
          // No specific reasoning available
          return null;
        }
        break;
    }

    reasoning += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n```';

    return {
      name: '🔍 Why This Signal?',
      value: reasoning,
      inline: false,
    };
  }

  /**
   * Build market health dashboard
   */
  private buildMarketHealthDashboard(signal: EarlySignal): { name: string; value: string; inline: boolean } | null {
    const market = signal.market;
    if (!market) return null;

    let health = '```\n';

    // Liquidity
    const volumeK = market.volumeNum / 1000;
    let liquidityEmoji = '🟢';
    if (volumeK < 5) liquidityEmoji = '🔴';
    else if (volumeK < 20) liquidityEmoji = '🟡';
    health += `${liquidityEmoji} Liquidity: $${volumeK >= 1 ? volumeK.toFixed(1) + 'k' : market.volumeNum.toFixed(0)}\n`;

    // Spread
    if (market.spread !== undefined) {
      const spreadBps = market.spread;
      let spreadEmoji = '🟢';
      if (spreadBps > 500) spreadEmoji = '🔴';
      else if (spreadBps > 200) spreadEmoji = '🟡';
      health += `${spreadEmoji} Spread: ${spreadBps.toFixed(0)} bps\n`;
    }

    // Market age
    if (market.marketAge !== undefined) {
      const ageHours = market.marketAge / (1000 * 60 * 60);
      const ageDays = ageHours / 24;
      let ageStr = '';
      if (ageDays > 1) {
        ageStr = `${ageDays.toFixed(1)} days`;
      } else {
        ageStr = `${ageHours.toFixed(1)} hours`;
      }
      const ageEmoji = ageHours < 1 ? '🆕' : ageDays > 7 ? '📅' : '⏰';
      health += `${ageEmoji} Age: ${ageStr}\n`;
    }

    // Time to close
    if (market.timeToClose !== undefined && market.timeToClose > 0) {
      const hoursToClose = market.timeToClose / (1000 * 60 * 60);
      const daysToClose = hoursToClose / 24;
      let closeStr = '';
      if (daysToClose > 1) {
        closeStr = `${daysToClose.toFixed(1)} days`;
      } else {
        closeStr = `${hoursToClose.toFixed(1)} hours`;
      }
      const closeEmoji = hoursToClose < 24 ? '⏰' : '📅';
      health += `${closeEmoji} Closes in: ${closeStr}\n`;
    }

    // Quality score
    if (market.qualityScore !== undefined) {
      const score = market.qualityScore;
      let qualityEmoji = '🟢';
      if (score < 40) qualityEmoji = '🔴';
      else if (score < 70) qualityEmoji = '🟡';
      health += `${qualityEmoji} Quality: ${score.toFixed(0)}/100\n`;
    }

    health += '```';

    return {
      name: '🏥 Market Health',
      value: health,
      inline: false,
    };
  }

  /**
   * Build actionable "what to watch next" guidance
   */
  private buildWhatToWatch(signal: EarlySignal): { name: string; value: string; inline: boolean } | null {
    let guidance = '👀 **Watch for:**\n';
    let added = false;

    switch (signal.signalType) {
      case 'volume_spike':
        guidance += '• Price movement in next 5-15 minutes\n';
        guidance += '• Volume sustaining above baseline (not just a spike)\n';
        guidance += '• Orderbook imbalance developing\n';
        guidance += '\n🚨 **Red flags:**\n';
        guidance += '• Volume dropping back quickly (false alarm)\n';
        guidance += '• No corresponding price movement (liquidity test)';
        added = true;
        break;

      case 'price_movement':
        guidance += '• Orderbook depth at new price levels\n';
        guidance += '• Volume following the price move\n';
        guidance += '• Spread stability (tight = confidence, wide = uncertainty)\n';
        guidance += '\n🚨 **Red flags:**\n';
        guidance += '• Immediate reversal (stop hunt or fat finger)\n';
        guidance += '• Widening spread (liquidity concerns)';
        added = true;
        break;

      case 'orderbook_imbalance':
        guidance += '• Price moving in direction of imbalance\n';
        guidance += '• Imbalance strengthening (ratio increasing)\n';
        guidance += '• Large orders getting filled\n';
        guidance += '\n🚨 **Red flags:**\n';
        guidance += '• Imbalance flipping quickly (indecision)\n';
        guidance += '• Price moving opposite to imbalance (trap)';
        added = true;
        break;

      case 'spread_anomaly':
        guidance += '• Whether spread normalizes or widens further\n';
        guidance += '• New market makers entering\n';
        guidance += '• Price volatility increasing\n';
        guidance += '\n🚨 **Red flags:**\n';
        guidance += '• Spread continuing to widen (major liquidity issue)\n';
        guidance += '• Volume drying up completely';
        added = true;
        break;

      case 'market_maker_withdrawal':
      case 'liquidity_shift':
        guidance += '• Volatility increasing\n';
        guidance += '• Larger bid-ask spreads\n';
        guidance += '• New liquidity providers entering\n';
        guidance += '\n🚨 **Red flags:**\n';
        guidance += '• Total liquidity collapse\n';
        guidance += '• Market becoming untradeable';
        added = true;
        break;

      default:
        return null;
    }

    if (!added) return null;

    return {
      name: '🎯 Action Plan',
      value: guidance,
      inline: false,
    };
  }

  /**
   * Build "what this usually means" section with historical context
   */
  private async buildWhatThisMeans(signal: EarlySignal): Promise<{ name: string; value: string; inline: boolean } | null> {
    if (!this.performanceTracker) return null;

    try {
      const stats = await this.performanceTracker.getSignalTypeStats(signal.signalType);
      if (!stats || stats.totalSignals < 5) return null;

      let meaning = '';

      // Accuracy context
      if (stats.accuracy > 0.7) {
        meaning += `✅ **High reliability signal** - This type has been correct ${(stats.accuracy * 100).toFixed(0)}% of the time (${stats.totalSignals} historical cases).\n\n`;
      } else if (stats.accuracy > 0.5) {
        meaning += `⚠️ **Moderate reliability** - This signal type is correct ${(stats.accuracy * 100).toFixed(0)}% of the time. Use with caution.\n\n`;
      } else {
        meaning += `❌ **Lower reliability** - Historical accuracy is only ${(stats.accuracy * 100).toFixed(0)}%. Consider waiting for confirmation.\n\n`;
      }

      // Typical outcome
      if (stats.avgPnL24hr !== 0) {
        const direction = stats.avgPnL24hr > 0 ? 'gains' : 'losses';
        const emoji = stats.avgPnL24hr > 0 ? '📈' : '📉';
        meaning += `${emoji} **Typical 24hr outcome**: ${stats.avgPnL24hr > 0 ? '+' : ''}${stats.avgPnL24hr.toFixed(2)}% ${direction}\n`;
      }

      if (stats.avgPnL1hr !== 0) {
        meaning += `⏱️ **Short-term (1hr)**: ${stats.avgPnL1hr > 0 ? '+' : ''}${stats.avgPnL1hr.toFixed(2)}%\n`;
      }

      // Win rate
      if (stats.winRate > 0) {
        meaning += `\n🎯 **Success rate**: ${(stats.winRate * 100).toFixed(0)}% of trades were profitable\n`;
      }

      // Risk/reward
      if (stats.avgWin && stats.avgLoss) {
        const ratio = Math.abs(stats.avgWin / stats.avgLoss);
        meaning += `💰 **Risk/Reward**: Avg win ${stats.avgWin.toFixed(1)}% vs avg loss ${stats.avgLoss.toFixed(1)}% (${ratio.toFixed(1)}:1 ratio)`;
      }

      if (!meaning) return null;

      return {
        name: '📚 Historical Performance',
        value: meaning,
        inline: false,
      };
    } catch (error) {
      logger.error('Error building what-this-means section:', error);
      return null;
    }
  }

  /**
   * Build performance stats field showing historical accuracy and P&L for this signal type
   */
  private async buildPerformanceStatsField(signal: EarlySignal): Promise<{ name: string; value: string; inline: boolean } | null> {
    if (!this.performanceTracker) {
      return null;
    }

    try {
      const stats = await this.performanceTracker.getSignalTypeStats(signal.signalType);
      if (!stats || stats.totalSignals < 5) {
        // Don't show stats until we have at least 5 signals for meaningful data
        return null;
      }

      let statsText = '```\n━━━━━ HISTORICAL PERFORMANCE ━━━━━\n';

      // Accuracy metrics
      statsText += `Sample Size: ${stats.totalSignals} signals\n`;
      if (stats.accuracy > 0) {
        statsText += `Accuracy: ${(stats.accuracy * 100).toFixed(1)}%\n`;
      }
      if (stats.winRate > 0) {
        statsText += `Win Rate: ${(stats.winRate * 100).toFixed(1)}%\n`;
      }

      // P&L metrics
      if (stats.avgPnL1hr !== 0) {
        statsText += `Avg P&L (1hr): ${stats.avgPnL1hr > 0 ? '+' : ''}${stats.avgPnL1hr.toFixed(2)}%\n`;
      }
      if (stats.avgPnL24hr !== 0) {
        statsText += `Avg P&L (24hr): ${stats.avgPnL24hr > 0 ? '+' : ''}${stats.avgPnL24hr.toFixed(2)}%\n`;
      }

      // Risk metrics
      if (stats.sharpeRatio !== 0) {
        const sharpeEmoji = stats.sharpeRatio > 1 ? '✅' : stats.sharpeRatio > 0 ? '⚠️' : '❌';
        statsText += `Sharpe Ratio: ${stats.sharpeRatio.toFixed(2)} ${sharpeEmoji}\n`;
      }

      // Expected value and position sizing
      if (stats.expectedValue !== 0) {
        const evEmoji = stats.expectedValue > 0 ? '📈' : '📉';
        statsText += `Expected Value: ${stats.expectedValue > 0 ? '+' : ''}${stats.expectedValue.toFixed(2)}% ${evEmoji}\n`;
      }
      if (stats.kellyFraction > 0) {
        statsText += `Kelly Position Size: ${(stats.kellyFraction * 100).toFixed(1)}% of capital\n`;
      }

      // Bayesian confidence
      if (stats.posteriorConfidence !== 0.5) {
        statsText += `Bayesian Confidence: ${(stats.posteriorConfidence * 100).toFixed(1)}%\n`;
      }

      statsText += '```';

      return {
        name: '📊 Track Record',
        value: statsText,
        inline: false
      };
    } catch (error) {
      logger.error('Error fetching performance stats:', error);
      return null;
    }
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
