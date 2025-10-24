/**
 * Database Dialect Abstraction Layer
 *
 * Provides SQL generation that works across PostgreSQL and SQLite
 */

export type DatabaseProvider = 'postgresql' | 'sqlite' | 'memory';

export interface SQLDialect {
  provider: DatabaseProvider;

  // Type mappings
  serial(): string;
  uuid(): string;
  jsonType(): string;
  timestamp(): string;
  boolean(): string;
  decimal(): string;
  integer(): string;
  varchar(length: number): string;
  text(): string;

  // Function mappings
  now(): string;
  currentTimestamp(): string;

  // Parameter placeholder
  param(index: number): string;

  // SQL features
  autoIncrement(): string;
  onConflictDoUpdate(conflictTarget: string, updateSet: string): string;
  onConflictDoNothing(conflictTarget: string): string;
}

export class PostgreSQLDialect implements SQLDialect {
  provider: DatabaseProvider = 'postgresql';

  serial(): string {
    return 'SERIAL';
  }

  uuid(): string {
    return 'UUID';
  }

  jsonType(): string {
    return 'JSONB';
  }

  timestamp(): string {
    return 'TIMESTAMP';
  }

  boolean(): string {
    return 'BOOLEAN';
  }

  decimal(): string {
    return 'DECIMAL';
  }

  integer(): string {
    return 'INTEGER';
  }

  varchar(length: number): string {
    return `VARCHAR(${length})`;
  }

  text(): string {
    return 'TEXT';
  }

  now(): string {
    return 'NOW()';
  }

  currentTimestamp(): string {
    return 'CURRENT_TIMESTAMP';
  }

  param(index: number): string {
    return `$${index}`;
  }

  autoIncrement(): string {
    return ''; // SERIAL handles this
  }

  onConflictDoUpdate(conflictTarget: string, updateSet: string): string {
    return `ON CONFLICT (${conflictTarget}) DO UPDATE SET ${updateSet}`;
  }

  onConflictDoNothing(conflictTarget: string): string {
    return `ON CONFLICT (${conflictTarget}) DO NOTHING`;
  }
}

export class SQLiteDialect implements SQLDialect {
  provider: DatabaseProvider = 'sqlite';

  serial(): string {
    return 'INTEGER'; // Will use AUTOINCREMENT separately
  }

  uuid(): string {
    return 'TEXT'; // SQLite stores UUIDs as text
  }

  jsonType(): string {
    return 'TEXT'; // SQLite stores JSON as text
  }

  timestamp(): string {
    return 'TIMESTAMP'; // SQLite uses TEXT for timestamps
  }

  boolean(): string {
    return 'BOOLEAN'; // SQLite uses INTEGER 0/1
  }

  decimal(): string {
    return 'REAL'; // SQLite uses REAL for decimal
  }

  integer(): string {
    return 'INTEGER';
  }

  varchar(length: number): string {
    return 'TEXT'; // SQLite doesn't enforce length
  }

  text(): string {
    return 'TEXT';
  }

  now(): string {
    return "CURRENT_TIMESTAMP";
  }

  currentTimestamp(): string {
    return "CURRENT_TIMESTAMP";
  }

  param(index: number): string {
    return '?'; // SQLite uses ? for all parameters
  }

  autoIncrement(): string {
    return 'AUTOINCREMENT';
  }

  onConflictDoUpdate(conflictTarget: string, updateSet: string): string {
    // SQLite uses different syntax
    return `ON CONFLICT(${conflictTarget}) DO UPDATE SET ${updateSet}`;
  }

  onConflictDoNothing(conflictTarget: string): string {
    return `ON CONFLICT(${conflictTarget}) DO NOTHING`;
  }
}

export class MemoryDialect extends SQLiteDialect {
  provider: DatabaseProvider = 'memory';
}

/**
 * Get the appropriate SQL dialect for the database provider
 */
export function getDialect(provider: DatabaseProvider): SQLDialect {
  switch (provider) {
    case 'postgresql':
      return new PostgreSQLDialect();
    case 'sqlite':
      return new SQLiteDialect();
    case 'memory':
      return new MemoryDialect();
    default:
      throw new Error(`Unsupported database provider: ${provider}`);
  }
}

/**
 * Convert parameter array for the appropriate dialect
 * PostgreSQL uses $1, $2, etc. while SQLite uses ?
 */
export function convertParameters(sql: string, params: any[], fromDialect: DatabaseProvider, toDialect: DatabaseProvider): { sql: string; params: any[] } {
  if (fromDialect === toDialect) {
    return { sql, params };
  }

  if (fromDialect === 'postgresql' && (toDialect === 'sqlite' || toDialect === 'memory')) {
    // Convert $1, $2, ... to ?
    let convertedSql = sql;
    const sortedParams: any[] = [];

    // Find all $N parameters and replace with ?
    const paramRegex = /\$(\d+)/g;
    const matches = [...sql.matchAll(paramRegex)];

    // Sort by parameter index to ensure correct order
    const indexMap = new Map<number, number>();
    matches.forEach(match => {
      const paramIndex = parseInt(match[1]);
      if (!indexMap.has(paramIndex)) {
        indexMap.set(paramIndex, indexMap.size);
      }
    });

    // Build sorted params array
    for (let i = 0; i < indexMap.size; i++) {
      for (const [origIndex, newIndex] of indexMap.entries()) {
        if (newIndex === i) {
          sortedParams.push(params[origIndex - 1]);
          break;
        }
      }
    }

    // Replace all $N with ?
    convertedSql = sql.replace(/\$\d+/g, '?');

    return { sql: convertedSql, params: sortedParams.length > 0 ? sortedParams : params };
  }

  if ((fromDialect === 'sqlite' || fromDialect === 'memory') && toDialect === 'postgresql') {
    // Convert ? to $1, $2, ...
    let convertedSql = sql;
    let paramIndex = 1;

    convertedSql = sql.replace(/\?/g, () => `$${paramIndex++}`);

    return { sql: convertedSql, params };
  }

  return { sql, params };
}
