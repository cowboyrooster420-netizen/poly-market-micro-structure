import { logger as baseLogger } from './logger';
import * as fs from 'fs/promises';
import * as path from 'path';
import fetch from 'node-fetch';

export interface LogContext {
  component?: string;
  operation?: string;
  marketId?: string;
  signalType?: string;
  userId?: string;
  requestId?: string;
  duration?: number;
  status?: string;
  metadata?: Record<string, any>;
}

export interface PerformanceMetric {
  name: string;
  value: number;
  unit: 'ms' | 'count' | 'bytes' | 'percent' | 'rate';
  timestamp: number;
  tags?: Record<string, string>;
}

export interface AlertConfig {
  level: 'info' | 'warn' | 'error' | 'critical';
  channels: Array<'console' | 'discord' | 'file' | 'database'>;
  rateLimit?: {
    maxAlerts: number;
    windowMs: number;
  };
  conditions?: {
    minSeverity?: 'low' | 'medium' | 'high' | 'critical';
    component?: string[];
    operation?: string[];
  };
}

export class AdvancedLogger {
  private performanceMetrics: PerformanceMetric[] = [];
  private alertConfigs: Map<string, AlertConfig> = new Map();
  private alertCounts: Map<string, { count: number; resetTime: number }> = new Map();
  private contextStack: LogContext[] = [];
  private database: any = null; // Optional database instance for alert storage
  private alertsFilePath: string;
  private discordWebhookUrl: string | null = null;

  constructor() {
    this.setupDefaultAlertConfigs();

    // Setup alert file path
    this.alertsFilePath = path.join(process.cwd(), 'logs', 'alerts.log');

    // Get Discord webhook from environment
    this.discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL || null;

    // Cleanup old metrics every 5 minutes
    setInterval(() => this.cleanupOldMetrics(), 5 * 60 * 1000);

    baseLogger.info('Advanced logger initialized with structured logging and alerting');
  }

  /**
   * Set database instance for alert persistence (optional)
   */
  setDatabase(database: any): void {
    this.database = database;
    baseLogger.info('Database configured for advanced logger alerts');
  }

  /**
   * Enhanced logging with context
   */
  info(message: string, context?: LogContext): void {
    this.log('info', message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.log('warn', message, context);
    this.checkAlerts('warn', message, context);
  }

  error(message: string, error?: Error, context?: LogContext): void {
    const enhancedContext = {
      ...context,
      error: error ? {
        name: error.name,
        message: error.message,
        stack: error.stack
      } : undefined
    };
    
    this.log('error', message, enhancedContext);
    this.checkAlerts('error', message, enhancedContext);
  }

  critical(message: string, error?: Error, context?: LogContext): void {
    const enhancedContext = {
      ...context,
      severity: 'critical',
      error: error ? {
        name: error.name,
        message: error.message,
        stack: error.stack
      } : undefined
    };
    
    this.log('error', `🚨 CRITICAL: ${message}`, enhancedContext);
    this.checkAlerts('critical', message, enhancedContext);
  }

  /**
   * Performance monitoring
   */
  recordMetric(metric: PerformanceMetric): void {
    this.performanceMetrics.push({
      ...metric,
      timestamp: metric.timestamp || Date.now()
    });

    // Log significant performance issues
    if (metric.name.includes('response_time') && metric.value > 5000) {
      this.warn(`Slow response time detected: ${metric.name} = ${metric.value}ms`, {
        component: 'performance',
        operation: metric.name,
        metadata: { metric }
      });
    }

    if (metric.name.includes('error_rate') && metric.value > 10) {
      this.error(`High error rate detected: ${metric.name} = ${metric.value}%`, undefined, {
        component: 'performance',
        operation: metric.name,
        metadata: { metric }
      });
    }
  }

  /**
   * Time a function execution and log performance
   */
  async timeOperation<T>(
    operation: () => Promise<T>,
    operationName: string,
    context?: LogContext
  ): Promise<T> {
    const startTime = Date.now();
    const requestId = this.generateRequestId();
    
    this.pushContext({ ...context, operation: operationName, requestId });
    
    try {
      this.info(`Starting operation: ${operationName}`, { requestId });
      
      const result = await operation();
      const duration = Date.now() - startTime;
      
      this.recordMetric({
        name: `operation_duration_${operationName}`,
        value: duration,
        unit: 'ms',
        timestamp: Date.now(),
        tags: { operation: operationName, status: 'success' }
      });
      
      this.info(`Completed operation: ${operationName}`, { 
        requestId, 
        duration,
        status: 'success'
      });
      
      return result;
      
    } catch (error) {
      const duration = Date.now() - startTime;
      
      this.recordMetric({
        name: `operation_duration_${operationName}`,
        value: duration,
        unit: 'ms',
        timestamp: Date.now(),
        tags: { operation: operationName, status: 'error' }
      });
      
      this.error(`Failed operation: ${operationName}`, error as Error, { 
        requestId, 
        duration,
        status: 'error'
      });
      
      throw error;
      
    } finally {
      this.popContext();
    }
  }

  /**
   * Log market-specific events with enhanced context
   */
  logMarketEvent(
    level: 'info' | 'warn' | 'error',
    message: string,
    marketId: string,
    signalType?: string,
    metadata?: Record<string, any>
  ): void {
    const context: LogContext = {
      component: 'market_analysis',
      marketId: marketId.substring(0, 8) + '...',
      signalType,
      metadata
    };
    
    if (level === 'info') {
      this.info(message, context);
    } else if (level === 'warn') {
      this.warn(message, context);
    } else if (level === 'error') {
      this.error(message, undefined, context);
    }
  }

  /**
   * Log signal detection with comprehensive context
   */
  logSignalDetection(
    signalType: string,
    marketId: string,
    confidence: number,
    metadata?: Record<string, any>
  ): void {
    const context: LogContext = {
      component: 'signal_detection',
      operation: 'signal_generated',
      marketId: marketId.substring(0, 8) + '...',
      signalType,
      metadata: {
        confidence,
        ...metadata
      }
    };

    if (confidence > 0.8) {
      this.warn(`High-confidence signal detected: ${signalType}`, context);
    } else {
      this.info(`Signal detected: ${signalType}`, context);
    }

    // Record signal metrics
    this.recordMetric({
      name: `signal_confidence_${signalType}`,
      value: confidence,
      unit: 'percent',
      timestamp: Date.now(),
      tags: { signalType, marketId: marketId.substring(0, 8) }
    });
  }

  /**
   * Get performance metrics for monitoring
   */
  getPerformanceMetrics(timeRangeMs: number = 60 * 60 * 1000): PerformanceMetric[] {
    const cutoff = Date.now() - timeRangeMs;
    return this.performanceMetrics.filter(metric => metric.timestamp > cutoff);
  }

  /**
   * Get aggregated performance statistics
   */
  getPerformanceStats(timeRangeMs: number = 60 * 60 * 1000): {
    avgResponseTime: number;
    operationCounts: Record<string, number>;
    errorRates: Record<string, number>;
    topSlowOperations: Array<{ name: string; avgDuration: number; count: number }>;
  } {
    const metrics = this.getPerformanceMetrics(timeRangeMs);
    
    const responseTimeMetrics = metrics.filter(m => m.name.includes('duration'));
    const avgResponseTime = responseTimeMetrics.length > 0 ? 
      responseTimeMetrics.reduce((sum, m) => sum + m.value, 0) / responseTimeMetrics.length : 0;

    const operationCounts: Record<string, number> = {};
    const operationDurations: Record<string, number[]> = {};
    const errorCounts: Record<string, number> = {};
    const totalCounts: Record<string, number> = {};

    for (const metric of metrics) {
      if (metric.name.includes('duration')) {
        const operation = metric.name.replace('operation_duration_', '');
        operationCounts[operation] = (operationCounts[operation] || 0) + 1;
        
        if (!operationDurations[operation]) {
          operationDurations[operation] = [];
        }
        operationDurations[operation].push(metric.value);
        
        totalCounts[operation] = (totalCounts[operation] || 0) + 1;
        
        if (metric.tags?.status === 'error') {
          errorCounts[operation] = (errorCounts[operation] || 0) + 1;
        }
      }
    }

    const errorRates: Record<string, number> = {};
    for (const operation in totalCounts) {
      const errors = errorCounts[operation] || 0;
      const total = totalCounts[operation];
      errorRates[operation] = total > 0 ? (errors / total) * 100 : 0;
    }

    const topSlowOperations = Object.entries(operationDurations)
      .map(([name, durations]) => ({
        name,
        avgDuration: durations.reduce((sum, d) => sum + d, 0) / durations.length,
        count: durations.length
      }))
      .sort((a, b) => b.avgDuration - a.avgDuration)
      .slice(0, 10);

    return {
      avgResponseTime,
      operationCounts,
      errorRates,
      topSlowOperations
    };
  }

  /**
   * Configure alerts for specific conditions
   */
  configureAlert(name: string, config: AlertConfig): void {
    this.alertConfigs.set(name, config);
    baseLogger.info(`Alert configured: ${name}`, { config });
  }

  /**
   * Get current logging statistics
   */
  getLoggingStats(): {
    totalMetrics: number;
    recentMetrics: number;
    alertConfigs: number;
    activeAlerts: number;
  } {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const recentMetrics = this.performanceMetrics.filter(m => m.timestamp > oneHourAgo).length;
    const activeAlerts = Array.from(this.alertCounts.values())
      .filter(alert => alert.resetTime > Date.now()).length;

    return {
      totalMetrics: this.performanceMetrics.length,
      recentMetrics,
      alertConfigs: this.alertConfigs.size,
      activeAlerts
    };
  }

  // Private methods

  private log(level: 'info' | 'warn' | 'error', message: string, context?: LogContext): void {
    const enrichedContext = {
      ...this.getCurrentContext(),
      ...context,
      timestamp: new Date().toISOString()
    };

    // Use base logger with enriched context
    baseLogger[level](message, enrichedContext);
  }

  private getCurrentContext(): LogContext {
    return this.contextStack.length > 0 ? 
      this.contextStack[this.contextStack.length - 1] : {};
  }

  private pushContext(context: LogContext): void {
    this.contextStack.push(context);
  }

  private popContext(): void {
    this.contextStack.pop();
  }

  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private checkAlerts(level: 'warn' | 'error' | 'critical', message: string, context?: LogContext): void {
    for (const [name, config] of this.alertConfigs) {
      if (this.shouldTriggerAlert(config, level, context)) {
        this.triggerAlert(name, config, level, message, context);
      }
    }
  }

  private shouldTriggerAlert(config: AlertConfig, level: string, context?: LogContext): boolean {
    // Check severity level
    if (config.conditions?.minSeverity) {
      const severityLevels = { 'warn': 1, 'error': 2, 'critical': 3 };
      const configSeverity = { 'low': 1, 'medium': 1, 'high': 2, 'critical': 3 };
      
      if (severityLevels[level as keyof typeof severityLevels] < 
          configSeverity[config.conditions.minSeverity]) {
        return false;
      }
    }

    // Check component filter
    if (config.conditions?.component && context?.component) {
      if (!config.conditions.component.includes(context.component)) {
        return false;
      }
    }

    // Check operation filter
    if (config.conditions?.operation && context?.operation) {
      if (!config.conditions.operation.includes(context.operation)) {
        return false;
      }
    }

    // Check rate limiting
    if (config.rateLimit) {
      const now = Date.now();
      const alertKey = `${config.level}_${config.conditions?.component || 'all'}`;
      const alertCount = this.alertCounts.get(alertKey);
      
      if (!alertCount || now >= alertCount.resetTime) {
        this.alertCounts.set(alertKey, {
          count: 1,
          resetTime: now + config.rateLimit.windowMs
        });
        return true;
      } else if (alertCount.count < config.rateLimit.maxAlerts) {
        alertCount.count++;
        return true;
      } else {
        return false; // Rate limited
      }
    }

    return true;
  }

  private triggerAlert(
    name: string, 
    config: AlertConfig, 
    level: string, 
    message: string, 
    context?: LogContext
  ): void {
    const alertData = {
      name,
      level,
      message,
      context,
      timestamp: new Date().toISOString()
    };

    // Log the alert
    baseLogger.warn(`🚨 ALERT [${name}]: ${message}`, alertData);

    // TODO: Implement actual alert channels
    for (const channel of config.channels) {
      switch (channel) {
        case 'discord':
          this.sendDiscordAlert(alertData);
          break;
        case 'database':
          this.saveAlertToDatabase(alertData);
          break;
        case 'file':
          this.saveAlertToFile(alertData);
          break;
        case 'console':
          // Already logged above
          break;
      }
    }
  }

  private async sendDiscordAlert(alertData: any): Promise<void> {
    if (!this.discordWebhookUrl) {
      baseLogger.debug('Discord webhook not configured, skipping Discord alert');
      return;
    }

    try {
      const embed = {
        title: `🚨 System Alert: ${alertData.name}`,
        description: alertData.message,
        color: this.getAlertColor(alertData.level),
        fields: [
          {
            name: 'Level',
            value: alertData.level.toUpperCase(),
            inline: true
          },
          {
            name: 'Timestamp',
            value: alertData.timestamp,
            inline: true
          }
        ],
        footer: {
          text: 'System Alert'
        }
      };

      // Add context fields if available
      if (alertData.context) {
        if (alertData.context.component) {
          embed.fields.push({
            name: 'Component',
            value: alertData.context.component,
            inline: true
          });
        }
        if (alertData.context.operation) {
          embed.fields.push({
            name: 'Operation',
            value: alertData.context.operation,
            inline: true
          });
        }
        if (alertData.context.metadata) {
          embed.fields.push({
            name: 'Details',
            value: JSON.stringify(alertData.context.metadata, null, 2).substring(0, 1024),
            inline: false
          });
        }
      }

      await fetch(this.discordWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed] })
      });

      baseLogger.debug('Discord alert sent successfully');
    } catch (error) {
      baseLogger.error('Failed to send Discord alert:', error);
    }
  }

  private async saveAlertToDatabase(alertData: any): Promise<void> {
    if (!this.database) {
      baseLogger.debug('Database not configured, skipping database alert storage');
      return;
    }

    try {
      // Save to system_alerts table
      await this.database.query(`
        INSERT INTO system_alerts (
          name, level, message, component, operation, context, timestamp, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `, [
        alertData.name,
        alertData.level,
        alertData.message,
        alertData.context?.component || null,
        alertData.context?.operation || null,
        JSON.stringify(alertData.context || {}),
        alertData.timestamp
      ]);

      baseLogger.debug('Alert saved to database successfully');
    } catch (error) {
      baseLogger.error('Failed to save alert to database:', error);
    }
  }

  private async saveAlertToFile(alertData: any): Promise<void> {
    try {
      // Ensure logs directory exists
      const logsDir = path.dirname(this.alertsFilePath);
      await fs.mkdir(logsDir, { recursive: true });

      // Format alert as JSON line
      const alertLine = JSON.stringify(alertData) + '\n';

      // Append to file
      await fs.appendFile(this.alertsFilePath, alertLine, 'utf8');

      baseLogger.debug('Alert saved to file successfully');

      // Rotate file if it gets too large (>10MB)
      const stats = await fs.stat(this.alertsFilePath);
      if (stats.size > 10 * 1024 * 1024) {
        await this.rotateAlertFile();
      }
    } catch (error) {
      baseLogger.error('Failed to save alert to file:', error);
    }
  }

  /**
   * Rotate alert log file when it gets too large
   */
  private async rotateAlertFile(): Promise<void> {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const rotatedPath = this.alertsFilePath.replace('.log', `.${timestamp}.log`);

      await fs.rename(this.alertsFilePath, rotatedPath);
      baseLogger.info(`Alert log file rotated to: ${rotatedPath}`);

      // Keep only last 10 rotated files
      const logsDir = path.dirname(this.alertsFilePath);
      const files = await fs.readdir(logsDir);
      const alertLogFiles = files
        .filter(f => f.startsWith('alerts.') && f.endsWith('.log'))
        .map(f => ({ name: f, path: path.join(logsDir, f) }))
        .sort((a, b) => b.name.localeCompare(a.name));

      // Delete old files beyond the limit
      for (let i = 10; i < alertLogFiles.length; i++) {
        await fs.unlink(alertLogFiles[i].path);
        baseLogger.debug(`Deleted old alert log: ${alertLogFiles[i].name}`);
      }
    } catch (error) {
      baseLogger.error('Failed to rotate alert file:', error);
    }
  }

  /**
   * Get Discord embed color for alert level
   */
  private getAlertColor(level: string): number {
    const colors = {
      warn: 0xFFAA00,      // Yellow
      error: 0xFF6600,     // Orange
      critical: 0xFF0000   // Red
    };
    return colors[level as keyof typeof colors] || 0x888888;
  }

  private setupDefaultAlertConfigs(): void {
    // Critical errors - Keep Discord for truly critical issues
    this.configureAlert('critical_errors', {
      level: 'critical',
      channels: ['console', 'database'],  // Removed discord - too noisy
      rateLimit: { maxAlerts: 5, windowMs: 5 * 60 * 1000 },
      conditions: { minSeverity: 'critical' }
    });

    // High error rates - Only for market analysis errors
    this.configureAlert('high_error_rate', {
      level: 'error',
      channels: ['console', 'database'],  // Removed discord
      rateLimit: { maxAlerts: 3, windowMs: 10 * 60 * 1000 },
      conditions: { minSeverity: 'high', operation: ['market_analysis', 'signal_detection'] }
    });

    // Performance issues
    this.configureAlert('performance_issues', {
      level: 'warn',
      channels: ['console', 'database'],
      rateLimit: { maxAlerts: 10, windowMs: 15 * 60 * 1000 },
      conditions: { minSeverity: 'medium', component: ['performance'] }
    });
  }

  private cleanupOldMetrics(): void {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const beforeCount = this.performanceMetrics.length;
    
    this.performanceMetrics = this.performanceMetrics.filter(
      metric => metric.timestamp > oneHourAgo
    );
    
    const removed = beforeCount - this.performanceMetrics.length;
    if (removed > 0) {
      baseLogger.debug(`Cleaned up ${removed} old performance metrics`);
    }
  }
}

// Singleton instance
export const advancedLogger = new AdvancedLogger();

// Export logger for backward compatibility
export const logger = baseLogger;