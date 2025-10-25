import { Pool, PoolClient } from 'pg';
import { Database } from 'sqlite3';
import { createClient, RedisClientType } from 'redis';
import { logger } from '../utils/logger';
import { getDialect, SQLDialect, convertParameters } from './DatabaseDialect';
import { SchemaBuilder } from './SchemaBuilder';

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
  private dialect: SQLDialect;

  constructor(config: DatabaseConfig) {
    this.config = config;
    this.dialect = getDialect(config.provider);
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

      // Ensure directory exists
      const fs = require('fs');
      const path = require('path');
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        logger.info(`Created database directory: ${dir}`);
      }

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
    const schemaBuilder = new SchemaBuilder(this.dialect);
    const schema = schemaBuilder.buildSchema();

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
      // Convert PostgreSQL-style $1, $2 parameters to SQLite-style ?
      const converted = convertParameters(text, params, 'postgresql', this.config.provider);

      return new Promise((resolve, reject) => {
        const method = converted.sql.trim().toUpperCase().startsWith('SELECT') ? 'all' : 'run';
        this.sqlite![method](converted.sql, converted.params, function(this: any, err: any, result: any) {
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

  getProvider(): 'postgresql' | 'sqlite' | 'memory' {
    return this.config.provider;
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