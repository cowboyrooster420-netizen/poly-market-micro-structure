import { EarlySignal, AlertMessage, BotConfig, MicrostructureSignal } from '../types';
import { logger } from '../utils/logger';
import { discordRateLimiter } from '../utils/RateLimiter';
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
  thumbnail?: {
    url: string;
  };
}

interface DiscordWebhookPayload {
  content?: string;
  embeds?: DiscordEmbed[];
  username?: string;
  avatar_url?: string;
}

export class DiscordAlerter {
  private config: BotConfig;
  private performanceTracker?: SignalPerformanceTracker;
  private alertCounts: Map<string, number> = new Map();
  private lastAlertTimes: Map<string, number> = new Map();
  private rateLimitBuffer: number[] = [];
  private rateLimitMutex: Set<string> = new Set(); // Prevent race conditions for per-market limits
  private globalRateLimitMutex: boolean = false; // Prevent race conditions for global limits

  // Color constants for different alert types
  private readonly COLORS = {
    URGENT: 0xff0000,      // Red
    PRICE_ACTION: 0x00ff00, // Green
    LIQUIDITY: 0x0099ff,   // Blue
    NEW_OPPORTUNITY: 0xffaa00, // Orange
    FLASH_MOVE: 0xff00ff,  // Magenta
    INFO: 0x888888,        // Gray
  };

  // Emoji mapping for signal types
  private readonly EMOJIS = {
    orderbook_imbalance: '⚖️',
    spread_anomaly: '📐',
    market_maker_withdrawal: '🏃‍♂️',
    liquidity_shift: '💧',
    volume_spike: '📈',
    price_movement: '📊',
    new_market: '🆕',
    unusual_activity: '🔍',
  };

  constructor(config: BotConfig, performanceTracker?: SignalPerformanceTracker) {
    this.config = config;
    this.performanceTracker = performanceTracker;
  }

  /**
   * Set the performance tracker (can be set after construction)
   */
  setPerformanceTracker(tracker: SignalPerformanceTracker): void {
    this.performanceTracker = tracker;
  }

  async sendAlert(signal: EarlySignal): Promise<boolean> {
    if (!this.config.discord.webhookUrl) {
      logger.warn('Discord webhook URL not configured');
      return false;
    }

    // Atomic rate limit check and update to prevent race conditions
    if (!this.atomicRateLimitCheck(signal.marketId)) {
      logger.debug(`Rate limit exceeded for market ${signal.marketId}`);
      return false;
    }

    try {
      const alertMessage = await this.buildAlertMessage(signal);
      const embed = this.createEmbed(alertMessage, signal);

      const payload: DiscordWebhookPayload = {
        embeds: [embed],
        username: 'Poly Early Bot',
        avatar_url: 'https://i.imgur.com/polymarket-logo.png', // Placeholder
      };

      const success = await this.sendWebhookMessage(payload);
      
      if (success) {
        this.updateAlertCounts(signal);
        logger.debug(`Discord alert sent for ${signal.signalType} on ${signal.marketId}`);
      } else {
        // If webhook failed, revert the rate limit changes
        this.revertRateLimit(signal.marketId);
      }

      return success;
    } catch (error) {
      logger.error('Error sending Discord alert:', error);
      // Revert rate limit changes on error
      this.revertRateLimit(signal.marketId);
      return false;
    }
  }

  async sendMicrostructureAlert(signal: MicrostructureSignal): Promise<boolean> {
    if (!this.config.discord.webhookUrl) return false;

    try {
      const embed = this.createMicrostructureEmbed(signal);
      
      const payload: DiscordWebhookPayload = {
        embeds: [embed],
        username: 'Poly Microstructure Bot',
      };

      return await this.sendWebhookMessage(payload);
    } catch (error) {
      logger.error('Error sending microstructure alert:', error);
      return false;
    }
  }

  async sendPerformanceReport(stats: any): Promise<boolean> {
    if (!this.config.discord.webhookUrl) return false;

    try {
      const embed: DiscordEmbed = {
        title: '📈 Performance Report',
        color: this.COLORS.INFO,
        fields: [
          {
            name: 'Total Signals',
            value: stats.totalSignals.toString(),
            inline: true,
          },
          {
            name: 'Markets Tracked',
            value: stats.uniqueMarkets.toString(),
            inline: true,
          },
          {
            name: 'WebSocket Status',
            value: stats.connected ? '✅ Connected' : '❌ Disconnected',
            inline: true,
          },
          {
            name: 'Signals/Minute',
            value: stats.signalsPerMinute || 'N/A',
            inline: true,
          },
          {
            name: 'Uptime',
            value: stats.uptime || 'N/A',
            inline: true,
          },
        ],
        timestamp: new Date().toISOString(),
        footer: {
          text: 'Poly Early Bot Performance',
        },
      };

      const payload: DiscordWebhookPayload = {
        embeds: [embed],
        username: 'Poly Early Bot',
      };

      return await this.sendWebhookMessage(payload);
    } catch (error) {
      logger.error('Error sending performance report:', error);
      return false;
    }
  }

  private async buildAlertMessage(signal: EarlySignal): Promise<AlertMessage> {
    const alertType = this.determineAlertType(signal);
    const emoji = this.EMOJIS[signal.signalType as keyof typeof this.EMOJIS] || '🔔';
    const severityEmoji = this.getSeverityEmoji(signal.confidence, signal.metadata);

    return {
      type: alertType,
      title: `${severityEmoji} ${emoji} ${this.formatSignalType(signal.signalType)} Detected`,
      description: this.buildDescription(signal),
      color: this.COLORS[alertType.toUpperCase() as keyof typeof this.COLORS] || this.COLORS.INFO,
      fields: await this.buildFields(signal),
      footer: `Confidence: ${(signal.confidence * 100).toFixed(0)}% | Poly Early Bot`,
      timestamp: signal.timestamp,
    };
  }

  private createEmbed(alertMessage: AlertMessage, signal: EarlySignal): DiscordEmbed {
    const embed: DiscordEmbed = {
      title: alertMessage.title,
      description: alertMessage.description,
      color: alertMessage.color,
      fields: alertMessage.fields,
      footer: {
        text: alertMessage.footer || 'Poly Early Bot',
      },
      timestamp: new Date(alertMessage.timestamp).toISOString(),
    };

    // Add market link if available
    if (signal.marketId) {
      embed.fields = embed.fields || [];

      // Try to use the slug for a clean URL, fallback to condition_id
      const slug = signal.market?.metadata?.slug;
      let marketUrl: string;

      if (slug) {
        // Use slug for clean, working URL
        marketUrl = `https://polymarket.com/event/${slug}`;
      } else {
        // Fallback: use condition_id (may not work but better than nothing)
        marketUrl = `https://polymarket.com/event/${signal.marketId}`;
      }

      embed.fields.push({
        name: '🔗 View Market',
        value: `[Open on Polymarket](${marketUrl})`,
        inline: false,
      });
    }

    return embed;
  }

  private createMicrostructureEmbed(signal: MicrostructureSignal): DiscordEmbed {
    const emoji = this.EMOJIS[signal.type as keyof typeof this.EMOJIS] || '📊';
    const severityColor = {
      low: 0x00ff00,
      medium: 0xffaa00,
      high: 0xff6600,
      critical: 0xff0000,
    };

    return {
      title: `${emoji} ${this.formatSignalType(signal.type)}`,
      description: `Market: \`${signal.marketId.substring(0, 8)}...\``,
      color: severityColor[signal.severity],
      fields: [
        {
          name: 'Current Value',
          value: signal.data.current.toFixed(4),
          inline: true,
        },
        {
          name: 'Baseline',
          value: signal.data.baseline.toFixed(4),
          inline: true,
        },
        {
          name: 'Change',
          value: `${signal.data.change > 0 ? '+' : ''}${signal.data.change.toFixed(4)}`,
          inline: true,
        },
        {
          name: 'Confidence',
          value: `${(signal.confidence * 100).toFixed(0)}%`,
          inline: true,
        },
        {
          name: 'Severity',
          value: signal.severity.toUpperCase(),
          inline: true,
        },
      ],
      timestamp: new Date(signal.timestamp).toISOString(),
      footer: {
        text: 'Microstructure Analysis',
      },
    };
  }

  private determineAlertType(signal: EarlySignal): 'urgent' | 'price_action' | 'liquidity' | 'new_opportunity' | 'flash_move' {
    const severity = signal.metadata?.severity;
    
    if (severity === 'critical') return 'urgent';
    
    switch (signal.signalType) {
      case 'orderbook_imbalance':
      case 'market_maker_withdrawal':
      case 'liquidity_shift':
        return 'liquidity';

      case 'price_movement':
        return severity === 'high' ? 'flash_move' : 'price_action';

      case 'new_market':
        return 'new_opportunity';

      case 'volume_spike':
        return severity === 'high' ? 'urgent' : 'price_action';

      default:
        return 'price_action';
    }
  }

  private formatSignalType(signalType: string): string {
    return signalType
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  private buildDescription(signal: EarlySignal): string {
    const marketId = signal.marketId.substring(0, 8) + '...';
    const question = signal.market.question?.substring(0, 100) || 'Market data';

    return `**Market:** \`${marketId}\`\n**Question:** ${question}${question.length === 100 ? '...' : ''}`;
  }

  private async buildFields(signal: EarlySignal): Promise<Array<{ name: string; value: string; inline?: boolean }>>{
    const fields = [
      {
        name: 'Market ID',
        value: `\`${signal.marketId}\``,
        inline: true,
      },
      {
        name: 'Signal Type',
        value: this.formatSignalType(signal.signalType),
        inline: true,
      },
      {
        name: 'Confidence',
        value: `${(signal.confidence * 100).toFixed(0)}%`,
        inline: true,
      },
    ];

    // Add market stats (spread, volume, quality)
    const spreadBps = signal.market?.spread;
    if (spreadBps !== undefined && spreadBps !== null) {
      fields.push({
        name: 'Spread',
        value: `${spreadBps.toFixed(0)} bps`,
        inline: true,
      });
    } else {
      fields.push({
        name: 'Spread',
        value: 'N/A',
        inline: true,
      });
    }

    const volumeNum = signal.market?.volumeNum;
    if (volumeNum !== undefined && volumeNum !== null) {
      fields.push({
        name: 'Volume',
        value: `$${volumeNum >= 1000 ? (volumeNum / 1000).toFixed(1) + 'k' : volumeNum.toFixed(0)}`,
        inline: true,
      });
    }

    const qualityScore = signal.market?.qualityScore;
    if (qualityScore !== undefined && qualityScore !== null) {
      fields.push({
        name: 'Quality',
        value: `${qualityScore.toFixed(0)}/100`,
        inline: true,
      });
    }

    // Add signal strength/severity explanation
    const severityField = this.buildSeverityExplanation(signal);
    if (severityField) {
      fields.push(severityField);
    }

    // Add plain English interpretation - what this signal means
    const interpretationField = this.buildPlainEnglishInterpretation(signal);
    if (interpretationField) {
      fields.push(interpretationField);
    }

    // Add market health dashboard
    const healthField = this.buildMarketHealthDashboard(signal);
    if (healthField) {
      fields.push(healthField);
    }

    // Add direction indicator if determinable
    const directionField = this.buildDirectionIndicator(signal);
    if (directionField) {
      fields.push(directionField);
    }

    // Add "what this usually means" with historical performance
    const whatThisMeansField = await this.buildWhatThisMeans(signal);
    if (whatThisMeansField) {
      fields.push(whatThisMeansField);
    }

    // Add actionable "what to watch next" guidance
    const whatToWatchField = this.buildWhatToWatch(signal);
    if (whatToWatchField) {
      fields.push(whatToWatchField);
    }

    // Add detailed reasoning section based on signal type
    const reasoningField = this.buildReasoningSection(signal);
    if (reasoningField) {
      fields.push(reasoningField);
    }

    // Add microstructure data if available
    if (signal.metadata?.microstructureData) {
      const data = signal.metadata.microstructureData;
      fields.push(
        {
          name: 'Current Value',
          value: data.current?.toFixed(4) || 'N/A',
          inline: true,
        },
        {
          name: 'Change',
          value: `${data.change > 0 ? '+' : ''}${data.change?.toFixed(4) || 'N/A'}`,
          inline: true,
        }
      );
    }

    return fields;
  }

  private buildDirectionIndicator(signal: EarlySignal): { name: string; value: string; inline: boolean } | null {
    const metadata = signal.metadata;
    if (!metadata) return null;

    let direction: string | null = null;
    let emoji = '';

    switch (signal.signalType) {
      case 'price_movement':
        // Extract which outcome moved and direction
        if (metadata.priceChanges) {
          const outcomes = signal.market?.outcomes || ['YES', 'NO'];
          let maxChange = 0;
          let maxOutcomeIndex = 0;

          Object.entries(metadata.priceChanges).forEach(([key, value]) => {
            const index = parseInt(key.replace('outcome_', ''));
            const change = value as number;
            if (Math.abs(change) > Math.abs(maxChange)) {
              maxChange = change;
              maxOutcomeIndex = index;
            }
          });

          const outcomeName = outcomes[maxOutcomeIndex] || `Outcome ${maxOutcomeIndex}`;
          const changeSign = maxChange > 0 ? '+' : '';
          emoji = maxChange > 0 ? '📈' : '📉';
          direction = `${emoji} ${outcomeName}: ${changeSign}${maxChange.toFixed(1)}%`;
        }
        break;

      case 'orderbook_imbalance':
        // Determine bullish (bid-heavy) vs bearish (ask-heavy)
        if (metadata.microstructureData?.context) {
          const bidVolume = metadata.microstructureData.context.bidVolume || 0;
          const askVolume = metadata.microstructureData.context.askVolume || 0;
          const ratio = askVolume > 0 ? bidVolume / askVolume : 0;

          if (ratio > 1.5) {
            emoji = '🐂';
            direction = `${emoji} BULLISH (${ratio.toFixed(2)}:1 bid/ask)`;
          } else if (ratio < 0.67) {
            emoji = '🐻';
            direction = `${emoji} BEARISH (1:${(1/ratio).toFixed(2)} bid/ask)`;
          }
        }
        break;

      case 'unusual_activity':
        // Check if there's directional price movement
        if (metadata.priceChanges || metadata.volumeChange !== undefined) {
          const volumeChange = metadata.volumeChange || 0;
          if (volumeChange > 10) {
            emoji = '⚡';
            direction = `${emoji} INCREASING ACTIVITY (+${volumeChange.toFixed(1)}% volume)`;
          }
        }
        break;

      case 'volume_spike':
        // Check current prices to infer direction if available
        if (signal.market?.outcomePrices) {
          const prices = signal.market.outcomePrices.map(p => parseFloat(p));
          const outcomes = signal.market?.outcomes || ['YES', 'NO'];

          // Show current prices for context
          if (prices.length >= 2) {
            const yesPrice = (prices[0] * 100).toFixed(0);
            const noPrice = (prices[1] * 100).toFixed(0);
            emoji = '💹';
            direction = `${emoji} Current: ${outcomes[0] || 'YES'} ${yesPrice}% / ${outcomes[1] || 'NO'} ${noPrice}%`;
          }
        }
        break;
    }

    if (direction) {
      return {
        name: '🎯 Direction',
        value: direction,
        inline: false
      };
    }

    return null;
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

      case 'unusual_activity':
        if (metadata.activityScore !== undefined) {
          reasoning += `Activity Score: ${metadata.activityScore.toFixed(1)}/100\n`;
          reasoning += `Threshold: 70+ for unusual activity\n`;
          if (metadata.volumeChange !== undefined) {
            reasoning += `Volume Change: ${metadata.volumeChange > 0 ? '+' : ''}${metadata.volumeChange.toFixed(1)}%\n`;
          }
          if (signal.confidence) {
            reasoning += `Confidence: ${(signal.confidence * 100).toFixed(0)}%\n`;
          }
        }
        break;

      case 'new_market':
        if (metadata.timeSinceCreation !== undefined) {
          const ageMinutes = Math.floor(metadata.timeSinceCreation / (60 * 1000));
          reasoning += `Market Age: ${ageMinutes} minutes\n`;
          reasoning += `Initial Volume: $${metadata.initialVolume?.toFixed(0) || 'N/A'}\n`;
          reasoning += `Detection: New market with volume\n`;
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

      case 'aggressive_buyer':
      case 'aggressive_seller':
        if (metadata.microstructureData) {
          const data = metadata.microstructureData;
          const side = signal.signalType === 'aggressive_buyer' ? 'Buy' : 'Sell';
          reasoning += `${side} Pressure: ${data.current?.toFixed(4) || 'N/A'}\n`;
          reasoning += `Normal Flow: ${data.baseline?.toFixed(4) || 'N/A'}\n`;
          reasoning += `Imbalance: ${data.change > 0 ? '+' : ''}${data.change?.toFixed(4) || 'N/A'}\n`;
          reasoning += `Detection: Aggressive ${side.toLowerCase()}ing\n`;
          if (signal.confidence) {
            reasoning += `Confidence: ${(signal.confidence * 100).toFixed(0)}%\n`;
          }
        }
        break;

      case 'front_running_detected':
        if (metadata.microstructureData) {
          const data = metadata.microstructureData;
          reasoning += `Front-Run Score: ${data.current?.toFixed(4) || 'N/A'}\n`;
          reasoning += `Baseline: ${data.baseline?.toFixed(4) || 'N/A'}\n`;
          reasoning += `Detection: Potential front-running\n`;
          if (signal.confidence) {
            reasoning += `Confidence: ${(signal.confidence * 100).toFixed(0)}%\n`;
          }
        }
        break;

      case 'coordinated_cross_market':
        if (metadata.correlatedMarketQuestion) {
          reasoning += `Correlated Market:\n${metadata.correlatedMarketQuestion}\n`;
          if (metadata.correlationCoefficient) {
            reasoning += `Correlation: ${metadata.correlationCoefficient.toFixed(3)}\n`;
          }
          if (metadata.correlationType) {
            reasoning += `Type: ${metadata.correlationType}\n`;
          }
          reasoning += `Detection: Cross-market coordination\n`;
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

      case 'front_running_detected':
        guidance += '• Large orders appearing in next few minutes\n';
        guidance += '• Price moving sharply after accumulation\n';
        guidance += '• Related markets showing similar patterns\n';
        guidance += '\n🚨 **Red flags:**\n';
        guidance += '• No follow-through (false positive)\n';
        guidance += '• Pattern appearing in isolated market only';
        added = true;
        break;

      case 'information_leak':
        guidance += '• Official announcements or news within hours\n';
        guidance += '• Additional correlated markets activating\n';
        guidance += '• Volume acceleration across cluster\n';
        guidance += '\n🚨 **Red flags:**\n';
        guidance += '• Correlation breaking down\n';
        guidance += '• No news materializing within 24 hours';
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

  private atomicRateLimitCheck(marketId: string): boolean {
    // Check if this market is already being processed (race condition prevention)
    if (this.rateLimitMutex.has(marketId)) {
      return false;
    }

    // Check if global rate limit is being updated (race condition prevention)
    if (this.globalRateLimitMutex) {
      return false;
    }

    const now = Date.now();
    const lastAlert = this.lastAlertTimes.get(marketId) || 0;
    const timeSinceLastAlert = now - lastAlert;
    
    // Rate limit per market: max 1 alert per minute
    if (timeSinceLastAlert < 60000) {
      return false;
    }

    // Clean up old global rate limit entries
    this.rateLimitBuffer = this.rateLimitBuffer.filter(time => now - time < 60000);
    
    // Global rate limit: max alertRateLimit alerts per minute
    if (this.rateLimitBuffer.length >= this.config.discord.alertRateLimit) {
      return false;
    }

    // Atomically reserve the rate limit slots
    this.globalRateLimitMutex = true;
    this.rateLimitMutex.add(marketId);
    
    // Update rate limit tracking immediately
    this.lastAlertTimes.set(marketId, now);
    this.rateLimitBuffer.push(now);
    
    // Release global mutex (market mutex stays until alert completes)
    this.globalRateLimitMutex = false;
    
    return true;
  }

  private updateAlertCounts(signal: EarlySignal): void {
    // Update alert counts (this happens after successful send)
    const count = this.alertCounts.get(signal.signalType) || 0;
    this.alertCounts.set(signal.signalType, count + 1);
    
    // Release the market mutex now that alert is complete
    this.rateLimitMutex.delete(signal.marketId);
  }

  private revertRateLimit(marketId: string): void {
    // Remove the rate limit entries we added if the alert failed
    const now = Date.now();
    const lastAlert = this.lastAlertTimes.get(marketId);
    
    // Only revert if this was the most recent timestamp we added
    if (lastAlert && (now - lastAlert) < 1000) {
      this.lastAlertTimes.delete(marketId);
      
      // Remove the most recent entry from global buffer
      const lastIndex = this.rateLimitBuffer.lastIndexOf(lastAlert);
      if (lastIndex !== -1) {
        this.rateLimitBuffer.splice(lastIndex, 1);
      }
    }
    
    // Release the market mutex
    this.rateLimitMutex.delete(marketId);
  }

  private async sendWebhookMessage(payload: DiscordWebhookPayload): Promise<boolean> {
    try {
      const response = await discordRateLimiter.execute(async () => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout for Discord
        
        try {
          return await fetch(this.config.discord.webhookUrl!, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeoutId);
        }
      });

      if (!response.ok) {
        logger.error(`Discord webhook failed: ${response.status} ${response.statusText}`);
        return false;
      }

      return true;
    } catch (error) {
      logger.error('Error sending Discord webhook:', error);
      return false;
    }
  }

  // Utility methods
  getAlertStats(): { [key: string]: number } {
    return Object.fromEntries(this.alertCounts);
  }

  clearAlertHistory(): void {
    this.alertCounts.clear();
    this.lastAlertTimes.clear();
    this.rateLimitBuffer = [];
    this.rateLimitMutex.clear();
    this.globalRateLimitMutex = false;
  }

  // Test method
  async sendTestAlert(): Promise<boolean> {
    const testEmbed: DiscordEmbed = {
      title: '🧪 Test Alert',
      description: 'This is a test message from Poly Early Bot',
      color: this.COLORS.INFO,
      timestamp: new Date().toISOString(),
      footer: {
        text: 'Test Message',
      },
    };

    const payload: DiscordWebhookPayload = {
      embeds: [testEmbed],
      username: 'Poly Early Bot',
    };

    return await this.sendWebhookMessage(payload);
  }

  /**
   * Send a comprehensive P&L report for all signal types
   */
  async sendPnLReport(allStats: import('../services/SignalPerformanceTracker').SignalTypeStats[]): Promise<boolean> {
    if (!this.config.discord.webhookUrl) return false;
    if (!allStats || allStats.length === 0) {
      logger.info('No signal performance data available yet for P&L report');
      return false;
    }

    try {
      const fields: { name: string; value: string; inline: boolean }[] = [];

      // Overall summary
      const totalSignals = allStats.reduce((sum, s) => sum + s.totalSignals, 0);
      const weightedAccuracy = allStats.reduce((sum, s) => sum + (s.accuracy * s.totalSignals), 0) / totalSignals;
      const avgPnL24hr = allStats.reduce((sum, s) => sum + (s.avgPnL24hr * s.totalSignals), 0) / totalSignals;

      fields.push({
        name: '📊 Overall Summary',
        value: `\`\`\`
Total Signals: ${totalSignals}
Avg Accuracy:  ${(weightedAccuracy * 100).toFixed(1)}%
Avg 24hr P&L:  ${(avgPnL24hr * 100).toFixed(2)}%
\`\`\``,
        inline: false
      });

      // Per signal type stats
      allStats.forEach(stat => {
        if (stat.totalSignals < 3) return; // Skip signal types with too few samples

        const signalName = stat.signalType.replace(/_/g, ' ').toUpperCase();
        let statsText = '```\n';
        statsText += `Signals:    ${stat.totalSignals}\n`;
        statsText += `Accuracy:   ${(stat.accuracy * 100).toFixed(1)}%\n`;
        statsText += `Win Rate:   ${(stat.winRate * 100).toFixed(1)}%\n`;
        statsText += `\n`;
        statsText += `30min P&L:  ${(stat.avgPnL30min * 100).toFixed(2)}%\n`;
        statsText += `1hr P&L:    ${(stat.avgPnL1hr * 100).toFixed(2)}%\n`;
        statsText += `24hr P&L:   ${(stat.avgPnL24hr * 100).toFixed(2)}%\n`;
        if (stat.avgPnLFinal !== 0) {
          statsText += `Final P&L:  ${(stat.avgPnLFinal * 100).toFixed(2)}%\n`;
        }
        statsText += `\n`;
        statsText += `Avg Win:    +${(stat.avgWin * 100).toFixed(2)}%\n`;
        statsText += `Avg Loss:   ${(stat.avgLoss * 100).toFixed(2)}%\n`;
        statsText += `Sharpe:     ${stat.sharpeRatio.toFixed(2)}\n`;
        statsText += `EV:         ${(stat.expectedValue * 100).toFixed(2)}%\n`;
        if (stat.kellyFraction > 0) {
          statsText += `Kelly:      ${(stat.kellyFraction * 100).toFixed(1)}%\n`;
        }
        statsText += '```';

        fields.push({
          name: `📌 ${signalName}`,
          value: statsText,
          inline: false
        });
      });

      if (fields.length === 1) {
        // Only overall summary, no individual signal types with enough data
        fields.push({
          name: '⏳ Insufficient Data',
          value: 'Need at least 3 signals per type for detailed stats.\nKeep the bot running to collect more data!',
          inline: false
        });
      }

      const embed: DiscordEmbed = {
        title: '💰 Signal P&L Performance Report',
        description: 'Historical performance metrics for all signal types',
        color: 0x00d1cd, // Teal color
        fields,
        footer: {
          text: 'Poly Early Bot • P&L Report',
        },
        timestamp: new Date().toISOString(),
      };

      const payload: DiscordWebhookPayload = {
        embeds: [embed],
        username: 'Poly Early Bot',
      };

      logger.info('Sending P&L report to Discord');
      return await this.sendWebhookMessage(payload);
    } catch (error) {
      logger.error('Error sending P&L report:', error);
      return false;
    }
  }
}