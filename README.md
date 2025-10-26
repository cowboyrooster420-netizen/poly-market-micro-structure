# Poly Market Microstructure Bot

A sophisticated real-time detection system for identifying early opportunities and information leakage on Polymarket through advanced microstructure analysis, statistical modeling, and cross-market correlation.

## 🎯 What This Bot Does

This bot monitors Polymarket prediction markets in real-time to detect **information leakage** - moments when insider knowledge or sophisticated analysis appears in market microstructure before it becomes public. It uses advanced financial mathematics adapted specifically for prediction markets to identify:

- **Front-running patterns** through orderbook analysis
- **Information asymmetry** via liquidity shifts and spread compression
- **Cross-market correlations** suggesting coordinated knowledge
- **Market maker behavior changes** indicating impending news
- **Early momentum signals** before price movements become obvious

## 🚀 Core Capabilities

### **1. Advanced Microstructure Analysis**

#### Enhanced Orderbook Metrics
- **Depth-1 Analysis**: Real-time monitoring of best bid/ask levels
- **Imbalance Detection**: Identifies significant bid/ask ratio shifts
- **Spread Tracking**: Monitors bid-ask spread compression/expansion
- **Liquidity Vacuum Detection**: Spots sudden orderbook depth drops
- **Price Impact Calculation**: Measures expected vs. actual price movements

#### Statistical Modeling
- **Time-Adjusted Z-Scores**: Detects anomalies accounting for time-of-day patterns
- **Volatility Metrics**: Absolute probability change tracking (not price-relative)
- **Baseline Tracking**: Hourly patterns for volume, depth, spread, and imbalance
- **Outlier Detection**: Robust statistical methods resistant to data noise

### **2. Front-Running Heuristic Engine**

Proprietary detection algorithm that scores markets for information leakage:

```
Score = (Δmicroprice × Δvolume_weighted × liquidity_drop) / (spread_bps + ε)
```

**Components:**
- **Microprice Drift**: Distance between mid-price and volume-weighted price
- **Volume-Weighted Flow**: Order size distribution analysis
- **Liquidity Drop**: Reduction in market depth
- **Spread Context**: Tighter spreads amplify score
- **Off-Hours Multiplier**: Heightened sensitivity during low-activity periods
- **Topic Clustering**: Correlation with related markets

**Severity Levels:**
- 🔴 **CRITICAL** (>90%): Extremely high confidence of information leak
- 🟠 **HIGH** (>70%): Strong leak indicators
- 🟡 **MODERATE** (>50%): Notable microstructure anomalies
- 🔵 **LOW** (<50%): Weak signals for monitoring

### **3. Market Categorization & Opportunity Scoring**

#### Automated Category Detection
Markets are automatically classified into high-edge categories:
- **Earnings** (tech company results)
- **CEO Changes** (executive transitions)
- **Court Cases** (legal outcomes)
- **Pardons** (political pardons)
- **Mergers & Acquisitions**
- **Sports/Hollywood Awards**
- **Crypto Events**
- **Politics**, **Economic Data**, **Fed Decisions**

#### Opportunity Scoring (0-100)
Four-component scoring system:

**Volume Score (30%):** Market liquidity vs. category threshold
**Edge Score (25%):** Category edge potential + outcome complexity
**Catalyst Score (25%):** Time-to-resolution urgency
**Quality Score (20%):** Spread quality + market age + depth

Markets are ranked and prioritized based on total opportunity score.

### **4. Topic Clustering for Cross-Market Detection**

#### Entity & Event Extraction
- **NLP Processing**: Extracts entities (companies, people, events) from market questions
- **Clustering**: Groups related markets by topic/entity
- **Cross-Market Analysis**: Detects coordinated movements across related markets

#### Leak Types Detected
- **Front-Running**: Orderbook microstructure anomalies
- **Cross-Market**: Correlated movements in related markets
- **Topic Cluster**: Information spreading across entity clusters

### **5. Real-Time WebSocket Processing**

- **Sub-second Updates**: Live orderbook and trade data
- **Multi-Market Tracking**: Simultaneously monitors 100+ markets
- **Ring Buffer Storage**: High-performance tick data management (1000 ticks/market)
- **Efficient State Management**: Minimal memory footprint with cleanup routines

### **6. Mathematical Correctness for Prediction Markets**

**⚠️ Critical Innovation:** Traditional financial formulas don't work for prediction markets!

Prediction market prices are **probabilities (0-1)**, not unbounded financial prices. This bot uses **absolute probability mathematics**:

#### Fixed Biases:
1. ✅ **Spread Calculations**: Absolute basis points, not price-relative
2. ✅ **Price Impact**: Absolute probability change, not percentage
3. ✅ **Flow Pressure**: Size-only, not size × price
4. ✅ **Volatility**: Absolute changes, not log returns
5. ✅ **Signal Detection**: Percentage point changes, not percentages

**Example:** A 5¢ probability move is **5 percentage points** at any price level, not 5% of the current price.

## 📊 Signal Detection

### **Microstructure Signals**
1. **Orderbook Imbalance** - Bid/ask ratio >30% from baseline + volume confirmation
2. **Spread Anomaly** - Compression/expansion >2σ from hourly baseline
3. **Liquidity Vacuum** - Depth drop >30% with spread widening
4. **Momentum Breakout** - Multi-indicator technical confirmation
5. **Front-Running Alert** - High-confidence information leakage detected

### **Volume & Activity Signals**
1. **Volume Spike** - 1.2x baseline with confirmation
2. **Price Movement** - 3% absolute change with volume support
3. **Activity Score** - Combined volume and price change metrics
4. **Cross-Market Correlation** - Coordinated movements (>0.5 correlation, z>1.5)

### **Information Leakage Signals**
1. **Front-Running Heuristic** - Proprietary leak detection algorithm
2. **Topic Cluster Leak** - Coordinated movements in related markets
3. **Market Maker Behavior** - Liquidity withdrawal patterns

## 🏗️ Architecture

```
src/
├── bot/
│   └── EarlyBot.ts                          # Main orchestrator & coordinator
│
├── services/
│   ├── PolymarketService.ts                 # API interface & market caching
│   ├── EnhancedPolymarketService.ts         # Advanced market operations
│   ├── SignalDetector.ts                    # Signal detection & scoring
│   ├── MicrostructureDetector.ts            # Real-time microstructure monitoring
│   ├── EnhancedMicrostructureAnalyzer.ts    # Advanced orderbook analytics
│   ├── OrderbookAnalyzer.ts                 # Spread, depth, imbalance analysis
│   ├── OrderFlowAnalyzer.ts                 # Flow pressure & trade analysis
│   ├── FrontRunningHeuristicEngine.ts       # Information leak detection
│   ├── MarketCategorizer.ts                 # Category detection & scoring
│   ├── TopicClusteringEngine.ts             # NLP entity extraction & clustering
│   ├── SignalPerformanceTracker.ts          # Historical signal performance
│   ├── WebSocketService.ts                  # Real-time data streaming
│   └── DiscordAlerter.ts                    # Alert formatting & delivery
│
├── statistics/
│   └── StatisticalModels.ts                 # Time-series analysis & z-scores
│
├── utils/
│   ├── spreadHelpers.ts                     # Prediction market math utilities
│   ├── logger.ts                            # Structured logging
│   ├── AdvancedLogger.ts                    # Performance tracking
│   └── RateLimiter.ts                       # API rate limiting
│
├── monitoring/
│   ├── MetricsCollector.ts                  # Prometheus-style metrics
│   ├── HealthMonitor.ts                     # System health checks
│   └── ErrorHandler.ts                      # Resilient error handling
│
├── database/
│   ├── DatabaseManager.ts                   # SQLite connection management
│   └── DataAccessLayer.ts                   # Market data persistence
│
├── config/
│   └── ConfigManager.ts                     # Centralized configuration
│
└── types/
    └── index.ts                             # TypeScript interfaces
```

## 📈 Alert System

### **Discord Integration**
Rich embedded alerts with:
- **Market Details**: Question, outcomes, current prices
- **Signal Information**: Type, confidence, severity
- **Microstructure Metrics**: Spread (bps), imbalance, depth, flow
- **Opportunity Score**: Multi-component ranking (0-100)
- **Historical Performance**: Win rate and avg return for signal type
- **Leak Details**: Front-running components, correlation data

### **Alert Severity Mapping**
- 🔴 **CRITICAL** → Front-running score >90% or z-score >4
- 🟠 **HIGH** → Front-running score >70% or z-score >3
- 🟡 **MEDIUM** → Front-running score >50% or z-score >2
- ⚪ **LOW** → Monitoring signals, z-score >1.5

### **Rate Limiting**
Intelligent spam prevention:
- Critical: Max 10/hour, 30-min cooldown
- High: Max 20/hour, 60-min cooldown
- Medium: Max 50/hour, 120-min cooldown
- Low: Max 100/hour, 240-min cooldown

## 🧪 Testing

Comprehensive test suite with **122+ tests**:

```bash
# Run all tests
npm test

# Run specific test suites
npm test -- SpreadCalculations.test.ts
npm test -- PredictionMarketBiasFixes.test.ts
npm test -- QualityScoreImpact.test.ts

# Run with coverage
npm test -- --coverage
```

### **Test Coverage**
- ✅ Spread calculations at 10%, 50%, 90% probability levels
- ✅ Bias-free metrics across all price ranges
- ✅ Orderbook analysis edge cases
- ✅ Signal detection thresholds
- ✅ Statistical model robustness
- ✅ Quality score components
- ✅ Helper function correctness

## ⚙️ Configuration

### **Environment Variables**

```bash
# Core Settings
CHECK_INTERVAL_MS=30000           # Market refresh interval
MIN_VOLUME_THRESHOLD=10000        # Minimum volume to track
MAX_MARKETS_TO_TRACK=100          # Maximum concurrent markets
LOG_LEVEL=info                    # debug | info | warn | error

# API Configuration
POLYMARKET_API_URL=https://gamma-api.polymarket.com
POLYMARKET_CLOB_API_URL=https://clob.polymarket.com

# Discord Alerts
DISCORD_WEBHOOK_URL=your_webhook_url_here
DISCORD_ENABLE_RICH_EMBEDS=true
DISCORD_ALERT_RATE_LIMIT=10

# Database
DATABASE_PATH=./data/markets.db
ENABLE_MARKET_HISTORY=true

# WebSocket
WEBSOCKET_RECONNECT_INTERVAL=5000
WEBSOCKET_PING_INTERVAL=30000
```

### **Detection Configuration** (`config/detection-config.json`)

Highly configurable thresholds for:
- Market filtering criteria
- Volume thresholds by category
- Signal detection parameters
- Microstructure anomaly thresholds
- Opportunity scoring weights
- Alert prioritization rules

## 🚀 Quick Start

### **1. Installation**

```bash
# Clone repository
git clone <repository-url>
cd poly-market-micro-structure

# Install dependencies
npm install
```

### **2. Configuration**

```bash
# Copy example environment
cp .env.example .env

# Edit with your settings
nano .env
```

**Minimum Required:**
- `DISCORD_WEBHOOK_URL` - For receiving alerts

### **3. Run**

```bash
# Development mode (with auto-reload)
npm run dev

# Production build
npm run build
npm start

# With PM2 (recommended for production)
npm run build
pm2 start dist/index.js --name poly-bot
```

## 📊 Performance Monitoring

### **Built-in Metrics**
- Markets tracked
- Signals detected (by type)
- WebSocket connection status
- Database health
- Memory usage
- Alert delivery rates

### **Health Checks**
```bash
# Check system health
curl http://localhost:3000/health

# Get performance stats
curl http://localhost:3000/stats
```

## 🔧 Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build for production
npm run build

# Run linting
npm run lint

# Run tests
npm test

# Type checking
npm run type-check
```

## 🐳 Deployment

### **Docker**
```bash
docker build -t poly-market-bot .
docker run --env-file .env poly-market-bot
```

### **Docker Compose**
```bash
docker-compose up -d
```

### **PM2**
```bash
npm run build
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

## 📝 Recent Improvements

### **Mathematical Accuracy (Latest)**
- ✅ Fixed 10 mathematical bugs in spread and bias calculations
- ✅ Implemented prediction market-specific formulas
- ✅ Added 122+ tests validating correctness across probability ranges
- ✅ Created spread helper utilities to prevent future errors

### **Real-Time Spread Updates**
- ✅ Market spread now updates from live orderbook data
- ✅ Accurate basis point display in Discord alerts

### **Enhanced Detection**
- ✅ Front-running heuristic engine for leak detection
- ✅ Topic clustering for cross-market analysis
- ✅ Statistical baseline tracking with time-of-day adjustment

## 📚 Key Concepts

### **Prediction Market Math**
Unlike traditional markets, prediction market prices are bounded probabilities (0-1). This means:
- A 5¢ move is **5 percentage points**, regardless of starting price
- Spreads are **absolute** (270 bps = 2.7%), not relative to price
- Volatility uses **absolute changes**, not log returns
- Price impact is **absolute**, not percentage-based

### **Information Leakage**
Sophisticated traders with early information create detectable patterns:
- Orderbook imbalances before news
- Spread compression as liquidity providers step away
- Coordinated movements across related markets
- Microprice drift as informed orders accumulate

### **Microstructure Analysis**
The bot analyzes orderbook dynamics to detect these patterns in real-time.

## 🤝 Contributing

This is a private research project. For questions or collaboration inquiries, please reach out directly.

## 📄 License

MIT License - See LICENSE file for details

---

**⚠️ Disclaimer:** This bot is for research and educational purposes. Prediction markets involve risk. Past performance of signals does not guarantee future results. Use at your own risk.
