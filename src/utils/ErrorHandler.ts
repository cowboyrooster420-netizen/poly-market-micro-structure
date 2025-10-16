import { logger } from './logger';

export interface ErrorHandlingConfig {
  maxRetries: number;
  retryDelayMs: number;
  exponentialBackoff: boolean;
  circuitBreakerEnabled: boolean;
  circuitBreakerThreshold: number;
  circuitBreakerResetTimeMs: number;
  criticalErrorTypes: string[];
  alertOnCriticalError: boolean;
}

export interface RetryConfig {
  maxRetries: number;
  delayMs: number;
  exponentialBackoff: boolean;
  retryableErrors?: string[];
  nonRetryableErrors?: string[];
}

export interface CircuitBreakerState {
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  failureCount: number;
  lastFailureTime: number;
  resetTime: number;
  successCount: number;
}

export class ApplicationError extends Error {
  public readonly code: string;
  public readonly severity: 'low' | 'medium' | 'high' | 'critical';
  public readonly retryable: boolean;
  public readonly context?: Record<string, any>;
  public readonly timestamp: number;

  constructor(
    message: string,
    code: string,
    severity: 'low' | 'medium' | 'high' | 'critical' = 'medium',
    retryable: boolean = true,
    context?: Record<string, any>
  ) {
    super(message);
    this.name = 'ApplicationError';
    this.code = code;
    this.severity = severity;
    this.retryable = retryable;
    this.context = context;
    this.timestamp = Date.now();

    // Maintain proper stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ApplicationError);
    }
  }
}

export class CircuitBreakerError extends ApplicationError {
  constructor(service: string) {
    super(
      `Circuit breaker is OPEN for service: ${service}`,
      'CIRCUIT_BREAKER_OPEN',
      'high',
      false,
      { service }
    );
    this.name = 'CircuitBreakerError';
  }
}

export class RateLimitError extends ApplicationError {
  constructor(service: string, resetTime: number) {
    super(
      `Rate limit exceeded for service: ${service}`,
      'RATE_LIMIT_EXCEEDED',
      'medium',
      true,
      { service, resetTime }
    );
    this.name = 'RateLimitError';
  }
}

export class DataValidationError extends ApplicationError {
  constructor(field: string, value: any, expectedType: string) {
    super(
      `Invalid data for field '${field}': expected ${expectedType}, got ${typeof value}`,
      'DATA_VALIDATION_ERROR',
      'medium',
      false,
      { field, value, expectedType }
    );
    this.name = 'DataValidationError';
  }
}

export class ErrorHandler {
  private config: ErrorHandlingConfig;
  private circuitBreakers = new Map<string, CircuitBreakerState>();
  private errorCounts = new Map<string, number>();
  private lastErrorTimes = new Map<string, number>();

  constructor(config: ErrorHandlingConfig) {
    this.config = config;
    logger.info('Error handler initialized with comprehensive error management');
  }

  /**
   * Execute a function with automatic retry logic
   */
  async executeWithRetry<T>(
    operation: () => Promise<T>,
    operationName: string,
    retryConfig?: Partial<RetryConfig>
  ): Promise<T> {
    const config: RetryConfig = {
      maxRetries: this.config.maxRetries,
      delayMs: this.config.retryDelayMs,
      exponentialBackoff: this.config.exponentialBackoff,
      ...retryConfig
    };

    let lastError: Error = new Error('Operation failed');
    let attempt = 0;

    while (attempt <= config.maxRetries) {
      try {
        // Check circuit breaker before attempting operation
        if (this.config.circuitBreakerEnabled) {
          this.checkCircuitBreaker(operationName);
        }

        const result = await operation();
        
        // Reset circuit breaker on success
        if (this.config.circuitBreakerEnabled) {
          this.recordSuccess(operationName);
        }

        // Log recovery if this was a retry
        if (attempt > 0) {
          logger.info(`Operation '${operationName}' recovered after ${attempt} retries`);
        }

        return result;

      } catch (error) {
        lastError = error as Error;
        attempt++;

        // Record failure for circuit breaker
        if (this.config.circuitBreakerEnabled) {
          this.recordFailure(operationName);
        }

        // Check if error is retryable
        if (!this.isRetryable(error as Error, config)) {
          logger.error(`Non-retryable error in operation '${operationName}':`, error);
          throw error;
        }

        // Don't retry if we've exceeded max attempts
        if (attempt > config.maxRetries) {
          break;
        }

        // Calculate delay with optional exponential backoff
        const delay = config.exponentialBackoff 
          ? config.delayMs * Math.pow(2, attempt - 1)
          : config.delayMs;

        logger.warn(`Operation '${operationName}' failed (attempt ${attempt}/${config.maxRetries + 1}), retrying in ${delay}ms:`, error);

        await this.sleep(delay);
      }
    }

    // All retries exhausted
    const finalError = new ApplicationError(
      `Operation '${operationName}' failed after ${config.maxRetries + 1} attempts`,
      'MAX_RETRIES_EXCEEDED',
      'high',
      false,
      { originalError: lastError.message, attempts: attempt }
    );

    logger.error('Max retries exceeded:', finalError);
    throw finalError;
  }

  /**
   * Execute a function with circuit breaker protection
   */
  async executeWithCircuitBreaker<T>(
    operation: () => Promise<T>,
    serviceName: string
  ): Promise<T> {
    this.checkCircuitBreaker(serviceName);

    try {
      const result = await operation();
      this.recordSuccess(serviceName);
      return result;
    } catch (error) {
      this.recordFailure(serviceName);
      throw error;
    }
  }

  /**
   * Handle and categorize errors with appropriate logging and alerting
   */
  handleError(error: Error, context?: Record<string, any>): void {
    const errorInfo = this.categorizeError(error);
    
    // Enhance error with context
    const enhancedContext = {
      ...context,
      errorCode: errorInfo.code,
      severity: errorInfo.severity,
      retryable: errorInfo.retryable,
      timestamp: Date.now()
    };

    // Log based on severity
    switch (errorInfo.severity) {
      case 'critical':
        logger.error('CRITICAL ERROR:', error, enhancedContext);
        break;
      case 'high':
        logger.error('HIGH SEVERITY ERROR:', error, enhancedContext);
        break;
      case 'medium':
        logger.warn('MEDIUM SEVERITY ERROR:', error, enhancedContext);
        break;
      case 'low':
        logger.info('LOW SEVERITY ERROR:', error, enhancedContext);
        break;
    }

    // Track error frequency
    this.trackError(errorInfo.code);

    // Alert on critical errors
    if (errorInfo.severity === 'critical' && this.config.alertOnCriticalError) {
      this.sendCriticalErrorAlert(error, enhancedContext);
    }
  }

  /**
   * Get circuit breaker status for a service
   */
  getCircuitBreakerStatus(serviceName: string): CircuitBreakerState {
    return this.circuitBreakers.get(serviceName) || this.createCircuitBreakerState();
  }

  /**
   * Get error statistics
   */
  getErrorStatistics(): {
    totalErrors: number;
    errorsByType: Map<string, number>;
    circuitBreakerStates: Map<string, CircuitBreakerState>;
    recentErrorRate: number;
  } {
    const totalErrors = Array.from(this.errorCounts.values()).reduce((sum, count) => sum + count, 0);
    const recentErrorRate = this.calculateRecentErrorRate();

    return {
      totalErrors,
      errorsByType: new Map(this.errorCounts),
      circuitBreakerStates: new Map(this.circuitBreakers),
      recentErrorRate
    };
  }

  /**
   * Reset circuit breaker for a service
   */
  resetCircuitBreaker(serviceName: string): void {
    const state = this.circuitBreakers.get(serviceName);
    if (state) {
      state.state = 'CLOSED';
      state.failureCount = 0;
      state.successCount = 0;
      state.lastFailureTime = 0;
      logger.info(`Circuit breaker reset for service: ${serviceName}`);
    }
  }

  /**
   * Create safe wrapper for async operations with comprehensive error handling
   */
  createSafeWrapper<T extends any[], R>(
    fn: (...args: T) => Promise<R>,
    operationName: string,
    options?: {
      retryConfig?: Partial<RetryConfig>;
      circuitBreaker?: boolean;
      fallback?: (...args: T) => Promise<R>;
    }
  ): (...args: T) => Promise<R> {
    return async (...args: T): Promise<R> => {
      try {
        if (options?.circuitBreaker) {
          return await this.executeWithCircuitBreaker(
            () => fn(...args),
            operationName
          );
        } else {
          return await this.executeWithRetry(
            () => fn(...args),
            operationName,
            options?.retryConfig
          );
        }
      } catch (error) {
        this.handleError(error as Error, { operationName, args });
        
        // Try fallback if available
        if (options?.fallback) {
          logger.warn(`Using fallback for operation: ${operationName}`);
          return await options.fallback(...args);
        }
        
        throw error;
      }
    };
  }

  // Private methods

  private checkCircuitBreaker(serviceName: string): void {
    const state = this.getOrCreateCircuitBreakerState(serviceName);
    const now = Date.now();

    switch (state.state) {
      case 'OPEN':
        if (now >= state.resetTime) {
          state.state = 'HALF_OPEN';
          state.successCount = 0;
          logger.info(`Circuit breaker entering HALF_OPEN state for service: ${serviceName}`);
        } else {
          throw new CircuitBreakerError(serviceName);
        }
        break;
      
      case 'HALF_OPEN':
        // Allow limited requests in half-open state
        break;
      
      case 'CLOSED':
        // Normal operation
        break;
    }
  }

  private recordSuccess(serviceName: string): void {
    const state = this.getOrCreateCircuitBreakerState(serviceName);
    
    if (state.state === 'HALF_OPEN') {
      state.successCount++;
      if (state.successCount >= 3) { // Require 3 successes to close
        state.state = 'CLOSED';
        state.failureCount = 0;
        logger.info(`Circuit breaker closed for service: ${serviceName}`);
      }
    } else if (state.state === 'CLOSED') {
      // Reset failure count on success
      state.failureCount = Math.max(0, state.failureCount - 1);
    }
  }

  private recordFailure(serviceName: string): void {
    const state = this.getOrCreateCircuitBreakerState(serviceName);
    const now = Date.now();

    state.failureCount++;
    state.lastFailureTime = now;

    if (state.state === 'HALF_OPEN') {
      // Failure in half-open state reopens the circuit
      state.state = 'OPEN';
      state.resetTime = now + this.config.circuitBreakerResetTimeMs;
      logger.warn(`Circuit breaker reopened for service: ${serviceName}`);
    } else if (state.state === 'CLOSED' && state.failureCount >= this.config.circuitBreakerThreshold) {
      // Open circuit if threshold exceeded
      state.state = 'OPEN';
      state.resetTime = now + this.config.circuitBreakerResetTimeMs;
      logger.warn(`Circuit breaker opened for service: ${serviceName} (failures: ${state.failureCount})`);
    }
  }

  private getOrCreateCircuitBreakerState(serviceName: string): CircuitBreakerState {
    if (!this.circuitBreakers.has(serviceName)) {
      this.circuitBreakers.set(serviceName, this.createCircuitBreakerState());
    }
    return this.circuitBreakers.get(serviceName)!;
  }

  private createCircuitBreakerState(): CircuitBreakerState {
    return {
      state: 'CLOSED',
      failureCount: 0,
      lastFailureTime: 0,
      resetTime: 0,
      successCount: 0
    };
  }

  private isRetryable(error: Error, config: RetryConfig): boolean {
    // Check for ApplicationError retryable flag
    if (error instanceof ApplicationError) {
      return error.retryable;
    }

    // Check specific error lists
    if (config.nonRetryableErrors?.some(pattern => error.message.includes(pattern))) {
      return false;
    }

    if (config.retryableErrors?.some(pattern => error.message.includes(pattern))) {
      return true;
    }

    // Default retryable errors
    const retryablePatterns = [
      'ECONNRESET',
      'ETIMEDOUT',
      'ENOTFOUND',
      'Network Error',
      'timeout',
      'Rate limit',
      'Service Unavailable',
      '503',
      '502',
      '504'
    ];

    return retryablePatterns.some(pattern => 
      error.message.toLowerCase().includes(pattern.toLowerCase())
    );
  }

  private categorizeError(error: Error): {
    code: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    retryable: boolean;
  } {
    // If it's already an ApplicationError, use its properties
    if (error instanceof ApplicationError) {
      return {
        code: error.code,
        severity: error.severity,
        retryable: error.retryable
      };
    }

    // Categorize based on error type and message
    const message = error.message.toLowerCase();
    
    // Critical errors
    if (this.config.criticalErrorTypes.some(type => message.includes(type.toLowerCase()))) {
      return { code: 'CRITICAL_ERROR', severity: 'critical', retryable: false };
    }

    // Database errors
    if (message.includes('database') || message.includes('sql') || message.includes('connection')) {
      return { code: 'DATABASE_ERROR', severity: 'high', retryable: true };
    }

    // Network errors
    if (message.includes('network') || message.includes('fetch') || message.includes('timeout')) {
      return { code: 'NETWORK_ERROR', severity: 'medium', retryable: true };
    }

    // Rate limiting
    if (message.includes('rate limit') || message.includes('429')) {
      return { code: 'RATE_LIMIT', severity: 'medium', retryable: true };
    }

    // Validation errors
    if (message.includes('validation') || message.includes('invalid')) {
      return { code: 'VALIDATION_ERROR', severity: 'low', retryable: false };
    }

    // Default categorization
    return { code: 'UNKNOWN_ERROR', severity: 'medium', retryable: true };
  }

  private trackError(errorCode: string): void {
    const currentCount = this.errorCounts.get(errorCode) || 0;
    this.errorCounts.set(errorCode, currentCount + 1);
    this.lastErrorTimes.set(errorCode, Date.now());
  }

  private calculateRecentErrorRate(): number {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    let recentErrors = 0;

    for (const [errorCode, lastTime] of this.lastErrorTimes) {
      if (lastTime > oneHourAgo) {
        recentErrors += this.errorCounts.get(errorCode) || 0;
      }
    }

    return recentErrors; // Errors per hour
  }

  private async sendCriticalErrorAlert(error: Error, context: Record<string, any>): Promise<void> {
    // This would integrate with alerting systems (Discord, Slack, email, etc.)
    logger.error('🚨 CRITICAL ERROR ALERT 🚨', {
      error: error.message,
      stack: error.stack,
      context
    });
    
    // TODO: Implement actual alerting mechanism
    // - Discord webhook
    // - Email notification
    // - Slack integration
    // - PagerDuty
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Default error handling configuration
export const DEFAULT_ERROR_CONFIG: ErrorHandlingConfig = {
  maxRetries: 3,
  retryDelayMs: 1000,
  exponentialBackoff: true,
  circuitBreakerEnabled: true,
  circuitBreakerThreshold: 5,
  circuitBreakerResetTimeMs: 60000, // 1 minute
  criticalErrorTypes: [
    'database corruption',
    'memory leak',
    'stack overflow',
    'security breach',
    'authentication failure'
  ],
  alertOnCriticalError: true
};

// Singleton instance
export const errorHandler = new ErrorHandler(DEFAULT_ERROR_CONFIG);