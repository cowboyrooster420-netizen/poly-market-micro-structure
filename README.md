# Poly Early Bot

A sophisticated microstructure detection bot for identifying early opportunities on Polymarket through real-time analysis of market dynamics.

## 🚀 Advanced Features

### **Microstructure Detection**
- **Orderbook Imbalance Detection**: Identifies bid/ask ratio shifts indicating large orders
- **Spread Anomaly Alerts**: Detects compression/expansion beyond normal ranges
- **Market Maker Withdrawal**: Monitors liquidity provider behavior changes
- **Momentum Breakouts**: RSI, MACD, and price momentum confirmations
- **Liquidity Flow Analysis**: Tracks volume-weighted price deviations

### **Real-time Processing**
- **WebSocket Streaming**: Sub-second market data updates
- **Ring Buffer Storage**: High-performance tick data management
- **Technical Indicators**: Real-time RSI, MACD, momentum calculations
- **Batch Processing**: Efficient multi-market orderbook analysis

### **Smart Alerting**
- **Rich Discord Embeds**: Beautiful, contextual alerts with charts and metrics
- **Confidence Scoring**: AI-powered signal prioritization
- **Rate Limiting**: Anti-spam protection with smart filtering
- **Multi-severity Levels**: Critical, High, Medium, Low classifications

## Quick Start

1. **Clone and Install**
   ```bash
   npm install
   ```

2. **Configure Environment**
   ```bash
   cp .env.example .env
   # Edit .env with your settings
   ```

3. **Run the Bot**
   ```bash
   # Development
   npm run dev

   # Production
   npm run build
   npm start
   ```

## Configuration

Key environment variables:

- `CHECK_INTERVAL_MS`: How often to scan markets (default: 30000ms)
- `MIN_VOLUME_THRESHOLD`: Minimum volume to consider (default: $10,000)
- `MAX_MARKETS_TO_TRACK`: Maximum markets to monitor (default: 100)
- `LOG_LEVEL`: Logging verbosity (debug, info, warn, error)

## 📊 Signal Types

### **Microstructure Signals**
1. **Orderbook Imbalance** - Bid/ask ratio shifts >30% from baseline
2. **Spread Anomaly** - Compression/expansion >2 standard deviations
3. **Market Maker Withdrawal** - Depth reduction >30% with volume drop
4. **Momentum Breakout** - RSI + MACD + price momentum confirmations
5. **Liquidity Shift** - Liquidity score changes >20 points

### **Classic Signals**
1. **Volume Spike** - 3x above recent average with confirmation
2. **Price Movement** - >10% change with volume support
3. **New Market** - Fresh markets with early activity
4. **Unusual Activity** - Multi-factor anomaly scoring

### **Alert Categories**
- 🚨 **Urgent**: Critical severity, immediate action required
- 📈 **Price Action**: Momentum and trend signals
- 💧 **Liquidity**: Market depth and flow changes  
- 🆕 **New Opportunity**: Fresh market detection
- ⚡ **Flash Move**: Rapid price movements with volume

## Architecture

```
src/
├── bot/
│   └── EarlyBot.ts           # Main bot orchestrator
├── services/
│   ├── PolymarketService.ts  # API interface
│   └── SignalDetector.ts     # Signal detection logic
├── types/
│   └── index.ts              # TypeScript interfaces
├── utils/
│   └── logger.ts             # Logging utility
└── index.ts                  # Entry point
```

## Development

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
```

## Deployment

### Docker
```bash
docker build -t poly-early-bot .
docker run --env-file .env poly-early-bot
```

### PM2
```bash
npm run build
pm2 start dist/index.js --name poly-early-bot
```

## License

MIT