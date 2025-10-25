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
  metadata?: {
    assetIds?: string[];
    conditionId?: string;
    [key: string]: any;
  };

  // Category detection metadata
  category?: string;           // 'earnings', 'politics', 'fed', etc.
  categoryScore?: number;      // Confidence in category assignment (0-10+)
  isBlacklisted?: boolean;     // True if market matches blacklist patterns

  // Market characteristics for filtering
  outcomeCount?: number;       // Number of outcomes (2, 5, 10, etc.)
  spread?: number;             // Spread in basis points
  marketAge?: number;          // Milliseconds since market creation
  timeToClose?: number;        // Milliseconds until market closes

  // Two-tier monitoring system
  tier?: MarketTier;           // ACTIVE, WATCHLIST, or IGNORED
  tierReason?: string;         // Why this tier was assigned
  tierPriority?: number;       // Priority within tier (higher = more important)
  tierUpdatedAt?: number;      // When tier was last updated
}

export interface EarlySignal {
  marketId: string;
  market: Market;
  signalType: 'new_market' | 'volume_spike' | 'price_movement' | 'unusual_activity' | 'orderbook_imbalance' | 'spread_anomaly' | 'market_maker_withdrawal' | 'liquidity_shift' | 'aggressive_buyer' | 'aggressive_seller' | 'iceberg_detected' | 'wall_break' | 'liquidity_vacuum' | 'smart_money' | 'stop_hunt' | 'information_leak' | 'coordinated_cross_market' | 'off_hours_anomaly' | 'stealth_accumulation' | 'micro_price_drift' | 'front_running_detected';
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
  prices: number[]; // Store current prices for next comparison
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

export interface MicrostructureSignal {
  type: 'orderbook_imbalance' | 'spread_anomaly' | 'market_maker_withdrawal' | 'liquidity_shift';
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
  type: 'urgent' | 'price_action' | 'liquidity' | 'new_opportunity' | 'flash_move' | 'order_flow' | 'information_leak';
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

// New interfaces for information leakage detection
export interface EnhancedMicrostructureMetrics {
  marketId: string;
  timestamp: number;
  
  // Depth metrics
  depth1Bid: number;
  depth1Ask: number;
  depth1Total: number;
  depth1Change: number;
  depth1Baseline: number;
  
  // Micro-price calculation
  microPrice: number;
  microPriceSlope: number;
  microPriceDrift: number;
  
  // Advanced orderbook metrics
  orderBookImbalance: number;
  spreadBps: number;
  spreadChange: number;
  liquidityVacuum: boolean;
  
  // Z-scores for anomaly detection
  volumeZScore: number;
  depthZScore: number;
  spreadZScore: number;
  imbalanceZScore: number;
  
  // Time-based baselines
  timeOfDayBaseline: {
    volume: number;
    depth: number;
    spread: number;
    imbalance: number;
  };
}

export interface LeakDetectionSignal {
  type: 'liquidity_vacuum' | 'coordinated_cross_market' | 'off_hours_anomaly' | 'stealth_accumulation' | 'micro_price_drift';
  marketId: string;
  timestamp: number;
  confidence: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  
  // Leak-specific metadata
  leakMetadata: {
    topicCluster?: string;
    correlatedMarkets?: string[];
    timeToNews?: number; // Predicted time until news breaks (in minutes)
    frontRunScore?: number; // Heuristic score for front-running probability
    crossMarketConfirmation?: boolean;
    offHoursFlag?: boolean;
    liquidityDrop?: number;
    microPriceDrift?: number;
  };
  
  data: {
    current: number;
    baseline: number;
    change: number;
    zScore: number;
    context?: Record<string, any>;
  };
}

export interface CrossMarketCorrelation {
  market1Id: string;
  market2Id: string;
  correlation: number;
  timeWindow: number;
  significance: number;
  lastUpdated: number;
}

export interface AnomalyScore {
  marketId: string;
  timestamp: number;

  // Individual feature scores
  volumeAnomaly: number;
  depthAnomaly: number;
  spreadAnomaly: number;
  imbalanceAnomaly: number;
  priceAnomaly: number;

  // Combined anomaly scores
  mahalanobisDistance: number;
  isolationForestScore: number;
  combinedScore: number;

  // Classification
  isAnomalous: boolean;
  anomalyType: string[];
  confidence: number;
}

export interface MarketClassification {
  marketId: string;
  isEventBased: boolean;
  isTrendBased: boolean;
  score: number;
  confidence: number;
  reasons: string[];
  marketType?: 'earnings' | 'election' | 'sports' | 'legal' | 'political' | 'news' | 'crypto-price' | 'general';
  daysToResolution?: number;
  resolutionDate?: Date;
}

export interface MarketFilterConfig {
  enabled: boolean;
  maxDaysToResolution: number;
  minDaysToResolution: number;
  trendBasedPatterns: string[];
  eventBasedKeywords: string[];
  excludeTags: string[];
  includeTags: string[];
  requireEventDate: boolean;
  scoreThreshold: number;
}

// Market tier for two-tier monitoring system
export enum MarketTier {
  ACTIVE = 'active',        // Full real-time monitoring
  WATCHLIST = 'watchlist',  // Periodic monitoring for low-volume opportunities
  IGNORED = 'ignored'       // Not tracked
}

// Alert priority levels for signal filtering
export enum AlertPriority {
  CRITICAL = 'critical',  // Top opportunities, @everyone alert
  HIGH = 'high',          // Strong signals, regular alert
  MEDIUM = 'medium',      // Standard signals, quiet alert
  LOW = 'low'             // Informational only
}