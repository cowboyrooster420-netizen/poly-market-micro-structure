import { logger } from './logger';
import { RateLimitError } from './ErrorHandler';

export interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
  keyGenerator?: (identifier: string) => string;
  onLimitReached?: (identifier: string, resetTime: number) => void;
}

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  resetTime: number;
  retryAfter: number;
}

interface RateLimitEntry {
  count: number;
  resetTime: number;
  firstRequest: number;
}

export class RateLimiter {
  private limits = new Map<string, RateLimitEntry>();
  private config: RateLimitConfig;
  private cleanupInterval?: NodeJS.Timeout;

  constructor(config: RateLimitConfig) {
    this.config = {
      keyGenerator: (id: string) => id,
      ...config
    };

    // Clean up expired entries every minute
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60000);

    logger.info(`Rate limiter initialized: ${config.maxRequests} requests per ${config.windowMs}ms`);
  }

  /**
   * Check if a request is allowed and update the counter
   */
  isAllowed(identifier: string, increment: boolean = true): boolean {
    const key = this.config.keyGenerator!(identifier);
    const now = Date.now();
    const entry = this.limits.get(key);

    // No previous requests or window has expired
    if (!entry || now >= entry.resetTime) {
      if (increment) {
        this.limits.set(key, {
          count: 1,
          resetTime: now + this.config.windowMs,
          firstRequest: now
        });
      }
      return true;
    }

    // Check if limit is exceeded
    if (entry.count >= this.config.maxRequests) {
      if (this.config.onLimitReached) {
        this.config.onLimitReached(identifier, entry.resetTime);
      }
      return false;
    }

    // Increment counter if allowed
    if (increment) {
      entry.count++;
    }

    return true;
  }

  /**
   * Attempt to consume a token, throwing RateLimitError if not allowed
   */
  consume(identifier: string): RateLimitInfo {
    const key = this.config.keyGenerator!(identifier);
    const allowed = this.isAllowed(identifier, true);
    
    if (!allowed) {
      const entry = this.limits.get(key)!;
      
      throw new RateLimitError(identifier, entry.resetTime);
    }

    return this.getInfo(identifier);
  }

  /**
   * Get rate limit information for an identifier
   */
  getInfo(identifier: string): RateLimitInfo {
    const key = this.config.keyGenerator!(identifier);
    const now = Date.now();
    const entry = this.limits.get(key);

    if (!entry || now >= entry.resetTime) {
      return {
        limit: this.config.maxRequests,
        remaining: this.config.maxRequests,
        resetTime: now + this.config.windowMs,
        retryAfter: 0
      };
    }

    return {
      limit: this.config.maxRequests,
      remaining: Math.max(0, this.config.maxRequests - entry.count),
      resetTime: entry.resetTime,
      retryAfter: Math.max(0, Math.ceil((entry.resetTime - now) / 1000))
    };
  }

  /**
   * Reset rate limit for a specific identifier
   */
  reset(identifier: string): void {
    const key = this.config.keyGenerator!(identifier);
    this.limits.delete(key);
    logger.debug(`Rate limit reset for: ${identifier}`);
  }

  /**
   * Clean up expired entries
   */
  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, entry] of this.limits.entries()) {
      if (now >= entry.resetTime) {
        this.limits.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug(`Cleaned up ${cleaned} expired rate limit entries`);
    }
  }

  /**
   * Execute a function with rate limiting
   */
  async execute<T>(fn: () => Promise<T>, identifier: string = 'default'): Promise<T> {
    // Check rate limit before executing
    if (!this.isAllowed(identifier, true)) {
      const info = this.getInfo(identifier);
      throw new RateLimitError(identifier, info.resetTime);
    }

    return await fn();
  }

  /**
   * Destroy the rate limiter and clean up resources
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
    this.limits.clear();
  }
}

// Create rate limiters for different services
export const polymarketRateLimiter = new RateLimiter({
  maxRequests: 100,
  windowMs: 60000, // 1 minute
  onLimitReached: (identifier, resetTime) => {
    logger.warn(`Polymarket rate limit reached for ${identifier}, resets at ${new Date(resetTime).toISOString()}`);
  }
});

export const discordRateLimiter = new RateLimiter({
  maxRequests: 30,
  windowMs: 60000, // 1 minute
  onLimitReached: (identifier, resetTime) => {
    logger.warn(`Discord rate limit reached for ${identifier}, resets at ${new Date(resetTime).toISOString()}`);
  }
});