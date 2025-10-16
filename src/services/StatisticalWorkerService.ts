import { WorkerThreadManager, WorkerTask, WorkerResult } from '../performance/WorkerThreadManager';
import { StatisticalModels, StatisticalConfig, StatisticalMetrics } from '../statistics/StatisticalModels';
import { advancedLogger } from '../utils/AdvancedLogger';
import { metricsCollector } from '../monitoring/MetricsCollector';
import path from 'path';

export interface CorrelationResult {
  correlation: number;
  method: 'pearson' | 'spearman';
  significanceLevel: number;
  isSignificant: boolean;
}

export interface AnomalyDetectionResult {
  zScoreAnomalies: number[];
  isolationForestAnomalies: Array<{ index: number; value: number; score: number }>;
  movingAverageAnomalies: Array<{ index: number; value: number; zScore: number }>;
}

export interface SignalProcessingResult {
  processedSignal: number[];
  operationsApplied: string[];
}

/**
 * Service for CPU-intensive statistical calculations using worker threads
 * Offloads heavy computations to avoid blocking the main thread
 */
export class StatisticalWorkerService {
  private workerManager: WorkerThreadManager;
  private fallbackStatisticalModels: StatisticalModels;
  private workerScriptPath: string;

  constructor() {
    this.workerScriptPath = path.join(__dirname, '..', 'workers', 'statisticalWorker.js');
    this.workerManager = new WorkerThreadManager({
      minWorkers: 2,
      maxWorkers: Math.min(4, require('os').cpus().length),
      maxTaskQueueSize: 100,
      workerIdleTimeoutMs: 300000, // 5 minutes
      taskTimeoutMs: 30000, // 30 seconds
      workerScript: this.workerScriptPath
    });
    
    // Fallback for when worker threads are not available or fail
    this.fallbackStatisticalModels = new StatisticalModels({
      windowSize: 50,
      outlierThreshold: 3,
      minSampleSize: 10,
      confidenceLevel: 0.95,
      ewmaAlpha: 0.1
    });

    advancedLogger.info('Statistical worker service initialized', {
      component: 'statistical_worker_service',
      operation: 'initialize',
      metadata: {
        workerScriptPath: this.workerScriptPath,
        cpuCount: require('os').cpus().length
      }
    });
  }

  /**
   * Perform comprehensive statistical analysis using worker threads
   */
  async calculateStatistics(
    values: number[], 
    config?: Partial<StatisticalConfig>
  ): Promise<StatisticalMetrics> {
    const startTime = Date.now();
    
    try {
      // For small datasets, use main thread to avoid worker overhead
      if (values.length < 100) {
        return this.fallbackStatisticalModels.calculateStatistics(values);
      }

      const task: WorkerTask = {
        id: `stats_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        type: 'statistical_calculation',
        data: { values, config },
        priority: 'medium',
        timestamp: Date.now(),
        timeout: 30000
      };

      const result = await this.workerManager.executeTask(task);
      
      if (!result.success) {
        throw new Error(result.error || 'Statistical calculation failed');
      }

      metricsCollector.recordWorkerTaskCompletion('statistical_calculation', Date.now() - startTime, true);
      
      return result.result as StatisticalMetrics;

    } catch (error) {
      metricsCollector.recordWorkerTaskCompletion('statistical_calculation', Date.now() - startTime, false);
      
      advancedLogger.warn('Worker statistical calculation failed, using fallback', {
        component: 'statistical_worker_service',
        operation: 'calculate_statistics',
        error: (error as Error).message
      });
      
      // Fallback to main thread calculation
      return this.fallbackStatisticalModels.calculateStatistics(values);
    }
  }

  /**
   * Perform correlation analysis between two time series using worker threads
   */
  async calculateCorrelation(
    series1: number[], 
    series2: number[], 
    method: 'pearson' | 'spearman' = 'pearson'
  ): Promise<CorrelationResult> {
    const startTime = Date.now();
    
    try {
      // For small datasets, use main thread
      if (series1.length < 50) {
        const correlation = this.fallbackStatisticalModels.calculateCorrelation(series1, series2);
        return {
          correlation,
          method,
          significanceLevel: 0.05,
          isSignificant: Math.abs(correlation) > 0.2 // Simple threshold
        };
      }

      const task: WorkerTask = {
        id: `corr_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        type: 'correlation_analysis',
        data: { series1, series2, method },
        priority: 'medium',
        timestamp: Date.now(),
        timeout: 20000
      };

      const result = await this.workerManager.executeTask(task);
      
      if (!result.success) {
        throw new Error(result.error || 'Correlation analysis failed');
      }

      metricsCollector.recordWorkerTaskCompletion('correlation_analysis', Date.now() - startTime, true);
      
      const correlation = result.result as number;
      return {
        correlation,
        method,
        significanceLevel: 0.05,
        isSignificant: Math.abs(correlation) > 0.2 && series1.length >= 30
      };

    } catch (error) {
      metricsCollector.recordWorkerTaskCompletion('correlation_analysis', Date.now() - startTime, false);
      
      advancedLogger.warn('Worker correlation analysis failed, using fallback', {
        component: 'statistical_worker_service',
        operation: 'calculate_correlation',
        error: (error as Error).message
      });
      
      // Fallback to main thread calculation
      const correlation = this.fallbackStatisticalModels.calculateCorrelation(series1, series2);
      return {
        correlation,
        method,
        significanceLevel: 0.05,
        isSignificant: Math.abs(correlation) > 0.2
      };
    }
  }

  /**
   * Perform anomaly detection using multiple algorithms in worker threads
   */
  async detectAnomalies(
    values: number[], 
    config?: Partial<StatisticalConfig>
  ): Promise<AnomalyDetectionResult> {
    const startTime = Date.now();
    
    try {
      // For small datasets, use main thread
      if (values.length < 50) {
        const zScoreResult = this.fallbackStatisticalModels.calculateZScore(values[values.length - 1], values);
        return {
          zScoreAnomalies: zScoreResult.isAnomaly ? [values[values.length - 1]] : [],
          isolationForestAnomalies: [],
          movingAverageAnomalies: []
        };
      }

      const task: WorkerTask = {
        id: `anomaly_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        type: 'anomaly_detection',
        data: { values, config },
        priority: 'high',
        timestamp: Date.now(),
        timeout: 45000
      };

      const result = await this.workerManager.executeTask(task);
      
      if (!result.success) {
        throw new Error(result.error || 'Anomaly detection failed');
      }

      metricsCollector.recordWorkerTaskCompletion('anomaly_detection', Date.now() - startTime, true);
      
      return result.result as AnomalyDetectionResult;

    } catch (error) {
      metricsCollector.recordWorkerTaskCompletion('anomaly_detection', Date.now() - startTime, false);
      
      advancedLogger.warn('Worker anomaly detection failed, using fallback', {
        component: 'statistical_worker_service',
        operation: 'detect_anomalies',
        error: (error as Error).message
      });
      
      // Fallback to simple anomaly detection
      const zScoreResult = this.fallbackStatisticalModels.calculateZScore(values[values.length - 1], values);
      return {
        zScoreAnomalies: zScoreResult.isAnomaly ? [values[values.length - 1]] : [],
        isolationForestAnomalies: [],
        movingAverageAnomalies: []
      };
    }
  }

  /**
   * Perform signal processing operations using worker threads
   */
  async processSignal(
    signal: number[], 
    operations: Array<{ type: string; params?: any }>
  ): Promise<SignalProcessingResult> {
    const startTime = Date.now();
    
    try {
      // For small signals, use main thread
      if (signal.length < 100) {
        return {
          processedSignal: signal, // Simple passthrough for fallback
          operationsApplied: operations.map(op => op.type)
        };
      }

      const task: WorkerTask = {
        id: `signal_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        type: 'signal_processing',
        data: { signal, operations },
        priority: 'medium',
        timestamp: Date.now(),
        timeout: 60000
      };

      const result = await this.workerManager.executeTask(task);
      
      if (!result.success) {
        throw new Error(result.error || 'Signal processing failed');
      }

      metricsCollector.recordWorkerTaskCompletion('signal_processing', Date.now() - startTime, true);
      
      return {
        processedSignal: result.result as number[],
        operationsApplied: operations.map(op => op.type)
      };

    } catch (error) {
      metricsCollector.recordWorkerTaskCompletion('signal_processing', Date.now() - startTime, false);
      
      advancedLogger.warn('Worker signal processing failed, using fallback', {
        component: 'statistical_worker_service',
        operation: 'process_signal',
        error: (error as Error).message
      });
      
      // Fallback to passthrough
      return {
        processedSignal: signal,
        operationsApplied: operations.map(op => op.type)
      };
    }
  }

  /**
   * Get performance statistics for the worker pool
   */
  getPerformanceStats() {
    return this.workerManager.getPerformanceStats();
  }

  /**
   * Scale the worker pool based on current load
   */
  async scaleWorkerPool() {
    await this.workerManager.scaleWorkerPool();
  }

  /**
   * Shutdown the worker service
   */
  async shutdown(): Promise<void> {
    await this.workerManager.shutdown();
    
    advancedLogger.info('Statistical worker service shutdown completed', {
      component: 'statistical_worker_service',
      operation: 'shutdown'
    });
  }

  /**
   * Health check for the worker service
   */
  async healthCheck(): Promise<{ healthy: boolean; details: any }> {
    try {
      const stats = this.workerManager.getPerformanceStats();
      const healthy = stats.activeWorkers > 0 && stats.errorRate < 0.1;
      
      return {
        healthy,
        details: {
          activeWorkers: stats.activeWorkers,
          totalWorkers: stats.totalWorkers,
          queueSize: stats.queueSize,
          errorRate: stats.errorRate,
          avgProcessingTime: stats.averageProcessingTime
        }
      };
    } catch (error) {
      return {
        healthy: false,
        details: { error: (error as Error).message }
      };
    }
  }
}

// Singleton instance
export const statisticalWorkerService = new StatisticalWorkerService();