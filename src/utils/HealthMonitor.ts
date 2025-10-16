import { errorHandler } from './ErrorHandler';
import { logger } from './logger';

export interface SystemHealth {
  overall: 'healthy' | 'degraded' | 'critical';
  score: number; // 0-100
  components: ComponentHealth[];
  uptime: number;
  lastCheck: number;
  alerts: HealthAlert[];
}

export interface ComponentHealth {
  name: string;
  status: 'healthy' | 'degraded' | 'critical' | 'unknown';
  score: number;
  metrics: Record<string, any>;
  lastCheck: number;
  errorRate: number;
  responseTime: number;
}

export interface HealthAlert {
  id: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  component: string;
  message: string;
  timestamp: number;
  acknowledged: boolean;
}

export interface HealthCheck {
  name: string;
  check: () => Promise<{ healthy: boolean; metrics?: Record<string, any>; responseTime?: number }>;
  interval: number; // milliseconds
  timeout: number; // milliseconds
  critical: boolean; // whether failure affects overall health
}

export class HealthMonitor {
  private healthChecks: Map<string, HealthCheck> = new Map();
  private componentStates: Map<string, ComponentHealth> = new Map();
  private alerts: HealthAlert[] = [];
  private checkIntervals: Map<string, NodeJS.Timeout> = new Map();
  private startTime: number = Date.now();
  private isRunning: boolean = false;

  constructor() {
    logger.info('Health monitor initialized');
  }

  /**
   * Register a health check for a component
   */
  registerHealthCheck(healthCheck: HealthCheck): void {
    this.healthChecks.set(healthCheck.name, healthCheck);
    
    // Initialize component state
    this.componentStates.set(healthCheck.name, {
      name: healthCheck.name,
      status: 'unknown',
      score: 0,
      metrics: {},
      lastCheck: 0,
      errorRate: 0,
      responseTime: 0
    });

    logger.info(`Health check registered for component: ${healthCheck.name}`);
    
    // Start monitoring if already running
    if (this.isRunning) {
      this.startHealthCheck(healthCheck);
    }
  }

  /**
   * Start monitoring all registered health checks
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('Health monitor is already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting health monitoring...');

    for (const healthCheck of this.healthChecks.values()) {
      this.startHealthCheck(healthCheck);
    }

    // Run initial health checks immediately
    this.runAllHealthChecks();
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    logger.info('Stopping health monitoring...');

    // Clear all intervals
    for (const interval of this.checkIntervals.values()) {
      clearInterval(interval);
    }
    this.checkIntervals.clear();
  }

  /**
   * Get current system health status
   */
  getSystemHealth(): SystemHealth {
    const components = Array.from(this.componentStates.values());
    const uptime = Date.now() - this.startTime;
    
    // Calculate overall health score
    let totalScore = 0;
    let criticalComponents = 0;
    let healthyComponents = 0;

    for (const component of components) {
      totalScore += component.score;
      
      if (component.status === 'critical') {
        criticalComponents++;
      } else if (component.status === 'healthy') {
        healthyComponents++;
      }
    }

    const avgScore = components.length > 0 ? totalScore / components.length : 100;
    
    // Determine overall status
    let overall: 'healthy' | 'degraded' | 'critical' = 'healthy';
    if (criticalComponents > 0 || avgScore < 50) {
      overall = 'critical';
    } else if (avgScore < 80 || components.some(c => c.status === 'degraded')) {
      overall = 'degraded';
    }

    return {
      overall,
      score: Math.round(avgScore),
      components,
      uptime,
      lastCheck: Date.now(),
      alerts: this.getActiveAlerts()
    };
  }

  /**
   * Get health status for a specific component
   */
  getComponentHealth(componentName: string): ComponentHealth | null {
    return this.componentStates.get(componentName) || null;
  }

  /**
   * Manual health check for a specific component
   */
  async checkComponentHealth(componentName: string): Promise<ComponentHealth | null> {
    const healthCheck = this.healthChecks.get(componentName);
    if (!healthCheck) {
      logger.warn(`No health check registered for component: ${componentName}`);
      return null;
    }

    return await this.executeHealthCheck(healthCheck);
  }

  /**
   * Get active alerts
   */
  getActiveAlerts(): HealthAlert[] {
    return this.alerts.filter(alert => !alert.acknowledged);
  }

  /**
   * Acknowledge an alert
   */
  acknowledgeAlert(alertId: string): boolean {
    const alert = this.alerts.find(a => a.id === alertId);
    if (alert) {
      alert.acknowledged = true;
      logger.info(`Alert acknowledged: ${alertId}`);
      return true;
    }
    return false;
  }

  /**
   * Clear old alerts
   */
  clearOldAlerts(maxAgeMs: number = 24 * 60 * 60 * 1000): void {
    const cutoff = Date.now() - maxAgeMs;
    const initialCount = this.alerts.length;
    
    this.alerts = this.alerts.filter(alert => alert.timestamp > cutoff);
    
    const removedCount = initialCount - this.alerts.length;
    if (removedCount > 0) {
      logger.info(`Cleared ${removedCount} old alerts`);
    }
  }

  /**
   * Register standard health checks for common components
   */
  registerStandardHealthChecks(): void {
    // Memory usage health check
    this.registerHealthCheck({
      name: 'memory',
      check: async () => {
        const memUsage = process.memoryUsage();
        const totalMem = require('os').totalmem();
        const freeMem = require('os').freemem();
        const usedPercent = ((totalMem - freeMem) / totalMem) * 100;
        
        return {
          healthy: usedPercent < 90,
          metrics: {
            heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
            heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
            rss: Math.round(memUsage.rss / 1024 / 1024),
            external: Math.round(memUsage.external / 1024 / 1024),
            systemUsedPercent: Math.round(usedPercent * 100) / 100
          }
        };
      },
      interval: 30000, // 30 seconds
      timeout: 5000,
      critical: true
    });

    // CPU usage health check
    this.registerHealthCheck({
      name: 'cpu',
      check: async () => {
        const cpus = require('os').cpus();
        const loadAvg = require('os').loadavg();
        const cpuCount = cpus.length;
        const avgLoad = loadAvg[0]; // 1-minute load average
        const loadPercent = (avgLoad / cpuCount) * 100;
        
        return {
          healthy: loadPercent < 80,
          metrics: {
            cores: cpuCount,
            loadAverage1m: Math.round(loadAvg[0] * 100) / 100,
            loadAverage5m: Math.round(loadAvg[1] * 100) / 100,
            loadAverage15m: Math.round(loadAvg[2] * 100) / 100,
            loadPercent: Math.round(loadPercent * 100) / 100
          }
        };
      },
      interval: 30000,
      timeout: 5000,
      critical: false
    });

    // Event loop lag health check
    this.registerHealthCheck({
      name: 'eventloop',
      check: async () => {
        const start = process.hrtime.bigint();
        await new Promise(resolve => setImmediate(resolve));
        const lag = Number(process.hrtime.bigint() - start) / 1e6; // Convert to milliseconds
        
        return {
          healthy: lag < 100, // Less than 100ms lag is healthy
          metrics: {
            lagMs: Math.round(lag * 100) / 100
          },
          responseTime: lag
        };
      },
      interval: 15000,
      timeout: 1000,
      critical: true
    });

    // Error rate health check
    this.registerHealthCheck({
      name: 'errors',
      check: async () => {
        const errorStats = errorHandler.getErrorStatistics();
        const recentErrorRate = errorStats.recentErrorRate;
        const totalErrors = errorStats.totalErrors;
        
        return {
          healthy: recentErrorRate < 10, // Less than 10 errors per hour
          metrics: {
            totalErrors,
            recentErrorRate,
            errorsByType: Object.fromEntries(errorStats.errorsByType),
            circuitBreakers: Object.fromEntries(
              Array.from(errorStats.circuitBreakerStates.entries())
                .map(([key, state]) => [key, state.state])
            )
          }
        };
      },
      interval: 60000, // 1 minute
      timeout: 5000,
      critical: false
    });

    logger.info('Standard health checks registered');
  }

  // Private methods

  private startHealthCheck(healthCheck: HealthCheck): void {
    // Clear existing interval if any
    const existingInterval = this.checkIntervals.get(healthCheck.name);
    if (existingInterval) {
      clearInterval(existingInterval);
    }

    // Start new interval
    const interval = setInterval(async () => {
      await this.executeHealthCheck(healthCheck);
    }, healthCheck.interval);

    this.checkIntervals.set(healthCheck.name, interval);
  }

  private async executeHealthCheck(healthCheck: HealthCheck): Promise<ComponentHealth> {
    const componentState = this.componentStates.get(healthCheck.name)!;
    const startTime = Date.now();

    try {
      // Execute health check with timeout
      const result = await Promise.race([
        healthCheck.check(),
        this.timeoutPromise(healthCheck.timeout)
      ]);

      const responseTime = Date.now() - startTime;
      const score = this.calculateHealthScore(result.healthy, responseTime, componentState.errorRate);

      // Update component state
      componentState.status = this.determineStatus(result.healthy, score);
      componentState.score = score;
      componentState.metrics = result.metrics || {};
      componentState.lastCheck = Date.now();
      componentState.responseTime = result.responseTime || responseTime;
      componentState.errorRate = Math.max(0, componentState.errorRate - 1); // Decay error rate

      // Clear any existing alerts for this component if it's now healthy
      if (result.healthy) {
        this.clearAlertsForComponent(healthCheck.name);
      }

      logger.debug(`Health check passed for ${healthCheck.name}: score=${score}, responseTime=${responseTime}ms`);

    } catch (error) {
      // Health check failed
      componentState.status = 'critical';
      componentState.score = 0;
      componentState.lastCheck = Date.now();
      componentState.errorRate = Math.min(100, componentState.errorRate + 10);
      componentState.responseTime = Date.now() - startTime;

      logger.error(`Health check failed for ${healthCheck.name}:`, error);

      // Create alert
      this.createAlert(
        healthCheck.critical ? 'critical' : 'high',
        healthCheck.name,
        `Health check failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }

    return componentState;
  }

  private async runAllHealthChecks(): Promise<void> {
    logger.info('Running initial health checks...');
    
    const promises = Array.from(this.healthChecks.values()).map(healthCheck =>
      this.executeHealthCheck(healthCheck).catch(error => {
        logger.error(`Initial health check failed for ${healthCheck.name}:`, error);
      })
    );

    await Promise.allSettled(promises);
    logger.info('Initial health checks completed');
  }

  private timeoutPromise(timeoutMs: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Health check timeout after ${timeoutMs}ms`)), timeoutMs);
    });
  }

  private calculateHealthScore(healthy: boolean, responseTime: number, errorRate: number): number {
    if (!healthy) return 0;

    let score = 100;

    // Penalize slow response times
    if (responseTime > 1000) score -= 30;
    else if (responseTime > 500) score -= 15;
    else if (responseTime > 200) score -= 5;

    // Penalize high error rates
    score -= Math.min(errorRate, 50);

    return Math.max(0, Math.min(100, score));
  }

  private determineStatus(healthy: boolean, score: number): 'healthy' | 'degraded' | 'critical' {
    if (!healthy || score < 30) return 'critical';
    if (score < 70) return 'degraded';
    return 'healthy';
  }

  private createAlert(
    severity: 'low' | 'medium' | 'high' | 'critical',
    component: string,
    message: string
  ): void {
    const alert: HealthAlert = {
      id: `${component}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      severity,
      component,
      message,
      timestamp: Date.now(),
      acknowledged: false
    };

    this.alerts.push(alert);

    // Log alert
    const logLevel = severity === 'critical' ? 'error' : severity === 'high' ? 'warn' : 'info';
    logger[logLevel](`Health Alert [${severity.toUpperCase()}] ${component}: ${message}`);

    // Keep only last 100 alerts
    if (this.alerts.length > 100) {
      this.alerts = this.alerts.slice(-100);
    }
  }

  private clearAlertsForComponent(componentName: string): void {
    const beforeCount = this.alerts.length;
    this.alerts = this.alerts.filter(alert => 
      alert.component !== componentName || alert.acknowledged
    );
    
    const clearedCount = beforeCount - this.alerts.length;
    if (clearedCount > 0) {
      logger.debug(`Cleared ${clearedCount} alerts for component: ${componentName}`);
    }
  }
}

// Singleton instance
export const healthMonitor = new HealthMonitor();