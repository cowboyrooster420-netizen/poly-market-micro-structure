import { Pool, PoolClient } from 'pg';
import { Database } from 'sqlite3';
import { createClient, RedisClientType } from 'redis';
import { logger } from '../utils/logger';

export interface DatabaseConfig {
  provider: 'postgresql' | 'sqlite' | 'memory';
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  redis?: {
    host: string;
    port: number;
    password?: string;
  };
}

export class DatabaseManager {
  private pgPool?: Pool;
  private sqlite?: Database;
  private redis?: RedisClientType;
  private config: DatabaseConfig;

  constructor(config: DatabaseConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    logger.info(`Initializing database with provider: ${this.config.provider}`);

    try {
      switch (this.config.provider) {
        case 'postgresql':
          await this.initializePostgreSQL();
          break;
        case 'sqlite':
          await this.initializeSQLite();
          break;
        case 'memory':
          logger.info('Using in-memory storage (no persistence)');
          break;
      }

      // Initialize Redis cache if configured
      if (this.config.redis) {
        await this.initializeRedis();
      }

      // Create database schema
      await this.createSchema();
      
      logger.info('Database initialization completed successfully');
    } catch (error) {
      logger.error('Database initialization failed:', error);
      throw error;
    }
  }

  private async initializePostgreSQL(): Promise<void> {
    const connectionString = this.config.connectionString || 
      `postgresql://${this.config.username}:${this.config.password}@${this.config.host}:${this.config.port}/${this.config.database}`;
    
    this.pgPool = new Pool({
      connectionString,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });

    // Test connection
    const client = await this.pgPool.connect();
    await client.query('SELECT NOW()');
    client.release();
    
    logger.info('PostgreSQL connection established');
  }

  private async initializeSQLite(): Promise<void> {
    return new Promise((resolve, reject) => {
      const dbPath = this.config.database || './data/polymarket.db';
      this.sqlite = new Database(dbPath, (err) => {
        if (err) {
          reject(err);
        } else {
          logger.info(`SQLite database opened: ${dbPath}`);
          resolve();
        }
      });
    });
  }

  private async initializeRedis(): Promise<void> {
    this.redis = createClient({
      socket: {
        host: this.config.redis!.host,
        port: this.config.redis!.port,
      },
      password: this.config.redis!.password,
    });

    this.redis.on('error', (err) => {
      logger.error('Redis error:', err);
    });

    await this.redis.connect();
    logger.info('Redis connection established');
  }

  private async createSchema(): Promise<void> {
    const schema = `
      -- Markets table
      CREATE TABLE IF NOT EXISTS markets (
        id VARCHAR(100) PRIMARY KEY,
        condition_id VARCHAR(100),
        question TEXT NOT NULL,
        description TEXT,
        outcomes JSONB,
        volume DECIMAL,
        active BOOLEAN DEFAULT true,
        closed BOOLEAN DEFAULT false,
        end_date TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        metadata JSONB
      );

      -- Historical prices table (time-series)
      CREATE TABLE IF NOT EXISTS market_prices (
        id SERIAL PRIMARY KEY,
        market_id VARCHAR(100) NOT NULL,
        timestamp TIMESTAMP NOT NULL,
        outcome_index INTEGER NOT NULL,
        price DECIMAL NOT NULL,
        volume DECIMAL,
        FOREIGN KEY (market_id) REFERENCES markets(id)
      );

      -- Orderbook snapshots
      CREATE TABLE IF NOT EXISTS orderbook_snapshots (
        id SERIAL PRIMARY KEY,
        market_id VARCHAR(100) NOT NULL,
        timestamp TIMESTAMP NOT NULL,
        bids JSONB NOT NULL,
        asks JSONB NOT NULL,
        spread DECIMAL,
        mid_price DECIMAL,
        best_bid DECIMAL,
        best_ask DECIMAL,
        FOREIGN KEY (market_id) REFERENCES markets(id)
      );

      -- Trade ticks
      CREATE TABLE IF NOT EXISTS trade_ticks (
        id SERIAL PRIMARY KEY,
        market_id VARCHAR(100) NOT NULL,
        timestamp TIMESTAMP NOT NULL,
        price DECIMAL NOT NULL,
        size DECIMAL NOT NULL,
        side VARCHAR(4) NOT NULL CHECK (side IN ('buy', 'sell')),
        FOREIGN KEY (market_id) REFERENCES markets(id)
      );

      -- Signals table
      CREATE TABLE IF NOT EXISTS signals (
        id SERIAL PRIMARY KEY,
        market_id VARCHAR(100) NOT NULL,
        signal_type VARCHAR(50) NOT NULL,
        confidence DECIMAL NOT NULL,
        timestamp TIMESTAMP NOT NULL,
        metadata JSONB,
        validated BOOLEAN DEFAULT false,
        validation_time TIMESTAMP,
        outcome BOOLEAN,
        FOREIGN KEY (market_id) REFERENCES markets(id)
      );

      -- Microstructure metrics
      CREATE TABLE IF NOT EXISTS microstructure_metrics (
        id SERIAL PRIMARY KEY,
        market_id VARCHAR(100) NOT NULL,
        timestamp TIMESTAMP NOT NULL,
        depth_1_bid DECIMAL,
        depth_1_ask DECIMAL,
        depth_1_total DECIMAL,
        micro_price DECIMAL,
        micro_price_slope DECIMAL,
        micro_price_drift DECIMAL,
        orderbook_imbalance DECIMAL,
        spread_bps DECIMAL,
        liquidity_vacuum BOOLEAN,
        volume_z_score DECIMAL,
        depth_z_score DECIMAL,
        spread_z_score DECIMAL,
        imbalance_z_score DECIMAL,
        FOREIGN KEY (market_id) REFERENCES markets(id)
      );

      -- Front-running scores
      CREATE TABLE IF NOT EXISTS front_running_scores (
        id SERIAL PRIMARY KEY,
        market_id VARCHAR(100) NOT NULL,
        timestamp TIMESTAMP NOT NULL,
        score DECIMAL NOT NULL,
        confidence DECIMAL NOT NULL,
        leak_probability DECIMAL NOT NULL,
        time_to_news DECIMAL,
        components JSONB,
        metadata JSONB,
        FOREIGN KEY (market_id) REFERENCES markets(id)
      );

      -- Backtest results table
      CREATE TABLE IF NOT EXISTS backtest_results (
        id SERIAL PRIMARY KEY,
        start_date TIMESTAMP NOT NULL,
        end_date TIMESTAMP NOT NULL,
        initial_capital DECIMAL NOT NULL,
        total_returns DECIMAL NOT NULL,
        sharpe_ratio DECIMAL NOT NULL,
        max_drawdown DECIMAL NOT NULL,
        win_rate DECIMAL NOT NULL,
        total_trades INTEGER NOT NULL,
        signal_accuracy DECIMAL NOT NULL,
        config JSONB NOT NULL,
        results JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Anomaly scores table for advanced statistical analysis
      CREATE TABLE IF NOT EXISTS anomaly_scores (
        id SERIAL PRIMARY KEY,
        market_id VARCHAR(100) NOT NULL,
        timestamp TIMESTAMP NOT NULL,
        volume_anomaly DECIMAL NOT NULL,
        depth_anomaly DECIMAL NOT NULL,
        spread_anomaly DECIMAL NOT NULL,
        imbalance_anomaly DECIMAL NOT NULL,
        price_anomaly DECIMAL NOT NULL,
        mahalanobis_distance DECIMAL NOT NULL,
        isolation_forest_score DECIMAL NOT NULL,
        combined_score DECIMAL NOT NULL,
        is_anomalous BOOLEAN NOT NULL,
        anomaly_type JSONB NOT NULL,
        confidence DECIMAL NOT NULL,
        FOREIGN KEY (market_id) REFERENCES markets(id)
      );

      -- Indexes for performance
      CREATE INDEX IF NOT EXISTS idx_market_prices_market_time ON market_prices(market_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_orderbook_market_time ON orderbook_snapshots(market_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_trade_ticks_market_time ON trade_ticks(market_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_signals_market_time ON signals(market_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_signals_type ON signals(signal_type);
      CREATE INDEX IF NOT EXISTS idx_microstructure_market_time ON microstructure_metrics(market_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_front_running_market_time ON front_running_scores(market_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_backtest_results_date ON backtest_results(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_anomaly_scores_market_time ON anomaly_scores(market_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_anomaly_scores_anomalous ON anomaly_scores(is_anomalous, timestamp DESC);
    `;

    await this.executeSchema(schema);
  }

  private async executeSchema(schema: string): Promise<void> {
    const statements = schema.split(';').filter(stmt => stmt.trim());
    
    for (const statement of statements) {
      if (statement.trim()) {
        await this.query(statement.trim());
      }
    }
  }

  async query(text: string, params: any[] = []): Promise<any> {
    if (this.pgPool) {
      const client = await this.pgPool.connect();
      try {
        const result = await client.query(text, params);
        return result.rows;
      } finally {
        client.release();
      }
    } else if (this.sqlite) {
      return new Promise((resolve, reject) => {
        const method = text.trim().toUpperCase().startsWith('SELECT') ? 'all' : 'run';
        this.sqlite![method](text, params, function(this: any, err: any, result: any) {
          if (err) {
            reject(err);
          } else {
            resolve(method === 'all' ? result : { insertId: this.lastID, changes: this.changes });
          }
        });
      });
    } else {
      throw new Error('No database connection available');
    }
  }

  async transaction<T>(callback: (query: (text: string, params?: any[]) => Promise<any>) => Promise<T>): Promise<T> {
    if (this.pgPool) {
      const client = await this.pgPool.connect();
      try {
        await client.query('BEGIN');
        const result = await callback(async (text, params = []) => {
          const res = await client.query(text, params);
          return res.rows;
        });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } else {
      // SQLite doesn't support transactions in the same way
      return callback(this.query.bind(this));
    }
  }

  // Cache operations using Redis
  async setCache(key: string, value: any, ttlSeconds: number = 300): Promise<void> {
    if (this.redis) {
      await this.redis.setEx(key, ttlSeconds, JSON.stringify(value));
    }
  }

  async getCache(key: string): Promise<any | null> {
    if (this.redis) {
      const value = await this.redis.get(key);
      return value ? JSON.parse(value) : null;
    }
    return null;
  }

  async deleteCache(key: string): Promise<void> {
    if (this.redis) {
      await this.redis.del(key);
    }
  }

  // Health check
  async healthCheck(): Promise<{ healthy: boolean; details: any }> {
    const checks = {
      database: false,
      redis: false,
    };

    try {
      // Test database connection
      await this.query('SELECT 1');
      checks.database = true;
    } catch (error) {
      logger.error('Database health check failed:', error);
    }

    try {
      // Test Redis connection
      if (this.redis) {
        await this.redis.ping();
        checks.redis = true;
      } else {
        checks.redis = true; // Redis is optional
      }
    } catch (error) {
      logger.error('Redis health check failed:', error);
    }

    return {
      healthy: checks.database,
      details: {
        provider: this.config.provider,
        database: checks.database,
        redis: checks.redis,
        connectionPool: this.pgPool ? {
          totalCount: this.pgPool.totalCount,
          idleCount: this.pgPool.idleCount,
          waitingCount: this.pgPool.waitingCount,
        } : null,
      },
    };
  }

  async close(): Promise<void> {
    try {
      if (this.pgPool) {
        await this.pgPool.end();
        logger.info('PostgreSQL pool closed');
      }

      if (this.sqlite) {
        await new Promise<void>((resolve, reject) => {
          this.sqlite!.close((err) => {
            if (err) reject(err);
            else {
              logger.info('SQLite database closed');
              resolve();
            }
          });
        });
      }

      if (this.redis) {
        await this.redis.quit();
        logger.info('Redis connection closed');
      }
    } catch (error) {
      logger.error('Error closing database connections:', error);
      throw error;
    }
  }
}