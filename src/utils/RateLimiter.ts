import { logger } from './logger';

export interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
  delayMs?: number;
}

export class RateLimiter {
  private requests: number[] = [];
  private config: RateLimitConfig;
  private queue: Array<() => void> = [];
  private processing = false;

  constructor(config: RateLimitConfig) {
    this.config = config;
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          await this.waitForRateLimit();
          const result = await operation();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });

      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;

    while (this.queue.length > 0) {
      const operation = this.queue.shift();
      if (operation) {
        await operation();
        
        // Add delay between requests if configured
        if (this.config.delayMs && this.queue.length > 0) {
          await this.delay(this.config.delayMs);
        }
      }
    }

    this.processing = false;
  }

  private async waitForRateLimit(): Promise<void> {
    const now = Date.now();
    
    // Remove old requests outside the window
    this.requests = this.requests.filter(
      timestamp => now - timestamp < this.config.windowMs
    );

    // If we're at the limit, wait until we can make another request
    if (this.requests.length >= this.config.maxRequests) {
      const oldestRequest = this.requests[0];
      const waitTime = this.config.windowMs - (now - oldestRequest);
      
      if (waitTime > 0) {
        logger.debug(`Rate limit reached, waiting ${waitTime}ms`);
        await this.delay(waitTime);
        return this.waitForRateLimit(); // Recursively check again
      }
    }

    // Record this request
    this.requests.push(now);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getStats(): { current: number; max: number; queueLength: number } {
    const now = Date.now();
    const currentRequests = this.requests.filter(
      timestamp => now - timestamp < this.config.windowMs
    ).length;

    return {
      current: currentRequests,
      max: this.config.maxRequests,
      queueLength: this.queue.length,
    };
  }
}

// Singleton rate limiters for different APIs
export const polymarketRateLimiter = new RateLimiter({
  maxRequests: 10, // Polymarket allows ~10 requests per second
  windowMs: 1000,
  delayMs: 100, // 100ms delay between requests
});

export const discordRateLimiter = new RateLimiter({
  maxRequests: 5, // Discord webhooks allow ~5 requests per second
  windowMs: 1000,
  delayMs: 200, // 200ms delay between webhook calls
});