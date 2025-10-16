import { Database } from 'sqlite3';
import { logger } from '../utils/AdvancedLogger';
import { MetricsCollector } from '../monitoring/MetricsCollector';
import { MemoryPool } from './MemoryPool';

export interface BatchProcessorConfig {
  batchSize: number;
  flushIntervalMs: number;
  maxMemoryUsage: number; // in MB
  retryAttempts: number;
  retryDelayMs: number;
  enableCompression: boolean;
  enableCaching: boolean;
  cacheMaxSize: number;
  cacheTtlMs: number;
}

export interface BatchOperation {
  id: string;
  type: 'insert' | 'update' | 'delete';
  table: string;
  data: any;
  timestamp: number;
  priority: 'low' | 'medium' | 'high' | 'critical';
}

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
  accessCount: number;
  lastAccessed: number;
}

/**
 * High-performance batch processor for database operations and caching
 */
export class BatchProcessor {
  private db: Database;
  private config: BatchProcessorConfig;
  private metrics: MetricsCollector;
  private operationQueue: BatchOperation[] = [];
  private flushInterval?: NodeJS.Timeout;
  private memoryPool: MemoryPool<BatchOperation>;
  private cache: Map<string, CacheEntry<any>> = new Map();
  private cacheCleanupInterval?: NodeJS.Timeout;
  private isProcessing: boolean = false;
  private shutdownRequested: boolean = false;

  // Performance statistics
  private stats = {
    totalOperations: 0,
    batchesProcessed: 0,
    averageBatchSize: 0,
    averageProcessingTimeMs: 0,
    cacheHits: 0,
    cacheMisses: 0,
    retryCount: 0,
    errorCount: 0
  };

  constructor(
    db: Database,
    config: BatchProcessorConfig,
    metrics: MetricsCollector,
    memoryPool: MemoryPool<BatchOperation>
  ) {
    this.db = db;
    this.config = config;
    this.metrics = metrics;
    this.memoryPool = memoryPool;

    this.startFlushTimer();
    if (this.config.enableCaching) {
      this.startCacheCleanup();
    }
  }

  /**
   * Add operation to batch queue
   */
  async addOperation(operation: Omit<BatchOperation, 'id' | 'timestamp'>): Promise<void> {
    const batchOperation: BatchOperation = {
      ...operation,
      id: `op_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now()
    };

    // Use memory pool to avoid frequent allocations
    const pooledOperation = this.memoryPool.acquire();
    Object.assign(pooledOperation, batchOperation);

    // Insert based on priority
    this.insertByPriority(pooledOperation);
    
    this.stats.totalOperations++;

    // Flush immediately if batch is full or critical priority
    if (this.operationQueue.length >= this.config.batchSize || operation.priority === 'critical') {
      await this.flush();
    }

    // Check memory usage
    if (this.getMemoryUsageMB() > this.config.maxMemoryUsage) {
      logger.warn('Memory usage exceeded threshold, forcing flush', {
        currentUsageMB: this.getMemoryUsageMB(),
        threshold: this.config.maxMemoryUsage,
        queueSize: this.operationQueue.length
      });
      await this.flush();
    }
  }

  /**
   * Insert operation into queue based on priority
   */
  private insertByPriority(operation: BatchOperation): void {
    const priorities = { 'critical': 4, 'high': 3, 'medium': 2, 'low': 1 };
    const operationPriority = priorities[operation.priority];

    let insertIndex = this.operationQueue.length;
    
    // Find insertion point to maintain priority order
    for (let i = 0; i < this.operationQueue.length; i++) {
      const queuePriority = priorities[this.operationQueue[i].priority];
      if (operationPriority > queuePriority) {
        insertIndex = i;
        break;
      }
    }

    this.operationQueue.splice(insertIndex, 0, operation);
  }

  /**
   * Flush all pending operations
   */
  async flush(): Promise<void> {
    if (this.isProcessing || this.operationQueue.length === 0) {
      return;
    }

    this.isProcessing = true;
    const startTime = Date.now();
    const batchToProcess = this.operationQueue.splice(0, this.config.batchSize);

    try {
      await this.processBatch(batchToProcess);
      
      // Update statistics
      const processingTime = Date.now() - startTime;
      this.stats.batchesProcessed++;
      this.stats.averageBatchSize = this.stats.totalOperations / this.stats.batchesProcessed;
      this.stats.averageProcessingTimeMs = 
        (this.stats.averageProcessingTimeMs * (this.stats.batchesProcessed - 1) + processingTime) / 
        this.stats.batchesProcessed;

      this.metrics.recordBatchProcessing('data_processing', batchToProcess.length, processingTime);

      logger.debug('Batch processed successfully', {
        batchSize: batchToProcess.length,
        processingTimeMs: processingTime,
        remainingInQueue: this.operationQueue.length
      });

    } catch (error) {
      this.stats.errorCount++;
      logger.error('Batch processing failed', {
        batchSize: batchToProcess.length,
        error: error instanceof Error ? error.message : 'Unknown error'
      });

      // Retry with exponential backoff
      await this.retryBatch(batchToProcess);
    } finally {
      // Return operations to memory pool
      for (const operation of batchToProcess) {
        this.memoryPool.release(operation);
      }
      this.isProcessing = false;
    }
  }

  /**
   * Process a batch of operations efficiently
   */
  private async processBatch(batch: BatchOperation[]): Promise<void> {
    // Group operations by table and type for efficient processing
    const groupedOps = this.groupOperations(batch);
    
    return new Promise((resolve, reject) => {
      this.db.serialize(() => {
        this.db.run('BEGIN TRANSACTION');
        
        const promises: Promise<void>[] = [];
        
        for (const [key, operations] of groupedOps) {
          const [table, type] = key.split(':');
          promises.push(this.processOperationGroup(table, type as any, operations));
        }
        
        Promise.all(promises)
          .then(() => {
            this.db.run('COMMIT', (err) => {
              if (err) {
                this.db.run('ROLLBACK');
                reject(err);
              } else {
                resolve();
              }
            });
          })
          .catch((error) => {
            this.db.run('ROLLBACK');
            reject(error);
          });
      });
    });
  }

  /**
   * Group operations by table and type for efficient batch processing
   */
  private groupOperations(batch: BatchOperation[]): Map<string, BatchOperation[]> {
    const groups = new Map<string, BatchOperation[]>();
    
    for (const operation of batch) {
      const key = `${operation.table}:${operation.type}`;
      
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      
      groups.get(key)!.push(operation);
    }
    
    return groups;
  }

  /**
   * Process a group of operations of the same type and table
   */
  private async processOperationGroup(
    table: string, 
    type: 'insert' | 'update' | 'delete', 
    operations: BatchOperation[]
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      switch (type) {
        case 'insert':
          this.processInsertBatch(table, operations, resolve, reject);
          break;
        case 'update':
          this.processUpdateBatch(table, operations, resolve, reject);
          break;
        case 'delete':
          this.processDeleteBatch(table, operations, resolve, reject);
          break;
        default:
          reject(new Error(`Unknown operation type: ${type}`));
      }
    });
  }

  /**
   * Process batch of insert operations
   */
  private processInsertBatch(
    table: string, 
    operations: BatchOperation[], 
    resolve: () => void, 
    reject: (error: any) => void
  ): void {
    if (operations.length === 0) {
      resolve();
      return;
    }

    // Build batch insert statement
    const firstOp = operations[0];
    const columns = Object.keys(firstOp.data);
    const placeholders = columns.map(() => '?').join(', ');
    const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`;
    
    const stmt = this.db.prepare(sql);
    let completed = 0;
    let hasError = false;

    for (const operation of operations) {
      const values = columns.map(col => operation.data[col]);
      
      stmt.run(values, (err) => {
        if (err && !hasError) {
          hasError = true;
          stmt.finalize();
          reject(err);
        } else {
          completed++;
          if (completed === operations.length && !hasError) {
            stmt.finalize(() => resolve());
          }
        }
      });
    }
  }

  /**
   * Process batch of update operations
   */
  private processUpdateBatch(
    table: string, 
    operations: BatchOperation[], 
    resolve: () => void, 
    reject: (error: any) => void
  ): void {
    // Group updates by their SET clause pattern
    const updateGroups = new Map<string, BatchOperation[]>();
    
    for (const op of operations) {
      const setClause = Object.keys(op.data).filter(k => k !== 'id').sort().join(',');
      
      if (!updateGroups.has(setClause)) {
        updateGroups.set(setClause, []);
      }
      updateGroups.get(setClause)!.push(op);
    }

    let completed = 0;
    const totalGroups = updateGroups.size;
    let hasError = false;

    for (const [setClause, groupOps] of updateGroups) {
      const columns = setClause.split(',');
      const setColumns = columns.map(col => `${col} = ?`).join(', ');
      const sql = `UPDATE ${table} SET ${setColumns} WHERE id = ?`;
      
      const stmt = this.db.prepare(sql);
      let groupCompleted = 0;

      for (const operation of groupOps) {
        const values = [...columns.map(col => operation.data[col]), operation.data.id];
        
        stmt.run(values, (err) => {
          if (err && !hasError) {
            hasError = true;
            stmt.finalize();
            reject(err);
          } else {
            groupCompleted++;
            if (groupCompleted === groupOps.length) {
              stmt.finalize();
              completed++;
              if (completed === totalGroups && !hasError) {
                resolve();
              }
            }
          }
        });
      }
    }

    if (totalGroups === 0) {
      resolve();
    }
  }

  /**
   * Process batch of delete operations
   */
  private processDeleteBatch(
    table: string, 
    operations: BatchOperation[], 
    resolve: () => void, 
    reject: (error: any) => void
  ): void {
    if (operations.length === 0) {
      resolve();
      return;
    }

    const ids = operations.map(op => op.data.id);
    const placeholders = ids.map(() => '?').join(', ');
    const sql = `DELETE FROM ${table} WHERE id IN (${placeholders})`;
    
    this.db.run(sql, ids, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  }

  /**
   * Retry failed batch with exponential backoff
   */
  private async retryBatch(batch: BatchOperation[], attempt: number = 1): Promise<void> {
    if (attempt > this.config.retryAttempts) {
      logger.error('Max retry attempts reached for batch', {
        batchSize: batch.length,
        maxAttempts: this.config.retryAttempts
      });
      return;
    }

    const delay = this.config.retryDelayMs * Math.pow(2, attempt - 1);
    
    await new Promise(resolve => setTimeout(resolve, delay));
    
    try {
      await this.processBatch(batch);
      this.stats.retryCount++;
      
      logger.info('Batch retry successful', {
        attempt,
        batchSize: batch.length,
        delayMs: delay
      });
      
    } catch (error) {
      logger.warn('Batch retry failed', {
        attempt,
        batchSize: batch.length,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      
      await this.retryBatch(batch, attempt + 1);
    }
  }

  /**
   * Cache operations
   */
  async get<T>(key: string): Promise<T | null> {
    if (!this.config.enableCaching) {
      return null;
    }

    const entry = this.cache.get(key);
    
    if (!entry) {
      this.stats.cacheMisses++;
      return null;
    }

    // Check if entry is still valid
    if (Date.now() - entry.timestamp > this.config.cacheTtlMs) {
      this.cache.delete(key);
      this.stats.cacheMisses++;
      return null;
    }

    entry.accessCount++;
    entry.lastAccessed = Date.now();
    this.stats.cacheHits++;
    
    return entry.data;
  }

  async set<T>(key: string, data: T): Promise<void> {
    if (!this.config.enableCaching) {
      return;
    }

    // Remove oldest entries if cache is full
    if (this.cache.size >= this.config.cacheMaxSize) {
      this.evictOldestEntries();
    }

    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      accessCount: 0,
      lastAccessed: Date.now()
    });
  }

  /**
   * Evict oldest cache entries
   */
  private evictOldestEntries(): void {
    const entries = Array.from(this.cache.entries())
      .sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);
    
    const toRemove = Math.ceil(this.config.cacheMaxSize * 0.1); // Remove 10%
    
    for (let i = 0; i < toRemove && entries.length > 0; i++) {
      this.cache.delete(entries[i][0]);
    }
  }

  /**
   * Start automatic flush timer
   */
  private startFlushTimer(): void {
    this.flushInterval = setInterval(async () => {
      if (!this.shutdownRequested) {
        await this.flush();
      }
    }, this.config.flushIntervalMs);
  }

  /**
   * Start cache cleanup timer
   */
  private startCacheCleanup(): void {
    this.cacheCleanupInterval = setInterval(() => {
      this.cleanupCache();
    }, this.config.cacheTtlMs / 2); // Run cleanup at half TTL interval
  }

  /**
   * Clean up expired cache entries
   */
  private cleanupCache(): void {
    const now = Date.now();
    let removed = 0;
    
    for (const [key, entry] of this.cache) {
      if (now - entry.timestamp > this.config.cacheTtlMs) {
        this.cache.delete(key);
        removed++;
      }
    }
    
    if (removed > 0) {
      logger.debug('Cache cleanup completed', {
        removedEntries: removed,
        remainingEntries: this.cache.size
      });
    }
  }

  /**
   * Get current memory usage in MB
   */
  private getMemoryUsageMB(): number {
    const usage = process.memoryUsage();
    return usage.heapUsed / (1024 * 1024);
  }

  /**
   * Get processor statistics
   */
  getStats(): typeof this.stats & {
    queueSize: number;
    cacheSize: number;
    cacheHitRate: number;
    memoryUsageMB: number;
  } {
    const totalCacheRequests = this.stats.cacheHits + this.stats.cacheMisses;
    const cacheHitRate = totalCacheRequests > 0 ? this.stats.cacheHits / totalCacheRequests : 0;

    return {
      ...this.stats,
      queueSize: this.operationQueue.length,
      cacheSize: this.cache.size,
      cacheHitRate,
      memoryUsageMB: this.getMemoryUsageMB()
    };
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    this.shutdownRequested = true;

    if (this.flushInterval) {
      clearInterval(this.flushInterval);
    }

    if (this.cacheCleanupInterval) {
      clearInterval(this.cacheCleanupInterval);
    }

    // Flush remaining operations
    await this.flush();

    // Wait for any ongoing processing to complete
    while (this.isProcessing) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    this.cache.clear();

    logger.info('Batch processor shutdown complete', {
      finalStats: this.getStats()
    });
  }
}