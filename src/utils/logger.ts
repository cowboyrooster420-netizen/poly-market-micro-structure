export class Logger {
  private logLevel: string;

  constructor() {
    this.logLevel = process.env.LOG_LEVEL || 'info';
  }

  private shouldLog(level: string): boolean {
    const levels = ['debug', 'info', 'warn', 'error'];
    const currentLevel = levels.indexOf(this.logLevel);
    const messageLevel = levels.indexOf(level);
    return messageLevel >= currentLevel;
  }

  private formatMessage(level: string, message: string, ...args: any[]): string {
    const timestamp = new Date().toISOString();
    const formattedArgs = args.length > 0 ? ` ${args.map(arg => this.formatArg(arg)).join(' ')}` : '';
    return `[${timestamp}] [${level.toUpperCase()}] ${message}${formattedArgs}`;
  }

  private formatArg(arg: any): string {
    if (arg instanceof Error) {
      return `\nError: ${arg.message}\nStack: ${arg.stack}`;
    }
    
    if (typeof arg === 'object' && arg !== null) {
      try {
        return JSON.stringify(arg, null, 2);
      } catch (e) {
        return `[Object: ${Object.prototype.toString.call(arg)}]`;
      }
    }
    
    return String(arg);
  }

  debug(message: string, ...args: any[]): void {
    if (this.shouldLog('debug')) {
      console.log(this.formatMessage('debug', message, ...args));
    }
  }

  info(message: string, ...args: any[]): void {
    if (this.shouldLog('info')) {
      console.log(this.formatMessage('info', message, ...args));
    }
  }

  warn(message: string, ...args: any[]): void {
    if (this.shouldLog('warn')) {
      console.warn(this.formatMessage('warn', message, ...args));
    }
  }

  error(message: string, ...args: any[]): void {
    if (this.shouldLog('error')) {
      console.error(this.formatMessage('error', message, ...args));
    }
  }

  // Helper methods for common debugging scenarios
  logApiCall(method: string, url: string, status?: number, duration?: number): void {
    const details: any = { method, url };
    if (status !== undefined) details.status = status;
    if (duration !== undefined) details.duration = `${duration}ms`;
    
    if (status && status >= 400) {
      this.error('API call failed', details);
    } else {
      this.debug('API call', details);
    }
  }

  logWebSocketEvent(event: string, marketId?: string, details?: any): void {
    const logData: any = { event };
    if (marketId) logData.marketId = marketId;
    if (details) logData.details = details;
    
    this.debug('WebSocket event', logData);
  }

  logSignalProcessing(signalType: string, marketId: string, confidence: number, success: boolean): void {
    this.info('Signal processed', {
      signalType,
      marketId: marketId.substring(0, 8) + '...',
      confidence: confidence.toFixed(2),
      success
    });
  }

  logPerformanceMetric(metric: string, value: number, unit: string = ''): void {
    this.debug('Performance metric', { metric, value: `${value}${unit}` });
  }
}

export const logger = new Logger();