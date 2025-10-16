import WebSocket from 'ws';
import { logger } from '../utils/AdvancedLogger';
import { MetricsCollector } from '../monitoring/MetricsCollector';

export interface ConnectionPoolConfig {
  maxConnections: number;
  connectionTimeoutMs: number;
  reconnectIntervalMs: number;
  maxReconnectAttempts: number;
  heartbeatIntervalMs: number;
  messageQueueSize: number;
  batchSize: number;
  batchTimeoutMs: number;
}

export interface PooledConnection {
  id: string;
  ws: WebSocket;
  isActive: boolean;
  lastUsed: number;
  reconnectAttempts: number;
  messageQueue: any[];
  batchBuffer: any[];
  lastHeartbeat: number;
}

/**
 * High-performance WebSocket connection pool for managing multiple market data streams
 */
export class ConnectionPool {
  private connections: Map<string, PooledConnection> = new Map();
  private config: ConnectionPoolConfig;
  private metrics: MetricsCollector;
  private isShuttingDown: boolean = false;
  private heartbeatInterval?: NodeJS.Timeout;
  private batchProcessingInterval?: NodeJS.Timeout;

  constructor(config: ConnectionPoolConfig, metrics: MetricsCollector) {
    this.config = config;
    this.metrics = metrics;
    this.startHeartbeat();
    this.startBatchProcessing();
  }

  /**
   * Get or create a connection for the specified endpoint
   */
  async getConnection(endpoint: string): Promise<PooledConnection> {
    let connection = this.connections.get(endpoint);
    
    if (!connection || !this.isConnectionHealthy(connection)) {
      connection = await this.createConnection(endpoint);
      this.connections.set(endpoint, connection);
    }
    
    connection.lastUsed = Date.now();
    return connection;
  }

  /**
   * Create a new pooled connection
   */
  private async createConnection(endpoint: string): Promise<PooledConnection> {
    const connectionId = `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(endpoint, {
        handshakeTimeout: this.config.connectionTimeoutMs,
        perMessageDeflate: true, // Enable compression
        maxPayload: 1024 * 1024 // 1MB max message size
      });

      const connection: PooledConnection = {
        id: connectionId,
        ws,
        isActive: false,
        lastUsed: Date.now(),
        reconnectAttempts: 0,
        messageQueue: [],
        batchBuffer: [],
        lastHeartbeat: Date.now()
      };

      const connectionTimeout = setTimeout(() => {
        ws.terminate();
        reject(new Error(`Connection timeout for ${endpoint}`));
      }, this.config.connectionTimeoutMs);

      ws.on('open', () => {
        clearTimeout(connectionTimeout);
        connection.isActive = true;
        connection.reconnectAttempts = 0;
        
        logger.info(`WebSocket connection established`, {
          connectionId,
          endpoint,
          timestamp: Date.now()
        });
        
        this.metrics.recordConnectionEvent('created', this.connections.size);
        resolve(connection);
      });

      ws.on('message', (data: WebSocket.Data) => {
        try {
          connection.lastHeartbeat = Date.now();
          const message = JSON.parse(data.toString());
          
          // Add to batch buffer for efficient processing
          connection.batchBuffer.push({
            timestamp: Date.now(),
            data: message,
            endpoint
          });
          
          // Process immediately if batch is full
          if (connection.batchBuffer.length >= this.config.batchSize) {
            this.processBatch(connection);
          }
          
        } catch (error) {
          logger.error('Failed to parse WebSocket message', {
            connectionId,
            endpoint,
            error: error instanceof Error ? error.message : 'Unknown error',
            rawData: data.toString().substring(0, 200)
          });
        }
      });

      ws.on('error', (error) => {
        logger.error('WebSocket connection error', {
          connectionId,
          endpoint,
          error: error.message,
          reconnectAttempts: connection.reconnectAttempts
        });
        
        // Error connection events will be tracked when the connection is destroyed
        this.handleConnectionError(connection, endpoint);
      });

      ws.on('close', (code, reason) => {
        connection.isActive = false;
        
        logger.info('WebSocket connection closed', {
          connectionId,
          endpoint,
          code,
          reason: reason.toString(),
          wasShuttingDown: this.isShuttingDown
        });
        
        this.metrics.recordConnectionEvent('destroyed', this.connections.size);
        
        if (!this.isShuttingDown) {
          this.scheduleReconnect(connection, endpoint);
        }
      });

      // Set up ping/pong for connection health
      ws.on('ping', () => {
        ws.pong();
        connection.lastHeartbeat = Date.now();
      });

      ws.on('pong', () => {
        connection.lastHeartbeat = Date.now();
      });
    });
  }

  /**
   * Check if connection is healthy and active
   */
  private isConnectionHealthy(connection: PooledConnection): boolean {
    const now = Date.now();
    const heartbeatAge = now - connection.lastHeartbeat;
    const isStale = heartbeatAge > (this.config.heartbeatIntervalMs * 2);
    
    return connection.isActive && 
           connection.ws.readyState === WebSocket.OPEN && 
           !isStale;
  }

  /**
   * Handle connection errors with exponential backoff retry
   */
  private async handleConnectionError(connection: PooledConnection, endpoint: string): Promise<void> {
    connection.isActive = false;
    connection.reconnectAttempts++;
    
    if (connection.reconnectAttempts <= this.config.maxReconnectAttempts) {
      this.scheduleReconnect(connection, endpoint);
    } else {
      logger.error('Max reconnection attempts reached', {
        connectionId: connection.id,
        endpoint,
        attempts: connection.reconnectAttempts
      });
      
      this.connections.delete(endpoint);
      // Connection failure tracking - remove the connection
    }
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  private scheduleReconnect(connection: PooledConnection, endpoint: string): void {
    const backoffMs = Math.min(
      this.config.reconnectIntervalMs * Math.pow(2, connection.reconnectAttempts),
      30000 // Max 30 second backoff
    );
    
    setTimeout(async () => {
      if (!this.isShuttingDown) {
        try {
          const newConnection = await this.createConnection(endpoint);
          this.connections.set(endpoint, newConnection);
          
          logger.info('WebSocket reconnection successful', {
            endpoint,
            attempts: connection.reconnectAttempts + 1,
            backoffMs
          });
          
        } catch (error) {
          logger.error('WebSocket reconnection failed', {
            endpoint,
            attempts: connection.reconnectAttempts + 1,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
          
          this.handleConnectionError(connection, endpoint);
        }
      }
    }, backoffMs);
  }

  /**
   * Process batched messages efficiently
   */
  private processBatch(connection: PooledConnection): void {
    if (connection.batchBuffer.length === 0) return;
    
    const batch = connection.batchBuffer.splice(0, this.config.batchSize);
    const startTime = Date.now();
    
    try {
      // Group messages by type for efficient processing
      const groupedMessages = this.groupMessagesByType(batch);
      
      // Process each group
      for (const [messageType, messages] of groupedMessages) {
        this.processMessageGroup(messageType, messages);
      }
      
      const processingTime = Date.now() - startTime;
      this.metrics.recordBatchProcessing('message_batch', batch.length, processingTime);
      
      logger.debug('Batch processed successfully', {
        connectionId: connection.id,
        batchSize: batch.length,
        processingTimeMs: processingTime,
        messageTypes: Array.from(groupedMessages.keys())
      });
      
    } catch (error) {
      logger.error('Batch processing failed', {
        connectionId: connection.id,
        batchSize: batch.length,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Group messages by type for efficient processing
   */
  private groupMessagesByType(batch: any[]): Map<string, any[]> {
    const groups = new Map<string, any[]>();
    
    for (const item of batch) {
      const messageType = item.data.type || 'unknown';
      
      if (!groups.has(messageType)) {
        groups.set(messageType, []);
      }
      
      groups.get(messageType)!.push(item);
    }
    
    return groups;
  }

  /**
   * Process a group of messages of the same type
   */
  private processMessageGroup(messageType: string, messages: any[]): void {
    // Emit batch event for efficient downstream processing
    process.nextTick(() => {
      this.emit('batchMessage', {
        type: messageType,
        messages,
        timestamp: Date.now()
      });
    });
  }

  /**
   * Send message through connection with queuing
   */
  async sendMessage(endpoint: string, message: any): Promise<void> {
    const connection = await this.getConnection(endpoint);
    
    if (connection.messageQueue.length >= this.config.messageQueueSize) {
      // Drop oldest message to prevent memory buildup
      connection.messageQueue.shift();
      this.metrics.recordQueueOverflow('connection_queue', 1);
    }
    
    connection.messageQueue.push(message);
    
    if (connection.isActive && connection.ws.readyState === WebSocket.OPEN) {
      this.flushMessageQueue(connection);
    }
  }

  /**
   * Flush queued messages
   */
  private flushMessageQueue(connection: PooledConnection): void {
    while (connection.messageQueue.length > 0 && 
           connection.ws.readyState === WebSocket.OPEN) {
      
      const message = connection.messageQueue.shift();
      
      try {
        connection.ws.send(JSON.stringify(message));
      } catch (error) {
        logger.error('Failed to send queued message', {
          connectionId: connection.id,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
        break;
      }
    }
  }

  /**
   * Start heartbeat monitoring
   */
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      for (const [endpoint, connection] of this.connections) {
        if (connection.isActive && connection.ws.readyState === WebSocket.OPEN) {
          const timeSinceHeartbeat = Date.now() - connection.lastHeartbeat;
          
          if (timeSinceHeartbeat > this.config.heartbeatIntervalMs) {
            // Send ping to check connection
            try {
              connection.ws.ping();
            } catch (error) {
              logger.error('Failed to send heartbeat ping', {
                connectionId: connection.id,
                endpoint
              });
            }
          }
        }
      }
    }, this.config.heartbeatIntervalMs);
  }

  /**
   * Start batch processing timer
   */
  private startBatchProcessing(): void {
    this.batchProcessingInterval = setInterval(() => {
      for (const connection of this.connections.values()) {
        if (connection.batchBuffer.length > 0) {
          this.processBatch(connection);
        }
      }
    }, this.config.batchTimeoutMs);
  }

  /**
   * Get connection pool statistics
   */
  getPoolStats(): {
    totalConnections: number;
    activeConnections: number;
    totalQueuedMessages: number;
    totalBufferedMessages: number;
    connectionsByEndpoint: { [endpoint: string]: { active: boolean; queueSize: number; bufferSize: number } };
  } {
    let activeConnections = 0;
    let totalQueuedMessages = 0;
    let totalBufferedMessages = 0;
    const connectionsByEndpoint: { [endpoint: string]: any } = {};
    
    for (const [endpoint, connection] of this.connections) {
      if (connection.isActive) activeConnections++;
      
      totalQueuedMessages += connection.messageQueue.length;
      totalBufferedMessages += connection.batchBuffer.length;
      
      connectionsByEndpoint[endpoint] = {
        active: connection.isActive,
        queueSize: connection.messageQueue.length,
        bufferSize: connection.batchBuffer.length
      };
    }
    
    return {
      totalConnections: this.connections.size,
      activeConnections,
      totalQueuedMessages,
      totalBufferedMessages,
      connectionsByEndpoint
    };
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    
    if (this.batchProcessingInterval) {
      clearInterval(this.batchProcessingInterval);
    }
    
    const shutdownPromises: Promise<void>[] = [];
    
    for (const [endpoint, connection] of this.connections) {
      shutdownPromises.push(new Promise<void>((resolve) => {
        if (connection.ws.readyState === WebSocket.OPEN) {
          connection.ws.close(1000, 'Graceful shutdown');
          connection.ws.once('close', () => resolve());
        } else {
          resolve();
        }
      }));
    }
    
    await Promise.all(shutdownPromises);
    this.connections.clear();
    
    logger.info('Connection pool shutdown complete');
  }

  /**
   * Event emitter functionality
   */
  private eventListeners: { [event: string]: Function[] } = {};
  
  on(event: string, listener: Function): void {
    if (!this.eventListeners[event]) {
      this.eventListeners[event] = [];
    }
    this.eventListeners[event].push(listener);
  }
  
  private emit(event: string, data: any): void {
    if (this.eventListeners[event]) {
      for (const listener of this.eventListeners[event]) {
        try {
          listener(data);
        } catch (error) {
          logger.error('Event listener error', { event, error });
        }
      }
    }
  }
}