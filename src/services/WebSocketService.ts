import WebSocket from 'ws';
import { TickData, OrderbookData, OrderbookLevel, BotConfig } from '../types';
import { logger } from '../utils/logger';

export interface WebSocketMessage {
  type: 'trade' | 'orderbook' | 'subscription' | 'error';
  data: any;
}

export class WebSocketService {
  private config: BotConfig;
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isConnected = false;
  private isConnecting = false; // Prevent concurrent connection attempts
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private subscribedMarkets: Set<string> = new Set();

  // Rate limiting for message processing
  private messageCount = 0;
  private messageWindow = Date.now();
  private readonly MAX_MESSAGES_PER_SECOND = 100;

  // Validation constants
  private readonly MAX_MESSAGE_SIZE = 50000; // 50KB
  private readonly MAX_ORDERBOOK_LEVELS = 100;

  // Event handlers
  private onTickHandler: ((tick: TickData) => void) | null = null;
  private onOrderbookHandler: ((orderbook: OrderbookData) => void) | null = null;
  private onConnectionHandler: ((connected: boolean) => void) | null = null;

  constructor(config: BotConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    if (this.isConnected) {
      logger.warn('WebSocket already connected');
      return;
    }

    if (this.isConnecting) {
      logger.warn('WebSocket connection already in progress');
      return;
    }

    this.isConnecting = true;

    return new Promise((resolve, reject) => {
      const wsUrl = this.buildWebSocketUrl();
      logger.info(`Connecting to WebSocket: ${wsUrl}`);

      this.ws = new WebSocket(wsUrl);

      // Timeout for connection
      const timeoutId = setTimeout(() => {
        if (!this.isConnected && this.isConnecting) {
          this.isConnecting = false;
          // Close the WebSocket to cancel the connection attempt
          if (this.ws) {
            this.ws.terminate();
            this.ws = null;
          }
          reject(new Error('WebSocket connection timeout'));
        }
      }, 10000);

      this.ws.on('open', () => {
        clearTimeout(timeoutId); // Clear the connection timeout
        this.isConnected = true;
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        logger.info('🔌 WebSocket connected to Polymarket Real-Time Data Service');

        if (this.onConnectionHandler) {
          this.onConnectionHandler(true);
        }

        // Resubscribe to markets if any
        this.resubscribeToMarkets();
        resolve();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        this.handleMessage(data);
      });

      this.ws.on('close', (code: number, reason: string) => {
        clearTimeout(timeoutId); // Clear timeout on close as well
        this.isConnected = false;
        this.isConnecting = false;
        logger.warn(`WebSocket closed: ${code} - ${reason}`);

        if (this.onConnectionHandler) {
          this.onConnectionHandler(false);
        }

        this.handleReconnect();
      });

      this.ws.on('error', (error: Error) => {
        clearTimeout(timeoutId); // Clear timeout on error
        this.isConnecting = false;
        logger.error('WebSocket error:', error);
        reject(error);
      });
    });
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.isConnected = false;
    this.isConnecting = false;
    this.subscribedMarkets.clear();
    logger.info('WebSocket disconnected');
  }

  subscribeToMarket(marketId: string): void {
    if (!this.isConnected) {
      logger.warn('Cannot subscribe - WebSocket not connected');
      return;
    }

    // Polymarket Real-Time Data Service subscription format
    // OPTIMIZED: Only subscribe to orderbook data ('book')
    // - Removed 'price_change' (unused - just logs for debugging)
    // - Removed 'last_trade_price' (tick handler no longer processes microstructure signals)
    // - Kept 'book' (critical for microstructure leak detection)
    // This reduces WebSocket subscriptions by 66% (3 → 1 per market)
    const subscribeMessage = {
      subscriptions: [
        {
          topic: 'clob_market',
          type: 'book',
          filters: [marketId]
        }
      ]
    };

    this.sendMessage(subscribeMessage);
    this.subscribedMarkets.add(marketId);
    
    logger.debug(`Subscribed to market: ${marketId}`);
  }

  unsubscribeFromMarket(marketId: string): void {
    if (!this.isConnected) return;

    // Polymarket Real-Time Data Service unsubscription format
    // Only unsubscribe from orderbook data (matching subscribe optimization)
    const unsubscribeMessage = {
      unsubscriptions: [
        {
          topic: 'clob_market',
          type: 'book',
          filters: [marketId]
        }
      ]
    };

    this.sendMessage(unsubscribeMessage);
    this.subscribedMarkets.delete(marketId);
    
    logger.debug(`Unsubscribed from market: ${marketId}`);
  }

  // Event handler setters
  onTick(handler: (tick: TickData) => void): void {
    this.onTickHandler = handler;
  }

  onOrderbook(handler: (orderbook: OrderbookData) => void): void {
    this.onOrderbookHandler = handler;
  }

  onConnection(handler: (connected: boolean) => void): void {
    this.onConnectionHandler = handler;
  }

  isWebSocketConnected(): boolean {
    return this.isConnected;
  }

  getSubscribedMarkets(): string[] {
    return Array.from(this.subscribedMarkets);
  }

  // Test connection without subscribing to anything
  async testConnection(): Promise<boolean> {
    try {
      if (this.isConnected) return true;
      
      await this.connect();
      return this.isConnected;
    } catch (error) {
      logger.error('WebSocket connection test failed:', error);
      return false;
    }
  }

  private buildWebSocketUrl(): string {
    // Official Polymarket Real-Time Data WebSocket endpoint (public, no auth required)
    return 'wss://ws-live-data.polymarket.com';
  }

  private handleMessage(data: WebSocket.Data): void {
    try {
      // Rate limiting check
      const now = Date.now();
      if (now - this.messageWindow > 1000) {
        // Reset window
        this.messageWindow = now;
        this.messageCount = 0;
      }
      this.messageCount++;
      if (this.messageCount > this.MAX_MESSAGES_PER_SECOND) {
        logger.warn('WebSocket message rate limit exceeded, dropping message');
        return;
      }

      const rawData = data.toString();

      // Enhanced validation
      if (!rawData) {
        logger.warn('Invalid WebSocket message: empty');
        return;
      }

      if (rawData.length > this.MAX_MESSAGE_SIZE) {
        logger.warn(`Invalid WebSocket message: too large (${rawData.length} bytes)`);
        return;
      }

      const message = JSON.parse(rawData);

      // Log all messages for debugging (first 200 chars)
      logger.debug(`📨 WS Message: ${rawData.substring(0, 200)}${rawData.length > 200 ? '...' : ''}`);

      // Enhanced validation - must be an object with a type/channel
      if (!message || typeof message !== 'object') {
        logger.warn('Invalid WebSocket message: not an object');
        return;
      }

      // Prevent prototype pollution
      if (Object.prototype.hasOwnProperty.call(message, '__proto__') ||
          Object.prototype.hasOwnProperty.call(message, 'constructor') ||
          Object.prototype.hasOwnProperty.call(message, 'prototype')) {
        logger.warn('Invalid WebSocket message: attempted prototype pollution');
        return;
      }

      // Polymarket Real-Time Data Service message format
      if (message.topic && message.type) {
        // Handle subscription confirmations
        if (message.type === 'subscribed' || message.type === 'unsubscribed') {
          this.handleSubscriptionMessage(message);
          return;
        }
        
        // Handle market data messages
        if (message.topic === 'clob_market') {
          switch (message.type) {
            case 'last_trade_price':
              this.handleTradeMessage(message);
              break;
            case 'book':
              this.handleOrderbookMessage(message);
              break;
            case 'price_change':
              this.handlePriceChangeMessage(message);
              break;
            default:
              logger.debug('Unknown clob_market message type:', message.type);
          }
        }
      } else {
        // Fallback for other message formats
        const messageType = message.type || message.channel;
        if (messageType) {
          switch (messageType) {
            case 'error':
              this.handleErrorMessage(message);
              break;
            default:
              logger.debug('Unknown message format:', message);
          }
        }
      }
    } catch (error) {
      logger.error('Error parsing WebSocket message:', error);
      // Don't crash the connection for parsing errors
    }
  }

  private handleTradeMessage(message: any): void {
    if (!this.onTickHandler) return;

    try {
      // Polymarket Real-Time Data Service format
      const data = message.data || message;
      
      // Basic validation for required trade fields
      if (!data.price || (!data.market && !data.asset_id)) {
        logger.warn('Invalid trade message: missing required fields', data);
        return;
      }

      const price = parseFloat(data.price);
      const size = parseFloat(data.trade_size || data.size || '0');
      const volume = size; // In Real-Time service, trade_size is the actual size

      // Validate parsed numbers
      if (isNaN(price) || price <= 0 || isNaN(size)) {
        logger.warn('Invalid trade message: invalid numeric values', data);
        return;
      }

      // Transform Polymarket trade data to our TickData format
      const tick: TickData = {
        timestamp: data.timestamp ? new Date(data.timestamp).getTime() : Date.now(),
        marketId: data.market || data.asset_id,
        price,
        volume,
        side: data.side === 'buy' ? 'buy' : 'sell',
        size,
      };

      logger.debug(`Trade received: ${tick.marketId.substring(0, 8)}... $${tick.price} size:${tick.size}`);
      this.onTickHandler(tick);
    } catch (error) {
      logger.error('Error processing trade message:', error);
    }
  }

  private handleOrderbookMessage(message: any): void {
    if (!this.onOrderbookHandler) return;

    try {
      // Polymarket Real-Time Data Service format
      const data = message.data || message;
      
      // Basic validation for orderbook message
      if (!data.market && !data.asset_id) {
        logger.warn('Invalid orderbook message: missing market identifier', data);
        return;
      }

      // Ensure bids and asks are arrays and validate size
      const rawBids = Array.isArray(data.buy) ? data.buy : Array.isArray(data.bids) ? data.bids : [];
      const rawAsks = Array.isArray(data.sell) ? data.sell : Array.isArray(data.asks) ? data.asks : [];

      // Validate orderbook size to prevent DoS
      if (rawBids.length > this.MAX_ORDERBOOK_LEVELS) {
        logger.warn(`Orderbook bids exceed limit: ${rawBids.length}`);
        rawBids.length = this.MAX_ORDERBOOK_LEVELS; // Truncate
      }
      if (rawAsks.length > this.MAX_ORDERBOOK_LEVELS) {
        logger.warn(`Orderbook asks exceed limit: ${rawAsks.length}`);
        rawAsks.length = this.MAX_ORDERBOOK_LEVELS; // Truncate
      }

      // Transform and validate bid/ask data
      const bids: OrderbookLevel[] = rawBids
        .map((bid: any) => {
          const price = parseFloat(bid.price || bid[0]);
          const size = parseFloat(bid.size || bid[1]);
          
          if (isNaN(price) || isNaN(size) || price <= 0 || size <= 0) {
            return null; // Skip invalid entries
          }
          
          return {
            price,
            size,
            volume: price * size,
          };
        })
        .filter((bid: any) => bid !== null)
        .sort((a: OrderbookLevel, b: OrderbookLevel) => b.price - a.price); // Sort bids descending

      const asks: OrderbookLevel[] = rawAsks
        .map((ask: any) => {
          const price = parseFloat(ask.price || ask[0]);
          const size = parseFloat(ask.size || ask[1]);
          
          if (isNaN(price) || isNaN(size) || price <= 0 || size <= 0) {
            return null; // Skip invalid entries
          }
          
          return {
            price,
            size,
            volume: price * size,
          };
        })
        .filter((ask: any) => ask !== null)
        .sort((a: OrderbookLevel, b: OrderbookLevel) => a.price - b.price); // Sort asks ascending

      const bestBid = bids.length > 0 ? bids[0].price : 0;
      const bestAsk = asks.length > 0 ? asks[0].price : 0;
      const spread = bestAsk > 0 && bestBid > 0 ? bestAsk - bestBid : 0;
      const midPrice = bestAsk > 0 && bestBid > 0 ? (bestAsk + bestBid) / 2 : 0;

      const orderbook: OrderbookData = {
        marketId: data.market || data.asset_id,
        timestamp: data.timestamp ? new Date(data.timestamp).getTime() : Date.now(),
        bids,
        asks,
        spread,
        midPrice,
        bestBid,
        bestAsk,
      };

      logger.debug(`Orderbook received: ${orderbook.marketId.substring(0, 8)}... ${bids.length} bids, ${asks.length} asks, spread: ${spread.toFixed(4)}`);
      this.onOrderbookHandler(orderbook);
    } catch (error) {
      logger.error('Error processing orderbook message:', error);
    }
  }

  private handleSubscriptionMessage(message: any): void {
    if (message.type === 'subscribed') {
      logger.info(`✅ Successfully subscribed to ${message.topic}:${message.message_type || 'all'}`);
    } else if (message.type === 'unsubscribed') {
      logger.info(`❌ Successfully unsubscribed from ${message.topic}:${message.message_type || 'all'}`);
    } else if (message.error) {
      logger.error(`Subscription error: ${message.error}`, message);
    }
  }

  private handlePriceChangeMessage(message: any): void {
    // Price change messages can be used for additional market monitoring
    // but for now we'll just log them for debugging
    const data = message.data || message;
    logger.debug(`Price change: ${(data.market || data.asset_id || 'unknown').substring(0, 8)}...`);
  }

  private handleErrorMessage(message: any): void {
    logger.error('WebSocket error message:', message);
  }

  private sendMessage(message: any): void {
    if (!this.ws || !this.isConnected) {
      logger.warn('Cannot send message - WebSocket not connected');
      return;
    }

    try {
      this.ws.send(JSON.stringify(message));
    } catch (error) {
      logger.error('Error sending WebSocket message:', error);
    }
  }

  private resubscribeToMarkets(): void {
    // Create a copy of the set to avoid modifying while iterating
    const marketsToResubscribe = Array.from(this.subscribedMarkets);

    // Clear the set before resubscribing (subscribeToMarket will add them back)
    this.subscribedMarkets.clear();

    // Resubscribe to all markets (subscribeToMarket adds to subscribedMarkets internally)
    for (const marketId of marketsToResubscribe) {
      try {
        this.subscribeToMarket(marketId);
      } catch (error) {
        logger.error(`Failed to resubscribe to market ${marketId}:`, error);
        // Don't add failed subscriptions back to the set
      }
    }

    logger.info(`Resubscribed to ${this.subscribedMarkets.size}/${marketsToResubscribe.length} markets`);
  }

  private handleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('Max reconnect attempts reached');
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000); // Exponential backoff, max 30s
    this.reconnectAttempts++;

    logger.info(`Attempting to reconnect in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch (error) {
        logger.error('Reconnection failed:', error);
      }
    }, delay);
  }
}