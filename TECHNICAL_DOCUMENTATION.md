# Polymarket Microstructure Trading Bot - Technical Documentation

## Executive Summary

The Polymarket Microstructure Trading Bot is an advanced market intelligence system that monitors prediction markets on Polymarket to detect early trading signals and potential information leaks. The bot analyzes real-time orderbook data, trading patterns, and cross-market correlations to identify opportunities before they become widely known.

**Core Capabilities:**
- Real-time monitoring of 50-500 high-volume prediction markets
- Microstructure analysis of orderbook depth, spread, and imbalances
- Multi-signal detection (volume spikes, price movements, unusual activity)
- Information leak detection through cross-market correlation
- Front-running detection and market manipulation identification
- Discord alerts for high-confidence trading opportunities

---

## Architecture Overview

### System Components

```
┌─────────────────────────────────────────────────────────────┐
│                         EarlyBot                            │
│                   (Main Orchestrator)                       │
└──────────────┬─────────────────────────────────┬────────────┘
               │                                 │
       ┌───────▼──────────┐           ┌─────────▼─────────────┐
       │ Polymarket       │           │ Microstructure        │
       │ Service          │           │ Detector              │
       │                  │           │                       │
       │ - API Polling    │           │ - WebSocket Streams   │
       │ - Market Sync    │           │ - Orderbook Analysis  │
       │ - Market Filter  │           │ - Real-time Signals   │
       └───────┬──────────┘           └─────────┬─────────────┘
               │                                 │
       ┌───────▼──────────┐           ┌─────────▼─────────────┐
       │ Signal Detector  │           │ Analyzers             │
       │                  │           │                       │
       │ - Volume Spikes  │           │ - OrderbookAnalyzer   │
       │ - Price Moves    │           │ - OrderFlowAnalyzer   │
       │ - New Markets    │           │ - FrontRunning Engine │
       │ - Activity Score │           │ - Enhanced Metrics    │
       └───────┬──────────┘           └─────────┬─────────────┘
               │                                 │
               └──────────────┬──────────────────┘
                              │
                    ┌─────────▼──────────┐
                    │ Discord Alerter    │
                    │ Database Layer     │
                    │ Health Monitor     │
                    │ Metrics Collector  │
                    └────────────────────┘
```

### Core Services

1. **EarlyBot** (`src/bot/EarlyBot.ts`)
   - Main orchestrator and entry point
   - Manages lifecycle and periodic operations
   - Coordinates all services
   - Handles configuration updates at runtime

2. **EnhancedPolymarketService** (`src/services/EnhancedPolymarketService.ts`)
   - Fetches markets from Polymarket API
   - Syncs market data to PostgreSQL database
   - Filters markets using MarketClassifier
   - Manages rate limiting (20 req/min to Polymarket API)

3. **MarketClassifier** (`src/services/MarketClassifier.ts`)
   - Filters out trend-based markets (e.g., "Will Bitcoin hit $100k in 2025?")
   - Focuses on event-based markets (e.g., "Will Trump win Iowa primary?")
   - Scoring algorithm: time-based (30%), pattern-based (40%), tag-based (20%), type detection (10%)

4. **SignalDetector** (`src/services/SignalDetector.ts`)
   - Detects signals from market snapshots (polled every 5 minutes)
   - Tracks historical metrics for each market
   - Implements statistical anomaly detection
   - Memory-safe with LRU eviction (max 200 markets, 2880 history points)

5. **MicrostructureDetector** (`src/services/MicrostructureDetector.ts`)
   - Manages WebSocket connections for real-time data
   - Processes orderbook updates
   - Detects microstructure signals
   - Coordinates multiple analysis engines

6. **OrderbookAnalyzer** (`src/services/OrderbookAnalyzer.ts`)
   - Analyzes bid/ask imbalances
   - Detects spread anomalies
   - Identifies liquidity shifts
   - Tracks market maker behavior

7. **DiscordAlerter** (`src/services/DiscordAlerter.ts`)
   - Sends rich embed alerts to Discord webhook
   - Rate-limited to prevent spam
   - Different alert types by signal severity

---

## Data Flow

### Market Discovery and Filtering

**Step 1: API Polling (Every 5 minutes)**
```
Polymarket API
   │
   ├─► getActiveMarkets() → ~500 markets
   │
   ├─► Filter by volume > $10,000
   │
   ├─► MarketClassifier.filterMarkets()
   │   │
   │   ├─► Score each market (event-based vs trend-based)
   │   ├─► Time scoring: 1-90 days to resolution = good
   │   ├─► Pattern matching: "earnings", "election", "win game" = good
   │   ├─► Pattern matching: "hit $X by 2025" = bad (trend-based)
   │   └─► Keep only markets with score >= 0.6
   │
   └─► Result: ~50-100 event-based markets
```

**Market Classification Algorithm:**
- **Time Score (30% weight):**
  - 1-30 days to resolution: +0.3
  - 31-60 days: +0.2
  - 61-90 days: +0.1
  - >90 days or no date: -0.3

- **Pattern Score (40% weight):**
  - Event keywords ("earnings", "election", "primary"): +0.4
  - Trend patterns ("hit $X", "reach $X by 202X"): -0.4

- **Tag Score (20% weight):**
  - Include tags (earnings, elections, sports): +0.2
  - Exclude tags (long-term, crypto-price): -0.2

- **Type Score (10% weight):**
  - Specific event types: +0.1

**Final Classification:**
- Score >= 0.6: Event-based (track)
- Score < 0: Trend-based (filter out)

### Real-Time Data Streaming

**Step 2: WebSocket Subscriptions**
```
Market Filtered Markets (50-100)
   │
   ├─► Extract assetIds from market metadata
   │
   ├─► WebSocketService.subscribeToMarket(assetId)
   │   │
   │   ├─► wss://ws-subscriptions-clob.polymarket.com
   │   ├─► Subscribe to book updates for each asset
   │   └─► Subscribe to trade updates
   │
   └─► Real-time orderbook snapshots (continuous stream)
```

**WebSocket Message Types:**
1. **Book Updates** - Orderbook depth changes
2. **Trade Updates** - Executed trades with price, size, side
3. **Price Updates** - Current market price

### Signal Detection Pipeline

**Step 3: Multi-Layer Signal Detection**
```
Market Data Input
   │
   ├─► Snapshot-Based Signals (every 5 min)
   │   │
   │   ├─► SignalDetector.detectSignals()
   │   ├─► Compare current vs historical metrics
   │   ├─► Detect: volume_spike, price_movement, new_market, unusual_activity
   │   └─► Output: EarlySignal[]
   │
   └─► Real-Time Microstructure Signals (WebSocket stream)
       │
       ├─► OrderbookAnalyzer.detectOrderbookSignals()
       ├─► Detect: orderbook_imbalance, spread_anomaly, liquidity_shift
       │
       ├─► EnhancedMicrostructureAnalyzer.detectLeakSignals()
       ├─► Detect: liquidity_vacuum, micro_price_drift, stealth_accumulation
       │
       ├─► FrontRunningHeuristicEngine.detectFrontRunning()
       ├─► Detect: front_running_detected, stop_hunt, smart_money
       │
       └─► Output: MicrostructureSignal[]
```

---

## Signal Types and Detection Logic

### 1. Snapshot-Based Signals (Polled Data)

#### A. New Market Detection
**Source:** `SignalDetector.detectNewMarket()`

**Logic:**
```typescript
if (market.createdAt > 1 hour ago) {
  if (market.volume > minVolumeThreshold * 2) {
    return {
      signalType: 'new_market',
      confidence: 0.8,
      metadata: {
        timeSinceCreation: timestamp - createdTime,
        initialVolume: market.volumeNum
      }
    }
  }
}
```

**What it tracks:**
- Markets created in the last hour
- Initial volume must exceed 2x minimum threshold ($20k)
- Confidence: Fixed at 0.8

**Use case:** New markets often represent breaking news or sudden events

---

#### B. Volume Spike Detection
**Source:** `SignalDetector.detectVolumeSpike()`

**Logic:**
```typescript
// Calculate recent volume changes (last 5 data points)
recentVolumeChanges = history.slice(-5).map(m => m.volumeChange)
avgVolumeChange = average(recentVolumeChanges)

// Detect spike
if (currentVolumeChange > 0 &&
    currentVolumeChange > avgVolumeChange * 3.0 &&  // 3x multiplier
    currentVolumeChange > 25%) {                    // Minimum 25% increase
  return {
    signalType: 'volume_spike',
    confidence: calculateStatisticalConfidence(...),
    metadata: {
      currentVolume: market.volumeNum,
      volumeChangePercent: currentVolumeChange,
      spikeMultiplier: currentVolumeChange / avgVolumeChange
    }
  }
}
```

**What it tracks:**
- Percentage increase in 24h volume
- Compares to 5-period rolling average
- Must be 3x average AND >25% absolute increase
- ONLY positive changes (increases only)

**Statistical Confidence Calculation:**
- Z-score based on standard error estimate
- Higher spike multiplier = higher confidence
- Typical range: 0.7-0.95

**Example:**
- Market volume: $50k → $100k (100% increase)
- Recent average increase: 15%
- Spike multiplier: 100% / 15% = 6.67x
- **Signal triggered** with confidence ~0.9

---

#### C. Price Movement Detection
**Source:** `SignalDetector.detectPriceMovement()`

**Logic:**
```typescript
// Calculate price changes for each outcome
for (let i = 0; i < currentPrices.length; i++) {
  priceChange[i] = currentPrices[i] - previousPrices[i]
}

// Detect significant movement
if (abs(maxPriceChange) > 15%) {  // 15 percentage points
  return {
    signalType: 'price_movement',
    confidence: min(abs(maxPriceChange) / 50, 0.95),
    metadata: {
      outcome: outcomes[maxChangeIndex],
      priceChange: maxPriceChange,
      newPrice: currentPrices[maxChangeIndex],
      previousPrice: previousPrices[maxChangeIndex]
    }
  }
}
```

**What it tracks:**
- Absolute percentage point changes in outcome prices
- Threshold: 15 percentage points
- Tracks which outcome moved (Yes/No)

**Confidence Calculation:**
- Larger moves = higher confidence
- Formula: `min(|priceChange| / 50%, 0.95)`
- Examples:
  - 15% move → 0.30 confidence
  - 25% move → 0.50 confidence
  - 50% move → 0.95 confidence (capped)

**Example:**
- "Will Trump win Iowa primary?"
- Price: 65% → 85% (YES outcome)
- Change: +20 percentage points
- **Signal triggered** with confidence 0.40

---

#### D. Unusual Activity Detection
**Source:** `SignalDetector.detectUnusualActivity()`

**Logic:**
```typescript
// Calculate activity score
activityScore = calculateActivityScore(market, previousMetrics)
// Based on: volume velocity, price volatility, spread tightening

// Build activity distribution for percentile ranking
activityDistribution = historicalActivityScores

// Calculate percentile
percentile = calculatePercentile(activityScore, activityDistribution)

// Detect unusual activity
if (percentile > 95) {  // Top 5% of activity
  return {
    signalType: 'unusual_activity',
    confidence: (percentile - 90) / 10,  // 0.5-1.0 range
    metadata: {
      activityScore: activityScore,
      percentile: percentile,
      volumeVelocity: volumeChange / timeElapsed,
      priceVolatility: calculateVolatility(prices)
    }
  }
}
```

**What it tracks:**
- Combined activity score (volume + price + spread)
- Percentile-based detection (top 5% = unusual)
- Adaptive to market conditions

**Activity Score Components:**
1. **Volume Velocity:** Rate of volume change over time
2. **Price Volatility:** Standard deviation of recent price changes
3. **Spread Competitiveness:** Bid-ask spread tightening
4. **Order Flow Intensity:** Number of trades per time unit

**Confidence Calculation:**
- 95th percentile → 0.50 confidence
- 99th percentile → 0.90 confidence
- 100th percentile → 1.00 confidence

---

### 2. Microstructure Signals (Real-Time WebSocket)

#### A. Orderbook Imbalance
**Source:** `OrderbookAnalyzer.detectOrderbookSignals()`

**Logic:**
```typescript
// Calculate bid/ask volumes
totalBidVolume = sum(orderbook.bids.map(b => b.size * b.price))
totalAskVolume = sum(orderbook.asks.map(a => a.size * a.price))

// Calculate imbalance ratio
bidAskRatio = totalBidVolume / totalAskVolume

// Detect extreme imbalance
if (bidAskRatio > 3.0 || bidAskRatio < 0.33) {
  return {
    type: 'orderbook_imbalance',
    confidence: calculateImbalanceConfidence(bidAskRatio),
    severity: bidAskRatio > 5.0 ? 'critical' : 'high',
    data: {
      current: bidAskRatio,
      baseline: 1.0,
      change: bidAskRatio - 1.0
    }
  }
}
```

**What it tracks:**
- Ratio of total bid liquidity to ask liquidity
- Imbalance >3:1 or <1:3 = signal
- Indicates buying or selling pressure

**Interpretation:**
- `bidAskRatio > 3.0`: Heavy buying pressure (bulls dominating)
- `bidAskRatio < 0.33`: Heavy selling pressure (bears dominating)
- `bidAskRatio ≈ 1.0`: Balanced market

**Example:**
- Total bid volume: $50,000
- Total ask volume: $10,000
- Ratio: 5.0 (5:1 bid dominance)
- **Bullish signal** - Strong buying interest

---

#### B. Spread Anomaly
**Source:** `OrderbookAnalyzer.detectSpreadAnomaly()`

**Logic:**
```typescript
// Calculate current spread
spread = (bestAsk - bestBid) / midPrice * 10000  // basis points

// Compare to historical baseline
spreadBaseline = calculateEMA(historicalSpreads, 20)
spreadChange = (spread - spreadBaseline) / spreadBaseline * 100

// Detect anomaly
if (spreadChange > 200%) {  // Spread widened 3x
  return {
    type: 'spread_anomaly',
    confidence: min(spreadChange / 500, 0.95),
    severity: spreadChange > 400% ? 'critical' : 'high',
    data: {
      current: spread,
      baseline: spreadBaseline,
      change: spreadChange
    }
  }
}
```

**What it tracks:**
- Bid-ask spread in basis points (bps)
- Sudden spread widening (>2x normal)
- Indicates market maker withdrawal or uncertainty

**Spread Interpretation:**
- Normal spread: 10-50 bps (0.1%-0.5%)
- Wide spread: >100 bps (>1%)
- Abnormal spread: >200 bps (>2%)

**Why it matters:**
- Wide spreads = low liquidity, high slippage
- Sudden widening = market makers pulling orders
- Often precedes large price moves or news

**Example:**
- Normal spread: 20 bps (0.2%)
- Current spread: 100 bps (1.0%)
- Change: 400% increase
- **Critical signal** - Market makers fleeing

---

#### C. Liquidity Vacuum
**Source:** `EnhancedMicrostructureAnalyzer.detectLeakSignals()`

**Logic:**
```typescript
// Calculate total depth at top of book
depth1Total = orderbook.bids[0].size + orderbook.asks[0].size

// Compare to baseline
depth1Baseline = calculateEMA(historicalDepth, 50)
depthDrop = (depth1Baseline - depth1Total) / depth1Baseline * 100

// Detect vacuum
if (depthDrop > 50%) {  // 50% depth reduction
  return {
    type: 'liquidity_vacuum',
    confidence: min(depthDrop / 80, 0.95),
    severity: depthDrop > 80% ? 'critical' : 'high',
    leakMetadata: {
      liquidityDrop: depthDrop,
      timeToNews: estimateNewsDelay(depthDrop)  // 5-30 minutes
    }
  }
}
```

**What it tracks:**
- Total liquidity at best bid/ask
- Sudden drops in available liquidity (>50%)
- **Strong indicator of information leak**

**Information Leak Theory:**
- Informed traders remove liquidity before news
- They don't want to be on wrong side when news breaks
- Vacuum appears 5-30 minutes before public announcement

**Example:**
- Normal depth: 10,000 shares at best bid/ask
- Current depth: 2,000 shares
- Drop: 80%
- **Critical leak signal** - News likely in 10-15 minutes

---

#### D. Front-Running Detection
**Source:** `FrontRunningHeuristicEngine.detectFrontRunning()`

**Logic:**
```typescript
// Track order flow pattern
orderPattern = analyzeRecentOrders(last100Orders)

// Detect suspicious patterns
hasLargeOrder = orderPattern.maxOrderSize > avgOrderSize * 10
hasPreemptiveOrders = orderPattern.smallOrdersBeforeLarge > 5
hasPriceImpact = priceChangeAroundLargeOrder > 5%

// Calculate front-running score
frontRunScore = 0
if (hasPreemptiveOrders) frontRunScore += 0.4
if (hasLargeOrder) frontRunScore += 0.3
if (hasPriceImpact) frontRunScore += 0.3

if (frontRunScore > 0.7) {
  return {
    type: 'front_running_detected',
    confidence: frontRunScore,
    severity: 'critical',
    leakMetadata: {
      frontRunScore: frontRunScore,
      largeOrderSize: maxOrderSize,
      priceImpact: priceChangeAroundLargeOrder
    }
  }
}
```

**What it tracks:**
- Small orders placed just before large orders
- Price impact around large orders
- Pattern of "test orders" followed by bulk orders

**Front-Running Pattern:**
1. Trader A places small test orders (100-500 shares)
2. Sees no resistance / good liquidity
3. Places large order (10,000+ shares)
4. Price moves significantly

**Detection Heuristics:**
- 5+ small orders within 1 minute before large order
- Large order >10x average order size
- Price impact >5% around large order
- All three = 90%+ confidence of front-running

**Example:**
- Time 10:00:00 - Buy 200 @ $0.65
- Time 10:00:15 - Buy 300 @ $0.65
- Time 10:00:30 - Buy 500 @ $0.66
- Time 10:01:00 - Buy 15,000 @ $0.67 ← Large order
- Time 10:01:30 - Price jumps to $0.75 (+12%)
- **Front-running detected** with 0.90 confidence

---

### 3. Advanced Signals

#### A. Micro-Price Drift
**Source:** `EnhancedMicrostructureAnalyzer.calculateMicroPrice()`

**Theory:**
Micro-price is a more accurate "true price" than mid-price, weighted by orderbook depth.

**Formula:**
```typescript
microPrice = (bidPrice * askVolume + askPrice * bidVolume) / (bidVolume + askVolume)
```

**Drift Detection:**
```typescript
// Calculate micro-price slope over time
microPriceSlope = linearRegression(recentMicroPrices).slope

// Detect drift
if (abs(microPriceSlope) > 0.001 && microPrice != midPrice) {
  drift = microPrice - midPrice

  if (abs(drift) > 0.01) {  // 1% drift
    return {
      type: 'micro_price_drift',
      confidence: min(abs(drift) * 50, 0.95),
      severity: abs(drift) > 0.02 ? 'high' : 'medium',
      leakMetadata: {
        microPriceDrift: drift,
        direction: drift > 0 ? 'bullish' : 'bearish'
      }
    }
  }
}
```

**What it tracks:**
- Divergence between micro-price and mid-price
- Persistent directional drift in micro-price
- **Indicates informed trading before price moves**

**Why it matters:**
- Micro-price leads mid-price by 30 seconds to 5 minutes
- Informed traders change orderbook depth, not just price
- Drift = institutional accumulation/distribution

**Example:**
- Mid-price: $0.70
- Micro-price: $0.73 (3% higher)
- **Bullish drift** - Smart money accumulating

---

#### B. Cross-Market Correlation
**Source:** `TopicClusteringEngine.detectCoordinatedMovements()`

**Logic:**
```typescript
// Group markets by entity (e.g., "Trump", "Apple", "Lakers")
entityClusters = clusterMarketsByEntity(markets)

// For each cluster with 2+ markets
for (cluster of entityClusters) {
  if (cluster.marketCount >= 2) {
    // Calculate price correlations
    priceChanges = cluster.markets.map(m => m.recentPriceChange)
    correlation = calculateCorrelation(priceChanges)

    // Detect coordinated movement
    if (correlation > 0.7 && allMovingSameDirection) {
      return {
        type: 'coordinated_cross_market',
        confidence: correlation,
        severity: correlation > 0.9 ? 'critical' : 'high',
        leakMetadata: {
          entityCluster: cluster.entity,
          correlatedMarkets: cluster.markets.map(m => m.id),
          correlationScore: correlation,
          marketCount: cluster.marketCount
        }
      }
    }
  }
}
```

**What it tracks:**
- Multiple markets about same entity moving together
- Correlation of price changes across markets
- **Strong indicator of leaked information**

**Example:**
Entity: "Apple"
- Market 1: "Will Apple beat earnings Q4 2024?" - Price: 60% → 85% (+25)
- Market 2: "Will Apple stock hit $200 by Dec 2024?" - Price: 40% → 65% (+25)
- Market 3: "Will Tim Cook announce new product?" - Price: 35% → 58% (+23)

- Correlation: 0.94
- All markets moving together
- **Critical leak signal** - Someone knows Apple will beat earnings

---

## Memory Management and Performance

### Memory Limits (src/services/SignalDetector.ts)

**Implemented Memory Safety:**
```typescript
MAX_MARKETS_IN_HISTORY = 200        // Limit total markets tracked
MAX_HISTORY_POINTS = 2880           // 24 hours at 30s intervals
MAX_SIGNALS_PER_MARKET = 100        // Limit signals stored per market
```

**LRU Eviction Strategy:**
When tracking new market and limit reached:
1. Find market with oldest last update timestamp
2. Remove from `marketHistory` Map
3. Remove associated signals from `recentSignals` Map
4. Add new market

**Memory Cleanup Intervals:**
- **Full cleanup:** Every 60 minutes
  - Remove stale markets not in active set
  - Trim history to MAX_HISTORY_POINTS
  - Clear old signals (>24 hours)

- **Quick cleanup:** Every 10 minutes
  - Remove signals older than deduplication window (30 minutes)

**Estimated Memory Usage:**
```
Per market tracked:
- History: 2880 points × 200 bytes = 576 KB
- Signals: 100 signals × 500 bytes = 50 KB
- Total per market: ~626 KB

Maximum with 200 markets:
- History: 200 × 576 KB = 115 MB
- Signals: 200 × 50 KB = 10 MB
- Total: ~125 MB for historical data
```

---

### Rate Limiting

**Polymarket API Rate Limits:**
- Configured: 20 requests per minute
- Implementation: Token bucket algorithm
- Automatic retry with exponential backoff

**Discord Webhook Rate Limits:**
- Configured: Max 5 alerts per hour
- Prevents alert fatigue
- High-confidence signals prioritized

**Database Write Optimization:**
- Batch writes (50 markets per batch)
- Only save prices if changed >0.01%
- Reduced writes by ~80% from initial implementation

---

## Alert System

### Discord Alert Types

**1. New Market Alert**
- Color: Blue (#3498db)
- Type: `new_opportunity`
- Includes: Market question, volume, creation time
- Confidence: 0.8 (fixed)

**2. Volume Spike Alert**
- Color: Orange (#e67e22)
- Type: `flash_move`
- Includes: Current volume, volume change %, spike multiplier
- Confidence: 0.7-0.95 (statistical)

**3. Price Movement Alert**
- Color: Red (#e74c3c)
- Type: `price_action`
- Includes: Outcome, price change, new price, previous price
- Confidence: 0.3-0.95 (scaled by magnitude)

**4. Orderbook Imbalance Alert**
- Color: Purple (#9b59b6)
- Type: `order_flow`
- Includes: Bid/ask ratio, direction, severity
- Confidence: 0.6-0.95 (based on imbalance magnitude)

**5. Information Leak Alert**
- Color: Dark Red (#c0392b)
- Type: `information_leak`
- Includes: Leak type, correlated markets, estimated news delay
- Confidence: 0.7-0.95 (based on signal strength)
- **Highest priority alerts**

---

## Database Schema

### Tables

**1. markets**
```sql
CREATE TABLE markets (
  id VARCHAR(255) PRIMARY KEY,
  question TEXT NOT NULL,
  description TEXT,
  outcomes JSONB,
  volume_num DECIMAL,
  active BOOLEAN,
  closed BOOLEAN,
  end_date TIMESTAMP,
  tags JSONB,
  created_at TIMESTAMP,
  updated_at TIMESTAMP,
  metadata JSONB,
  CONSTRAINT markets_pkey PRIMARY KEY (id)
);

CREATE INDEX idx_markets_volume ON markets(volume_num DESC);
CREATE INDEX idx_markets_active ON markets(active) WHERE active = true;
CREATE INDEX idx_markets_end_date ON markets(end_date);
```

**2. prices**
```sql
CREATE TABLE prices (
  id SERIAL PRIMARY KEY,
  market_id VARCHAR(255) REFERENCES markets(id),
  outcome_index INTEGER NOT NULL,
  price DECIMAL NOT NULL,
  volume DECIMAL,
  timestamp TIMESTAMP DEFAULT NOW(),
  CONSTRAINT prices_pkey PRIMARY KEY (id)
);

CREATE INDEX idx_prices_market_time ON prices(market_id, timestamp DESC);
CREATE INDEX idx_prices_timestamp ON prices(timestamp DESC);
```

**3. signals**
```sql
CREATE TABLE signals (
  id SERIAL PRIMARY KEY,
  market_id VARCHAR(255) REFERENCES markets(id),
  signal_type VARCHAR(100) NOT NULL,
  confidence DECIMAL NOT NULL,
  metadata JSONB,
  timestamp TIMESTAMP DEFAULT NOW(),
  CONSTRAINT signals_pkey PRIMARY KEY (id)
);

CREATE INDEX idx_signals_market ON signals(market_id);
CREATE INDEX idx_signals_type ON signals(signal_type);
CREATE INDEX idx_signals_timestamp ON signals(timestamp DESC);
CREATE INDEX idx_signals_confidence ON signals(confidence DESC);
```

**Database Optimizations:**
- Indexes on frequently queried columns
- LIMIT clauses on all queries (max 1000 rows)
- Batch inserts for prices (50 at a time)
- Conditional writes (only if data changed)

---

## Configuration Management

### Runtime Configuration (src/config/ConfigManager.ts)

**Configuration Hot-Reload:**
- Config stored in `config/detection-config.json`
- File watched for changes
- Updates applied without restart
- All services notified via event system

**Key Configuration Parameters:**

```json
{
  "detection": {
    "markets": {
      "minVolumeThreshold": 10000,      // $10k minimum volume
      "maxMarketsToTrack": 50,          // Track top 50 markets
      "refreshIntervalMs": 300000       // Poll every 5 minutes
    },
    "signals": {
      "volumeSpike": {
        "multiplier": 3.0,               // 3x average = spike
        "minPercentageIncrease": 25      // Minimum 25% increase
      },
      "priceMovement": {
        "percentageThreshold": 15        // 15% price move
      },
      "crossMarketCorrelation": {
        "correlationThreshold": 0.7,     // 0.7+ correlation
        "minMarkets": 2                  // Need 2+ correlated markets
      }
    },
    "microstructure": {
      "orderbookImbalance": {
        "threshold": 3.0                 // 3:1 bid/ask ratio
      },
      "liquidityVacuum": {
        "depthDropThreshold": 50         // 50% depth reduction
      },
      "frontRunning": {
        "spreadImpactThreshold": 200     // 2x spread widening
      }
    },
    "marketFiltering": {
      "enabled": true,
      "maxDaysToResolution": 90,
      "minDaysToResolution": 1,
      "scoreThreshold": 0.6              // 60% event-based score
    },
    "alerts": {
      "discordRateLimit": 5              // Max 5 alerts per hour
    }
  }
}
```

---

## Health Monitoring

### System Health Checks

**Components Monitored:**
1. **Database** (30s interval, critical)
   - Connection status
   - Query response time
   - Active connections

2. **Polymarket Service** (60s interval, non-critical)
   - API reachability
   - Last successful sync
   - Rate limit status

3. **Microstructure Detector** (45s interval, critical)
   - WebSocket connection status
   - Number of subscribed markets
   - Signal processing rate

4. **Memory** (30s interval, critical)
   - Heap usage
   - System memory percentage
   - Thresholds: 90% warning, 95% critical

5. **CPU** (30s interval, non-critical)
   - Load average (1, 5, 15 minutes)
   - CPU percentage
   - Thresholds: 80% warning, 90% critical

6. **Event Loop** (15s interval, critical)
   - Event loop lag in milliseconds
   - Thresholds: 100ms warning, 500ms critical

7. **Errors** (60s interval, non-critical)
   - Error rate (errors per hour)
   - Error types distribution
   - Circuit breaker states

### Health Scoring

**Overall Health Score (0-100):**
- 100 = Perfect health
- 70-99 = Degraded (warnings)
- 50-69 = Degraded (serious issues)
- 0-49 = Critical (immediate action required)

**Score Calculation:**
```typescript
// Average component scores
componentScores = [
  memoryComponent.score,    // 0-100
  cpuComponent.score,       // 0-100
  eventLoopComponent.score, // 0-100
  databaseComponent.score,  // 0-100
  errorComponent.score      // 0-100
]

healthScore = average(componentScores)

// Penalize for specific issues
if (anyComponentCritical) healthScore = min(healthScore, 49)
if (multipleComponentsDegraded) healthScore -= 20
```

**Current Status:**
- Score of 71 = Healthy with minor warnings
- Above critical threshold (50)
- Above warning threshold (70) by small margin
- **Not a concern** - system operating normally

---

## Performance Metrics

### API Call Optimization

**Before Optimizations:**
- `getMarketById()` called for every market every cycle
- ~500 markets × 12 cycles/hour = **6,000 API calls/hour**
- Exceeding rate limits (20/min = 1,200/hour)

**After Optimizations:**
- Cache market data in database
- Use `getActiveMarkets()` batch endpoint (1 call for all markets)
- Only call `getMarketById()` for new markets
- Result: ~**12 API calls/hour** (99.8% reduction)

### WebSocket Optimization

**Before:**
- Subscribe to all market IDs directly
- 500 subscriptions
- High bandwidth usage

**After:**
- Extract assetIds from market metadata
- Subscribe using assetIds (more reliable)
- Filter to top 50 markets only
- Result: **66% reduction** in subscriptions

### Database Query Optimization

**Before:**
- No indexes on frequently queried columns
- No LIMIT clauses
- Writing prices every sync even if unchanged

**After:**
- Added 8 strategic indexes
- LIMIT 1000 on all queries
- Only write prices if changed >0.01%
- Query performance: **10-100x faster**
- Write volume: **80% reduction**

---

## Deployment and Operations

### Environment Variables

**Required:**
```bash
# Polymarket API
CLOB_API_URL=https://clob.polymarket.com
GAMMA_API_URL=https://gamma-api.polymarket.com

# Database
DATABASE_URL=postgresql://user:pass@host:5432/dbname

# Discord
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...

# Logging
LOG_LEVEL=info
```

**Optional:**
```bash
# Configuration
CHECK_INTERVAL_MS=300000              # 5 minutes
MIN_VOLUME_THRESHOLD=10000            # $10k
MAX_MARKETS_TO_TRACK=50               # Top 50

# Discord
DISCORD_RICH_EMBEDS=true              # Enable rich formatting
```

### Startup Sequence

1. **Load Configuration**
   - Read `config/detection-config.json`
   - Validate environment variables
   - Initialize ConfigManager

2. **Initialize Database**
   - Connect to PostgreSQL
   - Run migrations if needed
   - Create tables and indexes

3. **Start Health Monitoring**
   - Register health checks
   - Start periodic checks (15s-60s intervals)
   - Initialize metrics collector

4. **Initialize Services**
   - EnhancedPolymarketService
   - SignalDetector
   - MicrostructureDetector
   - DiscordAlerter

5. **Connect WebSocket**
   - Connect to Polymarket WebSocket
   - Subscribe to initial markets
   - Set up reconnection logic

6. **Start Market Sync**
   - Initial market fetch and classification
   - Filter to event-based markets
   - Subscribe WebSocket to top markets
   - Start periodic refresh (5 minutes)

7. **Start Performance Reporting**
   - Report every 30 minutes to Discord
   - Include: signals detected, markets tracked, health status

### Graceful Shutdown

**Shutdown Sequence (Max 10 seconds):**
1. Stop accepting new signals
2. Clear periodic intervals
3. Disconnect WebSocket
4. Stop microstructure detector
5. Stop Polymarket service
6. Close database connections
7. Final health report
8. Exit

**Timeout Protection:**
- Force exit after 10 seconds if graceful shutdown fails
- Prevents hanging processes

---

## Error Handling and Resilience

### Circuit Breaker Pattern

**Implemented for:**
- Polymarket API calls
- Database operations
- Discord webhook calls

**Circuit States:**
1. **Closed** - Normal operation
2. **Open** - Too many failures, skip calls for cooldown period
3. **Half-Open** - Testing if service recovered

**Thresholds:**
- Open circuit after 5 consecutive failures
- Cooldown period: 60 seconds
- Test with single request in half-open state

### Retry Logic

**Exponential Backoff:**
```typescript
attempt 1: immediate
attempt 2: wait 2 seconds
attempt 3: wait 4 seconds
attempt 4: wait 8 seconds
attempt 5: fail permanently
```

**Applied to:**
- Database initialization (3 retries)
- API calls (2 retries)
- WebSocket reconnection (infinite with backoff)

### Fallback Strategies

**Polymarket API Failure:**
- Fall back to database cache
- Use last known market data
- Log warning but continue operation

**Discord Webhook Failure:**
- Save signal to database anyway
- Log error
- Continue processing (non-critical)

**Database Failure:**
- Circuit breaker prevents spam
- Cache signals in memory temporarily
- Retry on next cycle

---

## Security Considerations

### API Key Management

- No API keys required for Polymarket public endpoints
- Discord webhook URL stored in environment variable
- Database credentials in environment variables
- Never log sensitive credentials

### Rate Limiting

- Respect Polymarket rate limits (20 req/min)
- Implement client-side rate limiter
- Exponential backoff on 429 responses

### Data Validation

- Validate all API responses before processing
- Type checking with TypeScript interfaces
- SQL injection prevention (parameterized queries)
- XSS prevention in Discord embeds

### Error Information Disclosure

- Generic error messages in logs
- Detailed errors only in debug mode
- No sensitive data in Discord alerts
- Sanitize market questions before display

---

## Future Enhancements

### Planned Features

1. **Machine Learning Signal Scoring**
   - Train model on historical signals
   - Predict signal accuracy
   - Adaptive threshold tuning

2. **Backtesting Framework**
   - Replay historical data
   - Test signal strategies
   - Optimize parameters

3. **Multi-Exchange Support**
   - Kalshi integration
   - PredictIt support
   - Cross-exchange arbitrage detection

4. **Advanced Leak Detection**
   - Insider trading pattern recognition
   - Social media sentiment correlation
   - News event prediction

5. **Portfolio Management**
   - Automatic position sizing
   - Risk management
   - P&L tracking

---

## Troubleshooting

### Common Issues

**Issue: WebSocket keeps disconnecting**
- **Cause:** Network instability or Polymarket server issues
- **Solution:** Check logs for error messages, WebSocket auto-reconnects with exponential backoff
- **Prevention:** Implemented automatic reconnection logic

**Issue: Database connection timeout**
- **Cause:** Database server overloaded or network issues
- **Solution:** Check database logs, increase connection timeout
- **Prevention:** Connection pooling, circuit breaker pattern

**Issue: No signals detected**
- **Cause:** Markets too stable, or thresholds too high
- **Solution:** Check configuration, lower thresholds in `detection-config.json`
- **Monitoring:** Review detection stats in logs

**Issue: Memory usage growing**
- **Cause:** LRU eviction not working, memory leak
- **Solution:** Check market history size, restart bot
- **Prevention:** Implemented hard limits (200 markets, 2880 points)

**Issue: Rate limit exceeded**
- **Cause:** Too many API calls to Polymarket
- **Solution:** Increase `refreshIntervalMs` in config
- **Prevention:** Implemented rate limiter, reduced API calls by 99%

---

## Monitoring and Logs

### Log Levels

**ERROR:** Critical failures requiring immediate attention
- Database connection failed
- WebSocket unable to reconnect
- Discord alert failed

**WARN:** Non-critical issues that may need attention
- Market sync took longer than expected
- Rate limit approaching
- Configuration validation warnings

**INFO:** Normal operational messages
- Bot started/stopped
- Market sync completed
- Signal detected
- Health status changes

**DEBUG:** Detailed diagnostic information
- Individual market processing
- Orderbook updates
- Signal calculation details

### Key Log Messages

**Startup:**
```
[INFO] 🚀 Starting Poly Early Bot...
[INFO] Initializing database...
[INFO] WebSocket connected successfully
[INFO] ✅ Poly Early Bot is running
[INFO] Starting real-time microstructure detection
[INFO] Found 87 markets above volume threshold
```

**Market Sync:**
```
[INFO] 🔄 Scanning markets for opportunities
[INFO] Market sync completed: 500 processed, 5 new, 120 updated (3432ms)
[INFO] Markets filtered for event-based trading: 91 event-based, 409 trend-based filtered
```

**Signal Detection:**
```
[INFO] 🚨 VOLUME SPIKE: Will Trump win Iowa caucus? - 127.3% volume increase!
[INFO] 🚨 NEW MARKET: Will Apple beat earnings Q4 2024? - 15min old, $42,500 volume
[WARN] 🔔 Detected 3 signals in this scan
[INFO] ✅ Scan complete - no signals detected (markets are stable)
```

**Errors:**
```
[ERROR] 🚨 CRITICAL: Database connection failed
[ERROR] Error processing market 0x1234abcd: Timeout
[WARN] Discord webhook test failed after retries
```

---

## Contact and Support

### Development Team
- **Repository:** https://github.com/your-org/poly-market-micro-structure
- **Issues:** https://github.com/your-org/poly-market-micro-structure/issues

### Documentation
- **Technical Docs:** This file
- **Configuration Reference:** `config/README.md`
- **API Reference:** `docs/API.md`

---

**Document Version:** 1.0.0
**Last Updated:** 2025-10-22
**Bot Version:** 1.0.0
