import { DatabaseConfig } from '../data/database';
import { logger } from '../utils/logger';

export function getDatabaseConfig(): DatabaseConfig {
  const provider = (process.env.DATABASE_PROVIDER || 'sqlite') as 'postgresql' | 'sqlite' | 'memory';
  
  logger.info(`Using database provider: ${provider}`);
  
  switch (provider) {
    case 'postgresql':
      return {
        provider: 'postgresql',
        connectionString: process.env.DATABASE_URL,
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432'),
        database: process.env.DB_NAME || 'polymarket',
        username: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD,
        redis: process.env.REDIS_URL ? {
          host: process.env.REDIS_HOST || 'localhost',
          port: parseInt(process.env.REDIS_PORT || '6379'),
          password: process.env.REDIS_PASSWORD,
        } : undefined,
      };
      
    case 'sqlite':
      return {
        provider: 'sqlite',
        database: process.env.SQLITE_PATH || './data/polymarket.db',
        redis: process.env.REDIS_URL ? {
          host: process.env.REDIS_HOST || 'localhost',
          port: parseInt(process.env.REDIS_PORT || '6379'),
          password: process.env.REDIS_PASSWORD,
        } : undefined,
      };
      
    case 'memory':
      return {
        provider: 'memory',
      };
      
    default:
      throw new Error(`Unsupported database provider: ${provider}`);
  }
}

export function validateDatabaseConfig(config: DatabaseConfig): void {
  switch (config.provider) {
    case 'postgresql':
      if (!config.connectionString && (!config.host || !config.database || !config.username)) {
        throw new Error('PostgreSQL requires either DATABASE_URL or DB_HOST, DB_NAME, and DB_USER');
      }
      break;
      
    case 'sqlite':
      if (!config.database) {
        throw new Error('SQLite requires SQLITE_PATH or will use default ./data/polymarket.db');
      }
      break;
      
    case 'memory':
      logger.warn('Using in-memory database - no data will persist between restarts');
      break;
      
    default:
      throw new Error(`Invalid database provider: ${config.provider}`);
  }
}