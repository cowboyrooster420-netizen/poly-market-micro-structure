import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { cpus } from 'os';
import { logger } from '../utils/AdvancedLogger';
import { MetricsCollector } from '../monitoring/MetricsCollector';

export interface WorkerTask {
  id: string;
  type: 'statistical_calculation' | 'signal_processing' | 'data_analysis' | 'correlation_analysis';
  data: any;
  priority: 'low' | 'medium' | 'high' | 'critical';
  timestamp: number;
  timeout?: number;
}

export interface WorkerResult {
  taskId: string;
  success: boolean;
  result?: any;
  error?: string;
  processingTimeMs: number;
  workerId: string;
}

export interface WorkerStats {
  id: string;
  isActive: boolean;
  tasksCompleted: number;
  totalProcessingTime: number;
  averageProcessingTime: number;
  errorCount: number;
  lastTaskCompletedAt?: number;
  memoryUsage: number;
}

export interface WorkerPoolConfig {
  maxWorkers: number;
  minWorkers: number;
  workerIdleTimeoutMs: number;
  taskTimeoutMs: number;
  queueMaxSize: number;
  autoScale: boolean;
  scaleUpThreshold: number;
  scaleDownThreshold: number;
}

/**
 * Worker thread manager for CPU-intensive calculations
 */
export class WorkerThreadManager {
  private workers: Map<string, Worker> = new Map();
  private workerStats: Map<string, WorkerStats> = new Map();
  private taskQueue: WorkerTask[] = [];
  private pendingTasks: Map<string, { resolve: Function; reject: Function; timeout?: NodeJS.Timeout }> = new Map();
  private config: WorkerPoolConfig;
  private metrics: MetricsCollector;
  private isShuttingDown: boolean = false;
  private workerIdCounter: number = 0;
  private scaleTimer?: NodeJS.Timeout;

  constructor(config: WorkerPoolConfig, metrics: MetricsCollector) {
    this.config = config;
    this.metrics = metrics;
    
    // Initialize minimum workers
    this.initializeWorkers();
    
    if (this.config.autoScale) {
      this.startAutoScaling();
    }
  }

  /**
   * Initialize minimum number of workers
   */
  private initializeWorkers(): void {
    for (let i = 0; i < this.config.minWorkers; i++) {
      this.createWorker();
    }
    
    logger.info('Worker thread pool initialized', {
      minWorkers: this.config.minWorkers,
      maxWorkers: this.config.maxWorkers,
      availableCPUs: cpus().length
    });
  }

  /**
   * Create a new worker thread
   */
  private createWorker(): string {
    const workerId = `worker_${++this.workerIdCounter}`;
    
    const worker = new Worker(__filename, {
      workerData: { isWorkerThread: true },
      transferList: []
    });

    this.workers.set(workerId, worker);
    this.workerStats.set(workerId, {
      id: workerId,
      isActive: false,
      tasksCompleted: 0,
      totalProcessingTime: 0,
      averageProcessingTime: 0,
      errorCount: 0,
      memoryUsage: 0
    });

    worker.on('message', (message: WorkerResult) => {
      this.handleWorkerMessage(workerId, message);
    });

    worker.on('error', (error) => {
      logger.error('Worker thread error', {
        workerId,
        error: error.message
      });
      
      this.handleWorkerError(workerId, error);
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        logger.error('Worker thread exited with error', {
          workerId,
          exitCode: code
        });
      }
      
      this.handleWorkerExit(workerId);
    });

    logger.debug('Worker thread created', { workerId });
    return workerId;
  }

  /**
   * Handle message from worker thread
   */
  private handleWorkerMessage(workerId: string, message: WorkerResult): void {
    const stats = this.workerStats.get(workerId);
    if (stats) {
      stats.isActive = false;
      stats.tasksCompleted++;
      stats.totalProcessingTime += message.processingTimeMs;
      stats.averageProcessingTime = stats.totalProcessingTime / stats.tasksCompleted;
      stats.lastTaskCompletedAt = Date.now();
      
      if (!message.success) {
        stats.errorCount++;
      }
    }

    const pendingTask = this.pendingTasks.get(message.taskId);
    if (pendingTask) {
      if (pendingTask.timeout) {
        clearTimeout(pendingTask.timeout);
      }
      
      this.pendingTasks.delete(message.taskId);
      
      if (message.success) {
        pendingTask.resolve(message.result);
      } else {
        pendingTask.reject(new Error(message.error || 'Worker task failed'));
      }
    }

    this.metrics.recordWorkerTaskCompletion(workerId, message.processingTimeMs, message.success);
    
    // Process next task if queue has items
    this.processNextTask();
  }

  /**
   * Handle worker error
   */
  private handleWorkerError(workerId: string, error: Error): void {
    const stats = this.workerStats.get(workerId);
    if (stats) {
      stats.errorCount++;
      stats.isActive = false;
    }

    // Restart worker if not shutting down
    if (!this.isShuttingDown) {
      this.restartWorker(workerId);
    }
  }

  /**
   * Handle worker exit
   */
  private handleWorkerExit(workerId: string): void {
    this.workers.delete(workerId);
    this.workerStats.delete(workerId);
    
    // Create replacement worker if below minimum and not shutting down
    if (!this.isShuttingDown && this.workers.size < this.config.minWorkers) {
      this.createWorker();
    }
  }

  /**
   * Restart a worker thread
   */
  private restartWorker(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.terminate();
    }
    
    // Create new worker
    const newWorkerId = this.createWorker();
    
    logger.info('Worker thread restarted', {
      oldWorkerId: workerId,
      newWorkerId
    });
  }

  /**
   * Submit task to worker pool
   */
  async submitTask(task: Omit<WorkerTask, 'id' | 'timestamp'>): Promise<any> {
    if (this.isShuttingDown) {
      throw new Error('Worker pool is shutting down');
    }

    const fullTask: WorkerTask = {
      ...task,
      id: `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now()
    };

    return new Promise((resolve, reject) => {
      // Set up timeout
      let timeout: NodeJS.Timeout | undefined;
      if (fullTask.timeout || this.config.taskTimeoutMs) {
        const timeoutMs = fullTask.timeout || this.config.taskTimeoutMs;
        timeout = setTimeout(() => {
          this.pendingTasks.delete(fullTask.id);
          reject(new Error(`Task timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      }

      this.pendingTasks.set(fullTask.id, { resolve, reject, timeout });

      // Add to queue based on priority
      this.addTaskToQueue(fullTask);
      
      // Try to process immediately
      this.processNextTask();
    });
  }

  /**
   * Add task to queue with priority ordering
   */
  private addTaskToQueue(task: WorkerTask): void {
    if (this.taskQueue.length >= this.config.queueMaxSize) {
      // Remove lowest priority task
      const lowestPriorityIndex = this.findLowestPriorityTaskIndex();
      const removedTask = this.taskQueue.splice(lowestPriorityIndex, 1)[0];
      
      const pendingTask = this.pendingTasks.get(removedTask.id);
      if (pendingTask) {
        if (pendingTask.timeout) {
          clearTimeout(pendingTask.timeout);
        }
        this.pendingTasks.delete(removedTask.id);
        pendingTask.reject(new Error('Task queue overflow'));
      }
      
      this.metrics.recordTaskQueueOverflow('worker_queue', this.taskQueue.length);
    }

    // Insert task based on priority
    const priorities = { 'critical': 4, 'high': 3, 'medium': 2, 'low': 1 };
    const taskPriority = priorities[task.priority];
    
    let insertIndex = this.taskQueue.length;
    for (let i = 0; i < this.taskQueue.length; i++) {
      const queuePriority = priorities[this.taskQueue[i].priority];
      if (taskPriority > queuePriority) {
        insertIndex = i;
        break;
      }
    }
    
    this.taskQueue.splice(insertIndex, 0, task);
  }

  /**
   * Find lowest priority task index for queue overflow handling
   */
  private findLowestPriorityTaskIndex(): number {
    const priorities = { 'critical': 4, 'high': 3, 'medium': 2, 'low': 1 };
    let lowestPriority = 5;
    let lowestIndex = 0;
    
    for (let i = 0; i < this.taskQueue.length; i++) {
      const priority = priorities[this.taskQueue[i].priority];
      if (priority < lowestPriority) {
        lowestPriority = priority;
        lowestIndex = i;
      }
    }
    
    return lowestIndex;
  }

  /**
   * Process next task in queue
   */
  private processNextTask(): void {
    if (this.taskQueue.length === 0) {
      return;
    }

    // Find available worker
    const availableWorkerId = this.findAvailableWorker();
    if (!availableWorkerId) {
      // Try to scale up if possible
      if (this.config.autoScale && this.workers.size < this.config.maxWorkers) {
        this.createWorker();
        // Retry processing
        setTimeout(() => this.processNextTask(), 10);
      }
      return;
    }

    const task = this.taskQueue.shift()!;
    const worker = this.workers.get(availableWorkerId)!;
    const stats = this.workerStats.get(availableWorkerId)!;
    
    stats.isActive = true;
    worker.postMessage(task);
    
    logger.debug('Task assigned to worker', {
      taskId: task.id,
      taskType: task.type,
      workerId: availableWorkerId,
      queueSize: this.taskQueue.length
    });
  }

  /**
   * Find available worker
   */
  private findAvailableWorker(): string | null {
    for (const [workerId, stats] of this.workerStats) {
      if (!stats.isActive) {
        return workerId;
      }
    }
    return null;
  }

  /**
   * Start auto-scaling monitoring
   */
  private startAutoScaling(): void {
    this.scaleTimer = setInterval(() => {
      this.autoScale();
    }, 5000); // Check every 5 seconds
  }

  /**
   * Auto-scale worker pool based on queue size and utilization
   */
  private autoScale(): void {
    const queueSize = this.taskQueue.length;
    const activeWorkers = Array.from(this.workerStats.values()).filter(s => s.isActive).length;
    const totalWorkers = this.workers.size;
    
    const utilizationRate = totalWorkers > 0 ? activeWorkers / totalWorkers : 0;
    
    // Scale up if queue is growing and utilization is high
    if (queueSize > this.config.scaleUpThreshold && 
        utilizationRate > 0.8 && 
        totalWorkers < this.config.maxWorkers) {
      
      this.createWorker();
      this.metrics.recordWorkerScaleEvent('scale_up', totalWorkers + 1);
      
      logger.info('Scaled up worker pool', {
        newWorkerCount: totalWorkers + 1,
        queueSize,
        utilizationRate
      });
    }
    
    // Scale down if queue is empty and utilization is low
    else if (queueSize < this.config.scaleDownThreshold && 
             utilizationRate < 0.3 && 
             totalWorkers > this.config.minWorkers) {
      
      // Find least utilized worker to terminate
      const workerToTerminate = this.findLeastUtilizedWorker();
      if (workerToTerminate) {
        const worker = this.workers.get(workerToTerminate);
        if (worker) {
          worker.terminate();
        }
        
        this.metrics.recordWorkerScaleEvent('scale_down', totalWorkers - 1);
        
        logger.info('Scaled down worker pool', {
          terminatedWorker: workerToTerminate,
          newWorkerCount: totalWorkers - 1,
          queueSize,
          utilizationRate
        });
      }
    }
  }

  /**
   * Find least utilized worker for scale-down
   */
  private findLeastUtilizedWorker(): string | null {
    let leastUtilized: string | null = null;
    let lowestUtilization = Infinity;
    
    for (const [workerId, stats] of this.workerStats) {
      if (!stats.isActive) {
        const utilization = stats.tasksCompleted / (Date.now() - (stats.lastTaskCompletedAt || 0));
        
        if (utilization < lowestUtilization) {
          lowestUtilization = utilization;
          leastUtilized = workerId;
        }
      }
    }
    
    return leastUtilized;
  }

  /**
   * Get worker pool statistics
   */
  getPoolStats(): {
    totalWorkers: number;
    activeWorkers: number;
    queueSize: number;
    pendingTasks: number;
    workerStats: WorkerStats[];
    utilizationRate: number;
  } {
    const workerStatsArray = Array.from(this.workerStats.values());
    const activeWorkers = workerStatsArray.filter(s => s.isActive).length;
    const utilizationRate = this.workers.size > 0 ? activeWorkers / this.workers.size : 0;
    
    return {
      totalWorkers: this.workers.size,
      activeWorkers,
      queueSize: this.taskQueue.length,
      pendingTasks: this.pendingTasks.size,
      workerStats: workerStatsArray,
      utilizationRate
    };
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    
    if (this.scaleTimer) {
      clearInterval(this.scaleTimer);
    }
    
    // Wait for pending tasks to complete or timeout
    const maxWaitTime = 30000; // 30 seconds
    const startTime = Date.now();
    
    while (this.pendingTasks.size > 0 && (Date.now() - startTime) < maxWaitTime) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // Terminate all workers
    const terminationPromises: Promise<number>[] = [];
    
    for (const [workerId, worker] of this.workers) {
      terminationPromises.push(worker.terminate());
    }
    
    await Promise.all(terminationPromises);
    
    this.workers.clear();
    this.workerStats.clear();
    this.taskQueue = [];
    this.pendingTasks.clear();
    
    logger.info('Worker thread pool shutdown complete');
  }
}

// Worker thread execution code
if (!isMainThread && workerData?.isWorkerThread) {
  parentPort?.on('message', async (task: WorkerTask) => {
    const startTime = Date.now();
    
    try {
      const result = await processWorkerTask(task);
      
      const response: WorkerResult = {
        taskId: task.id,
        success: true,
        result,
        processingTimeMs: Date.now() - startTime,
        workerId: 'current_worker'
      };
      
      parentPort?.postMessage(response);
      
    } catch (error) {
      const response: WorkerResult = {
        taskId: task.id,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        processingTimeMs: Date.now() - startTime,
        workerId: 'current_worker'
      };
      
      parentPort?.postMessage(response);
    }
  });
}

/**
 * Process task in worker thread
 */
async function processWorkerTask(task: WorkerTask): Promise<any> {
  switch (task.type) {
    case 'statistical_calculation':
      return processStatisticalCalculation(task.data);
    
    case 'signal_processing':
      return processSignalProcessing(task.data);
    
    case 'data_analysis':
      return processDataAnalysis(task.data);
    
    case 'correlation_analysis':
      return processCorrelationAnalysis(task.data);
    
    default:
      throw new Error(`Unknown task type: ${task.type}`);
  }
}

/**
 * Statistical calculation processing
 */
function processStatisticalCalculation(data: any): any {
  const { values, method } = data;
  
  switch (method) {
    case 'zscore':
      return calculateZScore(values);
    case 'correlation':
      return calculateCorrelation(values.x, values.y);
    case 'moving_average':
      return calculateMovingAverage(values, data.window);
    case 'standard_deviation':
      return calculateStandardDeviation(values);
    default:
      throw new Error(`Unknown statistical method: ${method}`);
  }
}

/**
 * Signal processing
 */
function processSignalProcessing(data: any): any {
  const { signals, filters } = data;
  
  // Apply filters and detect patterns
  const filteredSignals = applySignalFilters(signals, filters);
  const patterns = detectSignalPatterns(filteredSignals);
  
  return { filteredSignals, patterns };
}

/**
 * Data analysis processing
 */
function processDataAnalysis(data: any): any {
  const { dataset, analysisType } = data;
  
  switch (analysisType) {
    case 'trend_analysis':
      return performTrendAnalysis(dataset);
    case 'anomaly_detection':
      return detectAnomalies(dataset);
    case 'clustering':
      return performClustering(dataset);
    default:
      throw new Error(`Unknown analysis type: ${analysisType}`);
  }
}

/**
 * Correlation analysis processing
 */
function processCorrelationAnalysis(data: any): any {
  const { markets, timeWindow } = data;
  
  const correlations = calculateCrossMarketCorrelations(markets, timeWindow);
  const clusters = identifyCorrelatedClusters(correlations);
  
  return { correlations, clusters };
}

// Statistical utility functions
function calculateZScore(values: number[]): { zScores: number[]; mean: number; stdDev: number } {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / values.length;
  const stdDev = Math.sqrt(variance);
  
  const zScores = values.map(value => (value - mean) / stdDev);
  
  return { zScores, mean, stdDev };
}

function calculateCorrelation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  const meanX = x.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const meanY = y.slice(0, n).reduce((a, b) => a + b, 0) / n;
  
  let numerator = 0;
  let denomX = 0;
  let denomY = 0;
  
  for (let i = 0; i < n; i++) {
    const deltaX = x[i] - meanX;
    const deltaY = y[i] - meanY;
    
    numerator += deltaX * deltaY;
    denomX += deltaX * deltaX;
    denomY += deltaY * deltaY;
  }
  
  return numerator / Math.sqrt(denomX * denomY);
}

function calculateMovingAverage(values: number[], window: number): number[] {
  const result: number[] = [];
  
  for (let i = window - 1; i < values.length; i++) {
    const sum = values.slice(i - window + 1, i + 1).reduce((a, b) => a + b, 0);
    result.push(sum / window);
  }
  
  return result;
}

function calculateStandardDeviation(values: number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / values.length;
  return Math.sqrt(variance);
}

// Placeholder implementations for complex functions
function applySignalFilters(signals: any[], filters: any[]): any[] {
  return signals; // Implement filtering logic
}

function detectSignalPatterns(signals: any[]): any[] {
  return []; // Implement pattern detection
}

function performTrendAnalysis(dataset: any[]): any {
  return {}; // Implement trend analysis
}

function detectAnomalies(dataset: any[]): any[] {
  return []; // Implement anomaly detection
}

function performClustering(dataset: any[]): any {
  return {}; // Implement clustering
}

function calculateCrossMarketCorrelations(markets: any[], timeWindow: number): any {
  return {}; // Implement cross-market correlation
}

function identifyCorrelatedClusters(correlations: any): any[] {
  return []; // Implement cluster identification
}