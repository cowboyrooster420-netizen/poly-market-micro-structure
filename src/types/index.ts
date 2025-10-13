export interface Market {
  id: string;
  question: string;
  description?: string;
  outcomes: string[];
  outcomePrices: string[];
  volume: string;
  volumeNum: number;
  active: boolean;
  closed: boolean;
  endDate?: string;
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface EarlySignal {
  marketId: string;
  market: Market;
  signalType: 'new_market' | 'volume_spike' | 'price_movement' | 'unusual_activity' | 'orderbook_imbalance' | 'spread_anomaly' | 'market_maker_withdrawal' | 'momentum_breakout' | 'liquidity_shift' | 'aggressive_buyer' | 'aggressive_seller' | 'iceberg_detected' | 'wall_break' | 'liquidity_vacuum' | 'smart_money' | 'stop_hunt';
  confidence: number;
  timestamp: number;
  metadata?: Record<string, any>;
}

export interface BotConfig {
  checkIntervalMs: number;
  minVolumeThreshold: number;
  maxMarketsToTrack: number;
  logLevel: string;
  apiUrls: {
    clob: string;
    gamma: string;
  };
  microstructure: {
    orderbookImbalanceThreshold: number;
    spreadAnomalyThreshold: number;
    liquidityShiftThreshold: number;
    momentumThreshold: number;
    tickBufferSize: number;
  };
  discord: {
    webhookUrl?: string;
    enableRichEmbeds: boolean;
    alertRateLimit: number;
  };
}

export interface MarketMetrics {
  marketId: string;
  volume24h: number;
  volumeChange: number;
  priceChange: Record<string, number>;
  activityScore: number;
  lastUpdated: number;
}

export interface TickData {
  timestamp: number;
  marketId: string;
  price: number;
  volume: number;
  side: 'buy' | 'sell';
  size: number;
}

export interface OrderbookLevel {
  price: number;
  size: number;
  volume: number;
}

export interface OrderbookData {
  marketId: string;
  timestamp: number;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  spread: number;
  midPrice: number;
  bestBid: number;
  bestAsk: number;
}

export interface OrderbookMetrics {
  marketId: string;
  timestamp: number;
  bidAskRatio: number;
  spreadPercent: number;
  totalBidVolume: number;
  totalAskVolume: number;
  depthImbalance: number;
  liquidityScore: number;
}

export interface TechnicalIndicators {
  marketId: string;
  timestamp: number;
  rsi: number;
  macd: {
    line: number;
    signal: number;
    histogram: number;
  };
  momentum: number;
  vwap: number;
  priceDeviation: number;
}

export interface MicrostructureSignal {
  type: 'orderbook_imbalance' | 'spread_anomaly' | 'market_maker_withdrawal' | 'momentum_breakout' | 'liquidity_shift';
  marketId: string;
  timestamp: number;
  confidence: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  data: {
    current: number;
    baseline: number;
    change: number;
    context?: Record<string, any>;
  };
}

export interface AlertMessage {
  type: 'urgent' | 'price_action' | 'liquidity' | 'new_opportunity' | 'flash_move' | 'order_flow';
  title: string;
  description: string;
  color: number;
  fields: Array<{
    name: string;
    value: string;
    inline?: boolean;
  }>;
  footer?: string;
  timestamp: number;
}