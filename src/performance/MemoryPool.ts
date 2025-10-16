import { logger } from '../utils/AdvancedLogger';
import { MetricsCollector } from '../monitoring/MetricsCollector';

export interface MemoryPoolConfig {
  initialPoolSize: number;
  maxPoolSize: number;
  growthFactor: number;
  shrinkThreshold: number;
  cleanupIntervalMs: number;
  maxObjectAge: number;
  enableMetrics: boolean;
}

export interface PooledObject<T> {
  data: T;
  timestamp: number;
  inUse: boolean;
  id: string;
}

/**
 * High-performance object pooling for frequent allocations/deallocations
 */
export class MemoryPool<T> {
  private pool: PooledObject<T>[] = [];
  private inUseObjects: Set<string> = new Set();
  private config: MemoryPoolConfig;
  private metrics: MetricsCollector;
  private factoryFunction: () => T;
  private resetFunction?: (obj: T) => void;
  private cleanupInterval?: NodeJS.Timeout;
  private objectIdCounter: number = 0;

  // Pool statistics
  private stats = {
    totalCreated: 0,
    totalAcquired: 0,
    totalReleased: 0,
    totalDestroyed: 0,
    currentPoolSize: 0,
    currentInUse: 0,
    peakPoolSize: 0,
    peakInUse: 0
  };

  constructor(
    factoryFunction: () => T,
    config: MemoryPoolConfig,
    metrics: MetricsCollector,
    resetFunction?: (obj: T) => void
  ) {
    this.factoryFunction = factoryFunction;
    this.config = config;
    this.metrics = metrics;
    this.resetFunction = resetFunction;

    this.initializePool();
    this.startCleanupTimer();
  }

  /**
   * Initialize pool with initial objects
   */
  private initializePool(): void {
    for (let i = 0; i < this.config.initialPoolSize; i++) {
      const obj = this.createPooledObject();
      this.pool.push(obj);
    }
    
    this.stats.currentPoolSize = this.pool.length;
    
    logger.info('Memory pool initialized', {
      poolType: this.factoryFunction.name,
      initialSize: this.config.initialPoolSize,
      maxSize: this.config.maxPoolSize
    });
  }

  /**
   * Create a new pooled object
   */
  private createPooledObject(): PooledObject<T> {
    const obj: PooledObject<T> = {
      data: this.factoryFunction(),
      timestamp: Date.now(),
      inUse: false,
      id: `obj_${++this.objectIdCounter}`
    };
    
    this.stats.totalCreated++;
    return obj;
  }

  /**
   * Acquire an object from the pool
   */
  acquire(): T {
    let pooledObject: PooledObject<T> | undefined;

    // Try to find an available object in the pool
    for (let i = 0; i < this.pool.length; i++) {
      if (!this.pool[i].inUse) {
        pooledObject = this.pool[i];
        break;
      }
    }

    // If no available object and we can grow the pool, create a new one
    if (!pooledObject && this.pool.length < this.config.maxPoolSize) {
      pooledObject = this.createPooledObject();
      this.pool.push(pooledObject);
      this.stats.currentPoolSize = this.pool.length;
      this.stats.peakPoolSize = Math.max(this.stats.peakPoolSize, this.pool.length);
    }

    // If still no object available, create a temporary one (not pooled)
    if (!pooledObject) {
      logger.warn('Memory pool exhausted, creating temporary object', {
        poolType: this.factoryFunction.name,
        poolSize: this.pool.length,
        inUse: this.inUseObjects.size
      });
      
      this.metrics.recordPoolExhaustion(this.factoryFunction.name, 0);
      return this.factoryFunction();
    }

    // Mark object as in use
    pooledObject.inUse = true;
    pooledObject.timestamp = Date.now();
    this.inUseObjects.add(pooledObject.id);
    
    this.stats.totalAcquired++;
    this.stats.currentInUse = this.inUseObjects.size;
    this.stats.peakInUse = Math.max(this.stats.peakInUse, this.stats.currentInUse);

    // Reset object if reset function is provided
    if (this.resetFunction) {
      this.resetFunction(pooledObject.data);
    }

    if (this.config.enableMetrics) {
      this.metrics.recordObjectAcquisition(this.factoryFunction.name, this.stats.currentInUse);
    }

    return pooledObject.data;
  }

  /**
   * Release an object back to the pool
   */
  release(obj: T): void {
    // Find the pooled object wrapper
    const pooledObject = this.pool.find(po => po.data === obj);
    
    if (!pooledObject) {
      // This was a temporary object not from the pool
      return;
    }

    if (!pooledObject.inUse) {
      logger.warn('Attempting to release object that is not in use', {
        poolType: this.factoryFunction.name,
        objectId: pooledObject.id
      });
      return;
    }

    // Mark as available
    pooledObject.inUse = false;
    pooledObject.timestamp = Date.now();
    this.inUseObjects.delete(pooledObject.id);
    
    this.stats.totalReleased++;
    this.stats.currentInUse = this.inUseObjects.size;

    if (this.config.enableMetrics) {
      this.metrics.recordObjectRelease(this.factoryFunction.name, this.stats.currentInUse);
    }
  }

  /**
   * Start cleanup timer to remove old unused objects
   */
  private startCleanupTimer(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, this.config.cleanupIntervalMs);
  }

  /**
   * Clean up old unused objects to free memory
   */
  private cleanup(): void {
    const now = Date.now();
    const beforeSize = this.pool.length;
    let removed = 0;

    // Remove old unused objects
    this.pool = this.pool.filter(obj => {
      if (!obj.inUse && (now - obj.timestamp) > this.config.maxObjectAge) {
        this.stats.totalDestroyed++;
        removed++;
        return false;
      }
      return true;
    });

    this.stats.currentPoolSize = this.pool.length;

    // Shrink pool if it's significantly larger than needed
    const inUseRatio = this.inUseObjects.size / this.pool.length;
    if (inUseRatio < this.config.shrinkThreshold && this.pool.length > this.config.initialPoolSize) {
      const targetSize = Math.max(
        this.config.initialPoolSize,
        Math.ceil(this.inUseObjects.size / this.config.shrinkThreshold)
      );
      
      const toRemove = this.pool.length - targetSize;
      let actuallyRemoved = 0;

      for (let i = this.pool.length - 1; i >= 0 && actuallyRemoved < toRemove; i--) {
        if (!this.pool[i].inUse) {
          this.pool.splice(i, 1);
          actuallyRemoved++;
          this.stats.totalDestroyed++;
        }
      }

      this.stats.currentPoolSize = this.pool.length;
      removed += actuallyRemoved;
    }

    if (removed > 0) {
      logger.debug('Memory pool cleanup completed', {
        poolType: this.factoryFunction.name,
        beforeSize,
        afterSize: this.pool.length,
        removed,
        inUse: this.inUseObjects.size
      });
    }
  }

  /**
   * Get pool statistics
   */
  getStats(): typeof this.stats & {
    utilizationRate: number;
    averageAge: number;
    oldestObjectAge: number;
  } {
    const now = Date.now();
    const ages = this.pool.map(obj => now - obj.timestamp);
    const averageAge = ages.length > 0 ? ages.reduce((a, b) => a + b, 0) / ages.length : 0;
    const oldestObjectAge = ages.length > 0 ? Math.max(...ages) : 0;
    const utilizationRate = this.pool.length > 0 ? this.inUseObjects.size / this.pool.length : 0;

    return {
      ...this.stats,
      utilizationRate,
      averageAge,
      oldestObjectAge
    };
  }

  /**
   * Force cleanup of the entire pool
   */
  clear(): void {
    // Release all objects
    for (const obj of this.pool) {
      if (obj.inUse) {
        this.inUseObjects.delete(obj.id);
      }
    }

    this.stats.totalDestroyed += this.pool.length;
    this.pool = [];
    this.inUseObjects.clear();
    this.stats.currentPoolSize = 0;
    this.stats.currentInUse = 0;

    logger.info('Memory pool cleared', {
      poolType: this.factoryFunction.name
    });
  }

  /**
   * Graceful shutdown
   */
  shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    this.clear();

    logger.info('Memory pool shutdown complete', {
      poolType: this.factoryFunction.name,
      finalStats: this.stats
    });
  }
}

/**
 * Memory pool manager for handling multiple object types
 */
export class MemoryPoolManager {
  private pools: Map<string, MemoryPool<any>> = new Map();
  private metrics: MetricsCollector;

  constructor(metrics: MetricsCollector) {
    this.metrics = metrics;
  }

  /**
   * Create or get a memory pool for a specific type
   */
  createPool<T>(
    name: string,
    factoryFunction: () => T,
    config: Partial<MemoryPoolConfig> = {},
    resetFunction?: (obj: T) => void
  ): MemoryPool<T> {
    if (this.pools.has(name)) {
      return this.pools.get(name)!;
    }

    const fullConfig: MemoryPoolConfig = {
      initialPoolSize: 10,
      maxPoolSize: 100,
      growthFactor: 1.5,
      shrinkThreshold: 0.3,
      cleanupIntervalMs: 60000, // 1 minute
      maxObjectAge: 300000, // 5 minutes
      enableMetrics: true,
      ...config
    };

    const pool = new MemoryPool<T>(factoryFunction, fullConfig, this.metrics, resetFunction);
    this.pools.set(name, pool);

    logger.info('Memory pool created', {
      poolName: name,
      config: fullConfig
    });

    return pool;
  }

  /**
   * Get pool by name
   */
  getPool<T>(name: string): MemoryPool<T> | undefined {
    return this.pools.get(name);
  }

  /**
   * Get all pool statistics
   */
  getAllStats(): { [poolName: string]: any } {
    const stats: { [poolName: string]: any } = {};
    
    for (const [name, pool] of this.pools) {
      stats[name] = pool.getStats();
    }
    
    return stats;
  }

  /**
   * Shutdown all pools
   */
  shutdown(): void {
    for (const [name, pool] of this.pools) {
      pool.shutdown();
    }
    
    this.pools.clear();
    logger.info('All memory pools shutdown complete');
  }
}

// Common object factories for the trading system
export const ObjectFactories = {
  marketMetrics: () => ({
    marketId: '',
    volume24h: 0,
    prices: [] as number[],
    priceChanges: {} as { [key: string]: number },
    spread: 0,
    activity: 0,
    volumeChange: 0,
    timestamp: 0
  }),

  orderbookEntry: () => ({
    price: 0,
    size: 0,
    volume: 0,
    timestamp: 0
  }),

  signalMetadata: () => ({
    severity: 'medium' as 'low' | 'medium' | 'high' | 'critical',
    signalSource: '',
    currentVolume: 0,
    averageVolume: 0,
    volumeMultiplier: 0,
    priceChange: 0,
    correlationScore: 0,
    confidence: 0,
    additionalData: {} as { [key: string]: any }
  }),

  ringBufferNode: () => ({
    value: 0,
    timestamp: 0,
    metadata: {} as { [key: string]: any }
  })
};