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

      this.ws.on('open', () => {
        this.isConnected = true;
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        logger.info('WebSocket connected successfully');
        
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
        this.isConnected = false;
        this.isConnecting = false;
        logger.warn(`WebSocket closed: ${code} - ${reason}`);
        
        if (this.onConnectionHandler) {
          this.onConnectionHandler(false);
        }

        this.handleReconnect();
      });

      this.ws.on('error', (error: Error) => {
        this.isConnecting = false;
        logger.error('WebSocket error:', error);
        reject(error);
      });

      // Timeout for connection
      setTimeout(() => {
        if (!this.isConnected && this.isConnecting) {
          this.isConnecting = false;
          reject(new Error('WebSocket connection timeout'));
        }
      }, 10000);
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

    const subscribeMessage = {
      type: 'subscribe',
      channel: 'trades',
      market: marketId,
    };

    const orderbookMessage = {
      type: 'subscribe',
      channel: 'book',
      market: marketId,
    };

    this.sendMessage(subscribeMessage);
    this.sendMessage(orderbookMessage);
    this.subscribedMarkets.add(marketId);
    
    logger.debug(`Subscribed to market: ${marketId}`);
  }

  unsubscribeFromMarket(marketId: string): void {
    if (!this.isConnected) return;

    const unsubscribeMessage = {
      type: 'unsubscribe',
      channel: 'trades',
      market: marketId,
    };

    const orderbookUnsubscribe = {
      type: 'unsubscribe',
      channel: 'book',
      market: marketId,
    };

    this.sendMessage(unsubscribeMessage);
    this.sendMessage(orderbookUnsubscribe);
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

  private buildWebSocketUrl(): string {
    // Official Polymarket CLOB WebSocket endpoint
    return 'wss://ws-subscriptions-clob.polymarket.com/ws/';
  }

  private handleMessage(data: WebSocket.Data): void {
    try {
      const rawData = data.toString();
      
      // Basic safety checks before parsing
      if (!rawData || rawData.length > 50000) { // 50KB limit
        logger.warn('Invalid WebSocket message: empty or too large');
        return;
      }

      const message = JSON.parse(rawData);
      
      // Basic validation - must be an object with a type/channel
      if (!message || typeof message !== 'object') {
        logger.warn('Invalid WebSocket message: not an object');
        return;
      }

      const messageType = message.type || message.channel;
      if (!messageType || typeof messageType !== 'string') {
        logger.warn('Invalid WebSocket message: missing or invalid type/channel');
        return;
      }
      
      switch (messageType) {
        case 'trade':
        case 'trades':
          this.handleTradeMessage(message);
          break;
        case 'book':
        case 'orderbook':
          this.handleOrderbookMessage(message);
          break;
        case 'subscription':
          this.handleSubscriptionMessage(message);
          break;
        case 'error':
          this.handleErrorMessage(message);
          break;
        default:
          logger.debug('Unknown message type:', messageType);
      }
    } catch (error) {
      logger.error('Error parsing WebSocket message:', error);
      // Don't crash the connection for parsing errors
    }
  }

  private handleTradeMessage(message: any): void {
    if (!this.onTickHandler) return;

    try {
      // Basic validation for required trade fields
      if (!message.price || !message.market && !message.asset_id) {
        logger.warn('Invalid trade message: missing required fields');
        return;
      }

      const price = parseFloat(message.price);
      const volume = parseFloat(message.size || message.volume || '0');
      const size = parseFloat(message.size || '0');

      // Validate parsed numbers
      if (isNaN(price) || price <= 0 || isNaN(volume) || isNaN(size)) {
        logger.warn('Invalid trade message: invalid numeric values');
        return;
      }

      // Transform Polymarket trade data to our TickData format
      const tick: TickData = {
        timestamp: message.timestamp || Date.now(),
        marketId: message.market || message.asset_id,
        price,
        volume,
        side: message.side === 'buy' ? 'buy' : 'sell',
        size,
      };

      this.onTickHandler(tick);
    } catch (error) {
      logger.error('Error processing trade message:', error);
    }
  }

  private handleOrderbookMessage(message: any): void {
    if (!this.onOrderbookHandler) return;

    try {
      // Basic validation for orderbook message
      if (!message.market && !message.asset_id) {
        logger.warn('Invalid orderbook message: missing market identifier');
        return;
      }

      // Ensure bids and asks are arrays
      const rawBids = Array.isArray(message.bids) ? message.bids : [];
      const rawAsks = Array.isArray(message.asks) ? message.asks : [];

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
        .filter((bid: any) => bid !== null); // Remove invalid entries

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
        .filter((ask: any) => ask !== null); // Remove invalid entries

      const bestBid = bids.length > 0 ? bids[0].price : 0;
      const bestAsk = asks.length > 0 ? asks[0].price : 0;
      const spread = bestAsk > 0 && bestBid > 0 ? bestAsk - bestBid : 0;
      const midPrice = bestAsk > 0 && bestBid > 0 ? (bestAsk + bestBid) / 2 : 0;

      const orderbook: OrderbookData = {
        marketId: message.market || message.asset_id,
        timestamp: message.timestamp || Date.now(),
        bids,
        asks,
        spread,
        midPrice,
        bestBid,
        bestAsk,
      };

      this.onOrderbookHandler(orderbook);
    } catch (error) {
      logger.error('Error processing orderbook message:', error);
    }
  }

  private handleSubscriptionMessage(message: any): void {
    if (message.status === 'subscribed') {
      logger.debug(`Successfully subscribed to ${message.channel} for ${message.market}`);
    } else if (message.status === 'error') {
      logger.error(`Subscription error: ${message.error}`);
    }
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
    
    // Clear the original set
    this.subscribedMarkets.clear();
    
    // Resubscribe to all markets
    for (const marketId of marketsToResubscribe) {
      this.subscribeToMarket(marketId);
    }
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

// Alternative HTTP-based real-time service for fallback
export class PollingService {
  private config: BotConfig;
  private intervals: Map<string, NodeJS.Timeout> = new Map();
  private onTickHandler: ((tick: TickData) => void) | null = null;
  private onOrderbookHandler: ((orderbook: OrderbookData) => void) | null = null;

  constructor(config: BotConfig) {
    this.config = config;
  }

  startPolling(marketIds: string[], intervalMs: number = 5000): void {
    for (const marketId of marketIds) {
      this.pollMarket(marketId, intervalMs);
    }
  }

  stopPolling(marketId?: string): void {
    if (marketId) {
      const interval = this.intervals.get(marketId);
      if (interval) {
        clearInterval(interval);
        this.intervals.delete(marketId);
      }
    } else {
      // Stop all polling
      for (const interval of this.intervals.values()) {
        clearInterval(interval);
      }
      this.intervals.clear();
    }
  }

  onTick(handler: (tick: TickData) => void): void {
    this.onTickHandler = handler;
  }

  onOrderbook(handler: (orderbook: OrderbookData) => void): void {
    this.onOrderbookHandler = handler;
  }

  private pollMarket(marketId: string, intervalMs: number): void {
    const interval = setInterval(async () => {
      try {
        await this.fetchMarketData(marketId);
      } catch (error) {
        logger.error(`Error polling market ${marketId}:`, error);
      }
    }, intervalMs);

    this.intervals.set(marketId, interval);
  }

  private async fetchMarketData(marketId: string): Promise<void> {
    // This would fetch from Polymarket REST API and convert to tick/orderbook data
    // Implementation would depend on available endpoints
    logger.debug(`Polling market data for ${marketId}`);
  }
}