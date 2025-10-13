import { EarlySignal, AlertMessage, BotConfig, MicrostructureSignal } from '../types';
import { logger } from '../utils/logger';
import { discordRateLimiter } from '../utils/RateLimiter';

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
    momentum_breakout: '🚀',
    liquidity_shift: '💧',
    volume_spike: '📈',
    price_movement: '📊',
    new_market: '🆕',
    unusual_activity: '🔍',
  };

  constructor(config: BotConfig) {
    this.config = config;
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
      const alertMessage = this.buildAlertMessage(signal);
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

  private buildAlertMessage(signal: EarlySignal): AlertMessage {
    const alertType = this.determineAlertType(signal);
    const emoji = this.EMOJIS[signal.signalType as keyof typeof this.EMOJIS] || '🔔';
    
    return {
      type: alertType,
      title: `${emoji} ${this.formatSignalType(signal.signalType)} Detected`,
      description: this.buildDescription(signal),
      color: this.COLORS[alertType.toUpperCase() as keyof typeof this.COLORS] || this.COLORS.INFO,
      fields: this.buildFields(signal),
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
      embed.fields.push({
        name: '🔗 View Market',
        value: `[Open on Polymarket](https://polymarket.com/market/${signal.marketId})`,
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
      
      case 'momentum_breakout':
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

  private buildFields(signal: EarlySignal): Array<{ name: string; value: string; inline?: boolean }> {
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

    // Add technical indicators if available
    if (signal.metadata?.technicalIndicators) {
      const indicators = signal.metadata.technicalIndicators;
      if (indicators.rsi) {
        fields.push({
          name: 'RSI',
          value: indicators.rsi.toFixed(1),
          inline: true,
        });
      }
      if (indicators.momentum) {
        fields.push({
          name: 'Momentum',
          value: `${indicators.momentum > 0 ? '+' : ''}${indicators.momentum.toFixed(2)}%`,
          inline: true,
        });
      }
    }

    return fields;
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
}