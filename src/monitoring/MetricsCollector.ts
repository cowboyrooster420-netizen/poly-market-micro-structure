import { advancedLogger } from '../utils/AdvancedLogger';
import { healthMonitor } from '../utils/HealthMonitor';
import { errorHandler } from '../utils/ErrorHandler';
import { logger } from '../utils/logger';

export interface SystemMetrics {
  timestamp: number;
  system: {
    cpu: {
      usage: number;
      loadAverage: number[];
    };
    memory: {
      used: number;
      total: number;
      percentage: number;
      heapUsed: number;
      heapTotal: number;
    };
    eventLoop: {
      lag: number;
    };
  };
  application: {
    uptime: number;
    healthScore: number;
    errorRate: number;
    requestRate: number;
    responseTime: number;
  };
  business: {
    marketsTracked: number;
    signalsGenerated: number;
    anomaliesDetected: number;
    alertsSent: number;
  };
}

export interface MetricThreshold {
  metric: string;
  warning: number;
  critical: number;
  unit: string;
  inverted?: boolean; // For metrics where lower values are worse (e.g., health score)
}

export class MetricsCollector {
  private metrics: SystemMetrics[] = [];
  private isCollecting = false;
  private collectionInterval?: NodeJS.Timeout;
  private readonly maxMetricsToKeep = 1440; // 24 hours worth at 1-minute intervals
  
  // Performance counters
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  private histograms = new Map<string, number[]>();
  
  // Thresholds for alerting
  private thresholds: MetricThreshold[] = [
    { metric: 'cpu.usage', warning: 80, critical: 95, unit: '%' },
    { metric: 'memory.percentage', warning: 85, critical: 95, unit: '%' },
    { metric: 'eventLoop.lag', warning: 200, critical: 1000, unit: 'ms' },
    { metric: 'application.errorRate', warning: 10, critical: 20, unit: 'errors/min' },
    { metric: 'application.responseTime', warning: 6000, critical: 10000, unit: 'ms' },  // Increased to reduce noise
    { metric: 'application.healthScore', warning: 40, critical: 20, unit: 'score', inverted: true }  // Lowered warning threshold
  ];

  constructor() {
    logger.info('Metrics collector initialized');
  }

  /**
   * Start collecting metrics at regular intervals
   */
  start(intervalMs: number = 60000): void {
    if (this.isCollecting) {
      logger.warn('Metrics collection is already running');
      return;
    }

    this.isCollecting = true;
    logger.info(`Starting metrics collection with ${intervalMs}ms interval`);

    // Collect initial metrics
    this.collectMetrics();

    // Set up periodic collection
    this.collectionInterval = setInterval(() => {
      this.collectMetrics();
    }, intervalMs);
  }

  /**
   * Stop collecting metrics
   */
  stop(): void {
    if (!this.isCollecting) {
      return;
    }

    this.isCollecting = false;
    
    if (this.collectionInterval) {
      clearInterval(this.collectionInterval);
      this.collectionInterval = undefined;
    }

    logger.info('Metrics collection stopped');
  }

  /**
   * Increment a counter metric
   */
  incrementCounter(name: string, value: number = 1, tags?: Record<string, string>): void {
    const key = this.createMetricKey(name, tags);
    this.counters.set(key, (this.counters.get(key) || 0) + value);
    
    advancedLogger.recordMetric({
      name,
      value: this.counters.get(key)!,
      unit: 'count',
      timestamp: Date.now(),
      tags
    });
  }

  /**
   * Set a gauge metric
   */
  setGauge(name: string, value: number, tags?: Record<string, string>): void {
    const key = this.createMetricKey(name, tags);
    this.gauges.set(key, value);
    
    advancedLogger.recordMetric({
      name,
      value,
      unit: this.getMetricUnit(name),
      timestamp: Date.now(),
      tags
    });
  }

  /**
   * Record a histogram value (for response times, etc.)
   */
  recordHistogram(name: string, value: number, tags?: Record<string, string>): void {
    const key = this.createMetricKey(name, tags);
    if (!this.histograms.has(key)) {
      this.histograms.set(key, []);
    }
    
    const values = this.histograms.get(key)!;
    values.push(value);
    
    // Keep only last 1000 values
    if (values.length > 1000) {
      values.shift();
    }
    
    advancedLogger.recordMetric({
      name,
      value,
      unit: this.getMetricUnit(name),
      timestamp: Date.now(),
      tags
    });
  }

  /**
   * Record signal detection metrics
   */
  recordSignalMetrics(signalType: string, confidence: number, marketId: string): void {
    this.incrementCounter('signals.generated', 1, { signalType });
    this.setGauge('signals.last_confidence', confidence, { signalType });
    this.recordHistogram('signals.confidence_distribution', confidence, { signalType });
    
    if (confidence > 0.8) {
      this.incrementCounter('signals.high_confidence', 1, { signalType });
    }
    
    if (signalType.includes('anomaly') || signalType.includes('leak')) {
      this.incrementCounter('anomalies.detected', 1, { signalType });
    }
  }

  /**
   * Record market analysis metrics
   */
  recordMarketMetrics(marketCount: number, processTimeMs: number): void {
    this.setGauge('markets.tracked_count', marketCount);
    this.recordHistogram('markets.processing_time', processTimeMs);
    this.incrementCounter('markets.analysis_cycles', 1);
  }

  /**
   * Record WebSocket metrics
   */
  recordWebSocketMetrics(connected: boolean, messageCount: number, latencyMs?: number): void {
    this.setGauge('websocket.connected', connected ? 1 : 0);
    this.incrementCounter('websocket.messages_received', messageCount);
    
    if (latencyMs !== undefined) {
      this.recordHistogram('websocket.latency', latencyMs);
    }
  }

  /**
   * Record database operation metrics
   */
  recordDatabaseMetrics(operation: string, durationMs: number, success: boolean): void {
    this.recordHistogram('database.operation_duration', durationMs, { operation });
    this.incrementCounter('database.operations', 1, { operation, status: success ? 'success' : 'error' });
    
    if (!success) {
      this.incrementCounter('database.errors', 1, { operation });
    }
  }

  /**
   * Get current metrics snapshot
   */
  getCurrentMetrics(): SystemMetrics | null {
    if (this.metrics.length === 0) {
      return null;
    }
    return this.metrics[this.metrics.length - 1];
  }

  /**
   * Get metrics history
   */
  getMetricsHistory(hoursBack: number = 1): SystemMetrics[] {
    const cutoff = Date.now() - (hoursBack * 60 * 60 * 1000);
    return this.metrics.filter(m => m.timestamp > cutoff);
  }

  /**
   * Get aggregated statistics
   */
  getAggregatedStats(hoursBack: number = 1): {
    averages: Record<string, number>;
    maximums: Record<string, number>;
    minimums: Record<string, number>;
    trends: Record<string, 'up' | 'down' | 'stable'>;
  } {
    const history = this.getMetricsHistory(hoursBack);
    if (history.length < 2) {
      return { averages: {}, maximums: {}, minimums: {}, trends: {} };
    }

    const averages: Record<string, number> = {};
    const maximums: Record<string, number> = {};
    const minimums: Record<string, number> = {};
    const trends: Record<string, 'up' | 'down' | 'stable'> = {};

    // Calculate for key metrics
    const keyMetrics = [
      'system.cpu.usage',
      'system.memory.percentage',
      'system.eventLoop.lag',
      'application.healthScore',
      'application.errorRate',
      'application.responseTime'
    ];

    for (const metric of keyMetrics) {
      const values = history.map(h => this.getNestedValue(h, metric)).filter(v => v !== undefined);
      
      if (values.length > 0) {
        averages[metric] = values.reduce((sum, val) => sum + val, 0) / values.length;
        maximums[metric] = Math.max(...values);
        minimums[metric] = Math.min(...values);
        
        // Calculate trend (compare first quarter vs last quarter)
        const quarterSize = Math.floor(values.length / 4);
        if (quarterSize > 0) {
          const firstQuarter = values.slice(0, quarterSize);
          const lastQuarter = values.slice(-quarterSize);
          
          const firstAvg = firstQuarter.reduce((sum, val) => sum + val, 0) / firstQuarter.length;
          const lastAvg = lastQuarter.reduce((sum, val) => sum + val, 0) / lastQuarter.length;
          
          const change = ((lastAvg - firstAvg) / firstAvg) * 100;
          
          if (Math.abs(change) < 5) {
            trends[metric] = 'stable';
          } else if (change > 0) {
            trends[metric] = 'up';
          } else {
            trends[metric] = 'down';
          }
        }
      }
    }

    return { averages, maximums, minimums, trends };
  }

  /**
   * Get performance summary
   */
  getPerformanceSummary(): {
    status: 'healthy' | 'warning' | 'critical';
    issues: string[];
    recommendations: string[];
    keyMetrics: Record<string, { value: number; threshold: string; status: 'ok' | 'warning' | 'critical' }>;
  } {
    const current = this.getCurrentMetrics();
    if (!current) {
      return {
        status: 'warning',
        issues: ['No metrics available'],
        recommendations: ['Start metrics collection'],
        keyMetrics: {}
      };
    }

    const issues: string[] = [];
    const recommendations: string[] = [];
    const keyMetrics: Record<string, any> = {};
    let overallStatus: 'healthy' | 'warning' | 'critical' = 'healthy';

    // Check each threshold
    for (const threshold of this.thresholds) {
      const value = this.getNestedValue(current, threshold.metric);
      if (value !== undefined) {
        let status: 'ok' | 'warning' | 'critical' = 'ok';
        let thresholdText: string;
        let isCritical = false;
        let isWarning = false;

        if (threshold.inverted) {
          // For inverted metrics (lower is worse)
          thresholdText = `> ${threshold.warning}${threshold.unit}`;
          isCritical = value <= threshold.critical;
          isWarning = value <= threshold.warning && !isCritical;
        } else {
          // For normal metrics (higher is worse)
          thresholdText = `< ${threshold.warning}${threshold.unit}`;
          isCritical = value >= threshold.critical;
          isWarning = value >= threshold.warning && !isCritical;
        }

        if (isCritical) {
          status = 'critical';
          thresholdText = threshold.inverted
            ? `<= ${threshold.critical}${threshold.unit}`
            : `>= ${threshold.critical}${threshold.unit}`;
          overallStatus = 'critical';
          issues.push(`Critical: ${threshold.metric} is ${value}${threshold.unit}`);
          recommendations.push(`Immediate attention required for ${threshold.metric}`);
        } else if (isWarning) {
          status = 'warning';
          thresholdText = threshold.inverted
            ? `<= ${threshold.warning}${threshold.unit}`
            : `>= ${threshold.warning}${threshold.unit}`;
          if (overallStatus !== 'critical') overallStatus = 'warning';
          issues.push(`Warning: ${threshold.metric} is ${value}${threshold.unit}`);
          recommendations.push(`Monitor ${threshold.metric} closely`);
        }

        keyMetrics[threshold.metric] = {
          value,
          threshold: thresholdText,
          status
        };
      }
    }

    // Add general recommendations
    if (issues.length === 0) {
      recommendations.push('System is performing well');
    } else {
      recommendations.push('Check logs for detailed error information');
      recommendations.push('Consider scaling resources if issues persist');
    }

    return {
      status: overallStatus,
      issues,
      recommendations,
      keyMetrics
    };
  }

  // Private methods

  private async collectMetrics(): Promise<void> {
    try {
      const timestamp = Date.now();
      
      // System metrics
      const cpuUsage = process.cpuUsage();
      const memUsage = process.memoryUsage();
      const os = require('os');
      
      // Application metrics
      const systemHealth = healthMonitor.getSystemHealth();
      const errorStats = errorHandler.getErrorStatistics();
      const performanceStats = advancedLogger.getPerformanceStats();

      // Event loop lag
      const eventLoopStart = process.hrtime.bigint();
      await new Promise(resolve => setImmediate(resolve));
      const eventLoopLag = Number(process.hrtime.bigint() - eventLoopStart) / 1e6;

      const metrics: SystemMetrics = {
        timestamp,
        system: {
          cpu: {
            usage: Math.min(100, (cpuUsage.user + cpuUsage.system) / 1000000 * 100),
            loadAverage: os.loadavg()
          },
          memory: {
            used: memUsage.rss,
            total: os.totalmem(),
            percentage: (memUsage.rss / os.totalmem()) * 100,
            heapUsed: memUsage.heapUsed,
            heapTotal: memUsage.heapTotal
          },
          eventLoop: {
            lag: eventLoopLag
          }
        },
        application: {
          uptime: systemHealth.uptime,
          healthScore: systemHealth.score,
          errorRate: errorStats.recentErrorRate,
          requestRate: this.calculateRequestRate(),
          responseTime: performanceStats.avgResponseTime
        },
        business: {
          marketsTracked: this.counters.get('markets.tracked_count') || 0,
          signalsGenerated: this.counters.get('signals.generated') || 0,
          anomaliesDetected: this.counters.get('anomalies.detected') || 0,
          alertsSent: this.counters.get('alerts.sent') || 0
        }
      };

      // Store metrics
      this.metrics.push(metrics);
      
      // Keep only recent metrics
      if (this.metrics.length > this.maxMetricsToKeep) {
        this.metrics = this.metrics.slice(-this.maxMetricsToKeep);
      }

      // Check thresholds and alert if necessary
      this.checkThresholds(metrics);

      advancedLogger.info('Metrics collected', {
        component: 'metrics_collector',
        operation: 'collect_metrics',
        metadata: {
          healthScore: metrics.application.healthScore,
          errorRate: metrics.application.errorRate,
          memoryUsage: metrics.system.memory.percentage.toFixed(1) + '%'
        }
      });

    } catch (error) {
      logger.error('Error collecting metrics:', error);
      errorHandler.handleError(error as Error, {
        component: 'metrics_collector',
        operation: 'collect_metrics'
      });
    }
  }

  private checkThresholds(metrics: SystemMetrics): void {
    for (const threshold of this.thresholds) {
      const value = this.getNestedValue(metrics, threshold.metric);
      if (value !== undefined) {
        let isCritical = false;
        let isWarning = false;

        if (threshold.inverted) {
          // For inverted metrics (lower is worse), check if value is below thresholds
          isCritical = value <= threshold.critical;
          isWarning = value <= threshold.warning && !isCritical;
        } else {
          // For normal metrics (higher is worse), check if value is above thresholds
          isCritical = value >= threshold.critical;
          isWarning = value >= threshold.warning && !isCritical;
        }

        if (isCritical) {
          advancedLogger.critical(
            `Critical threshold ${threshold.inverted ? 'below' : 'exceeded'}: ${threshold.metric} = ${value}${threshold.unit}`,
            undefined,
            {
              component: 'metrics_collector',
              operation: 'threshold_check',
              metadata: { threshold, value }
            }
          );
        } else if (isWarning) {
          advancedLogger.warn(
            `Warning threshold ${threshold.inverted ? 'below' : 'exceeded'}: ${threshold.metric} = ${value}${threshold.unit}`,
            {
              component: 'metrics_collector',
              operation: 'threshold_check',
              metadata: { threshold, value }
            }
          );
        }
      }
    }
  }

  private calculateRequestRate(): number {
    // Calculate requests per minute based on recent counter changes
    const oneMinuteAgo = Date.now() - 60000;
    const recentMetrics = this.metrics.filter(m => m.timestamp > oneMinuteAgo);
    
    if (recentMetrics.length < 2) return 0;
    
    const operations = this.counters.get('database.operations') || 0;
    return operations / Math.max(1, recentMetrics.length);
  }

  private createMetricKey(name: string, tags?: Record<string, string>): string {
    if (!tags) return name;
    const tagString = Object.entries(tags)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join(',');
    return `${name}{${tagString}}`;
  }

  private getMetricUnit(name: string): 'ms' | 'count' | 'bytes' | 'percent' | 'rate' {
    if (name.includes('time') || name.includes('latency') || name.includes('duration')) return 'ms';
    if (name.includes('count') || name.includes('total')) return 'count';
    if (name.includes('bytes') || name.includes('memory')) return 'bytes';
    if (name.includes('percentage') || name.includes('rate') || name.includes('usage')) return 'percent';
    return 'count';
  }

  private getNestedValue(obj: any, path: string): number | undefined {
    const keys = path.split('.');
    let current = obj;
    
    for (const key of keys) {
      if (current && typeof current === 'object' && key in current) {
        current = current[key];
      } else {
        return undefined;
      }
    }
    
    return typeof current === 'number' ? current : undefined;
  }

  // Performance monitoring methods for batch processing, connections, and workers
  recordBatchProcessing(operation: string, itemCount: number, processingTimeMs: number): void {
    this.incrementCounter(`batch_processing.${operation}.count`, 1);
    this.setGauge(`batch_processing.${operation}.items`, itemCount);
    this.setGauge(`batch_processing.${operation}.duration_ms`, processingTimeMs);
    this.setGauge(`batch_processing.${operation}.items_per_second`, itemCount / (processingTimeMs / 1000));
  }

  recordConnectionEvent(event: 'acquired' | 'released' | 'created' | 'destroyed', poolSize: number): void {
    this.incrementCounter(`connection_pool.${event}`, 1);
    this.setGauge('connection_pool.size', poolSize);
  }

  recordQueueOverflow(queueName: string, droppedItems: number): void {
    this.incrementCounter(`queue.${queueName}.overflow`, 1);
    this.incrementCounter(`queue.${queueName}.dropped_items`, droppedItems);
  }

  recordPoolExhaustion(poolType: string, waitTimeMs: number): void {
    this.incrementCounter(`pool.${poolType}.exhaustion`, 1);
    this.setGauge(`pool.${poolType}.wait_time_ms`, waitTimeMs);
  }

  recordObjectAcquisition(poolType: string, acquisitionTimeMs: number): void {
    this.incrementCounter(`pool.${poolType}.acquisitions`, 1);
    this.setGauge(`pool.${poolType}.acquisition_time_ms`, acquisitionTimeMs);
  }

  recordObjectRelease(poolType: string, releaseTimeMs: number): void {
    this.incrementCounter(`pool.${poolType}.releases`, 1);
    this.setGauge(`pool.${poolType}.release_time_ms`, releaseTimeMs);
  }

  recordWorkerTaskCompletion(taskType: string, processingTimeMs: number, success: boolean): void {
    this.incrementCounter(`worker.${taskType}.completed`, 1);
    this.incrementCounter(`worker.${taskType}.${success ? 'success' : 'error'}`, 1);
    this.setGauge(`worker.${taskType}.processing_time_ms`, processingTimeMs);
  }

  recordTaskQueueOverflow(queueName: string, queueSize: number): void {
    this.incrementCounter(`worker.${queueName}.queue_overflow`, 1);
    this.setGauge(`worker.${queueName}.queue_size`, queueSize);
  }

  recordWorkerScaleEvent(event: 'scale_up' | 'scale_down', workerCount: number): void {
    this.incrementCounter(`worker.scaling.${event}`, 1);
    this.setGauge('worker.active_count', workerCount);
  }
}

// Singleton instance
export const metricsCollector = new MetricsCollector();