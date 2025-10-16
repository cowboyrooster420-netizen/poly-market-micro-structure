import { Market, MarketMetrics, OrderbookData, TickData, EarlySignal, MicrostructureSignal } from '../../types';

/**
 * Mock data factory for creating realistic market scenarios for testing
 */
export class MarketDataMocks {
  
  /**
   * Create a basic market with default values
   */
  static createBasicMarket(overrides: Partial<Market> = {}): Market {
    return {
      id: 'market_123',
      question: 'Will Bitcoin reach $100,000 by end of 2024?',
      description: 'Market resolves YES if Bitcoin price reaches $100,000 at any point before Dec 31, 2024',
      outcomes: ['Yes', 'No'],
      outcomePrices: ['0.65', '0.35'],
      volume: '50000',
      volumeNum: 50000,
      active: true,
      closed: false,
      endDate: '2024-12-31T23:59:59Z',
      tags: ['crypto', 'bitcoin', 'price'],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-10-15T12:00:00Z',
      metadata: {
        assetIds: ['asset_yes_123', 'asset_no_123'],
        conditionId: 'condition_123'
      },
      ...overrides
    };
  }

  /**
   * Create a market with high volume for testing volume spike detection
   */
  static createHighVolumeMarket(volumeMultiplier: number = 10): Market {
    return this.createBasicMarket({
      id: 'high_volume_market',
      question: 'Election Night - Who wins presidency?',
      volume: (50000 * volumeMultiplier).toString(),
      volumeNum: 50000 * volumeMultiplier,
      outcomePrices: ['0.52', '0.48'] // Close race
    });
  }

  /**
   * Create a market with suspicious price movement
   */
  static createSuspiciousPriceMarket(): Market {
    return this.createBasicMarket({
      id: 'suspicious_price_market',
      question: 'Will company announce merger this week?',
      outcomePrices: ['0.85', '0.15'], // Very confident YES
      volumeNum: 150000,
      tags: ['business', 'merger', 'insider']
    });
  }

  /**
   * Create market metrics history for testing trend analysis
   */
  static createMarketHistory(marketId: string, periods: number = 10, baseVolume: number = 10000): MarketMetrics[] {
    const history: MarketMetrics[] = [];
    const now = Date.now();
    
    for (let i = periods; i >= 0; i--) {
      const timestamp = now - (i * 60 * 60 * 1000); // Hourly intervals
      const volumeVariation = 0.8 + (Math.random() * 0.4); // 80% to 120% of base
      
      history.push({
        marketId,
        volume24h: baseVolume * volumeVariation,
        prices: [0.6 + (Math.random() * 0.2 - 0.1), 0.4 + (Math.random() * 0.2 - 0.1)], // Slight price movements
        priceChange: {
          outcome_0: (Math.random() * 4 - 2), // -2% to +2%
          outcome_1: (Math.random() * 4 - 2)
        },
        activityScore: Math.floor(50 + Math.random() * 25), // Activity score 50-75 (below unusual threshold)
        lastUpdated: Date.now(),
        volumeChange: (Math.random() * 20 - 10) // -10% to +10% volume change
      });
    }
    
    return history;
  }

  /**
   * Create history with a clear volume spike in recent data
   */
  static createVolumeSpikeHistory(marketId: string, spikeMultiplier: number = 5): MarketMetrics[] {
    const history = this.createMarketHistory(marketId, 10, 10000);
    
    // Add volume spike in the most recent entry
    const latest = history[history.length - 1];
    latest.volume24h = 10000 * spikeMultiplier;
    latest.volumeChange = ((spikeMultiplier - 1) * 100); // Percentage change
    latest.activityScore = 70; // Keep below unusual activity threshold (80)
    
    // Keep price changes small to avoid triggering price movement signals
    latest.priceChange = {
      outcome_0: 1.5, // Small price change
      outcome_1: -1.2
    };
    
    return history;
  }

  /**
   * Create orderbook data for testing microstructure analysis
   */
  static createOrderbook(marketId: string, scenario: 'balanced' | 'imbalanced' | 'thin' | 'wide_spread' = 'balanced'): OrderbookData {
    const baseOrderbook: OrderbookData = {
      marketId,
      timestamp: Date.now(),
      bids: [],
      asks: [],
      spread: 0,
      midPrice: 0,
      bestBid: 0,
      bestAsk: 0
    };

    switch (scenario) {
      case 'balanced':
        baseOrderbook.bids = [
          { price: 0.50, size: 1000, volume: 500 },
          { price: 0.49, size: 1500, volume: 735 },
          { price: 0.48, size: 2000, volume: 960 },
          { price: 0.47, size: 1200, volume: 564 },
          { price: 0.46, size: 800, volume: 368 }
        ];
        baseOrderbook.asks = [
          { price: 0.52, size: 1100, volume: 572 },
          { price: 0.53, size: 1400, volume: 742 },
          { price: 0.54, size: 1800, volume: 972 },
          { price: 0.55, size: 1000, volume: 550 },
          { price: 0.56, size: 900, volume: 504 }
        ];
        break;

      case 'imbalanced':
        // Heavy bid side - suggests upward pressure
        baseOrderbook.bids = [
          { price: 0.50, size: 5000, volume: 2500 },
          { price: 0.49, size: 4000, volume: 1960 },
          { price: 0.48, size: 3500, volume: 1680 },
          { price: 0.47, size: 3000, volume: 1410 },
          { price: 0.46, size: 2500, volume: 1150 }
        ];
        baseOrderbook.asks = [
          { price: 0.52, size: 200, volume: 104 },
          { price: 0.53, size: 300, volume: 159 },
          { price: 0.54, size: 400, volume: 216 },
          { price: 0.55, size: 250, volume: 138 },
          { price: 0.56, size: 150, volume: 84 }
        ];
        break;

      case 'thin':
        // Very low liquidity
        baseOrderbook.bids = [
          { price: 0.50, size: 50, volume: 25 },
          { price: 0.49, size: 30, volume: 14.7 },
          { price: 0.48, size: 20, volume: 9.6 }
        ];
        baseOrderbook.asks = [
          { price: 0.52, size: 40, volume: 20.8 },
          { price: 0.53, size: 25, volume: 13.25 },
          { price: 0.54, size: 15, volume: 8.1 }
        ];
        break;

      case 'wide_spread':
        // Large spread indicating liquidity issues
        baseOrderbook.bids = [
          { price: 0.45, size: 1000, volume: 450 },
          { price: 0.44, size: 800, volume: 352 },
          { price: 0.43, size: 600, volume: 258 }
        ];
        baseOrderbook.asks = [
          { price: 0.58, size: 900, volume: 522 },
          { price: 0.59, size: 700, volume: 413 },
          { price: 0.60, size: 500, volume: 300 }
        ];
        break;
    }

    // Calculate derived values
    baseOrderbook.bestBid = baseOrderbook.bids.length > 0 ? baseOrderbook.bids[0].price : 0;
    baseOrderbook.bestAsk = baseOrderbook.asks.length > 0 ? baseOrderbook.asks[0].price : 0;
    baseOrderbook.spread = baseOrderbook.bestAsk - baseOrderbook.bestBid;
    baseOrderbook.midPrice = (baseOrderbook.bestBid + baseOrderbook.bestAsk) / 2;

    return baseOrderbook;
  }

  /**
   * Create tick data for testing trading pattern analysis
   */
  static createTickData(marketId: string, count: number = 50, scenario: 'normal' | 'coordinated_buying' | 'front_running' = 'normal'): TickData[] {
    const ticks: TickData[] = [];
    const now = Date.now();
    let currentPrice = 0.50;

    for (let i = 0; i < count; i++) {
      const timestamp = now - ((count - i) * 1000); // 1 second intervals
      let side: 'buy' | 'sell';
      let size: number;
      let priceMovement: number;

      switch (scenario) {
        case 'coordinated_buying':
          // Mostly buy orders with increasing size
          side = Math.random() < 0.8 ? 'buy' : 'sell';
          size = 100 + (i * 20) + (Math.random() * 50); // Increasing size over time
          priceMovement = side === 'buy' ? 0.001 : -0.0005; // Upward pressure
          break;

        case 'front_running':
          // Large orders followed by smaller ones in same direction
          if (i % 10 === 0) {
            // Every 10th trade is large
            side = 'buy';
            size = 1000 + (Math.random() * 500);
            priceMovement = 0.002;
          } else {
            // Smaller follow-up trades
            side = 'buy';
            size = 50 + (Math.random() * 100);
            priceMovement = 0.0005;
          }
          break;

        default: // normal
          side = Math.random() < 0.5 ? 'buy' : 'sell';
          size = 50 + (Math.random() * 200);
          priceMovement = (Math.random() * 0.002 - 0.001); // Small random movements
      }

      currentPrice += priceMovement;
      currentPrice = Math.max(0.01, Math.min(0.99, currentPrice)); // Keep in bounds

      ticks.push({
        timestamp,
        marketId,
        price: currentPrice,
        volume: size * currentPrice,
        side,
        size
      });
    }

    return ticks.sort((a, b) => b.timestamp - a.timestamp); // Most recent first
  }

  /**
   * Create multiple related markets for cross-market correlation testing
   */
  static createRelatedMarkets(entity: string, count: number = 3): Market[] {
    const markets: Market[] = [];
    const baseQuestions = [
      `Will ${entity} announce earnings beat?`,
      `Will ${entity} stock price reach new high?`,
      `Will ${entity} complete acquisition?`,
      `Will ${entity} CEO resign?`,
      `Will ${entity} face regulatory action?`
    ];

    for (let i = 0; i < count; i++) {
      markets.push(this.createBasicMarket({
        id: `${entity.toLowerCase()}_market_${i}`,
        question: baseQuestions[i % baseQuestions.length],
        volumeNum: 20000 + (Math.random() * 30000),
        outcomePrices: [
          (0.4 + Math.random() * 0.2).toFixed(2), // 0.4-0.6
          (0.4 + Math.random() * 0.2).toFixed(2)  // 0.4-0.6
        ],
        tags: [entity.toLowerCase(), 'business', 'corporate']
      }));
    }

    return markets;
  }

  /**
   * Create mock signals for testing alert and notification systems
   */
  static createMockSignal(type: 'volume_spike' | 'price_movement' | 'new_market' | 'coordinated_cross_market' = 'volume_spike', confidence: number = 0.8): EarlySignal {
    const market = this.createBasicMarket();
    
    return {
      marketId: market.id,
      market,
      signalType: type,
      confidence,
      timestamp: Date.now(),
      metadata: {
        severity: confidence > 0.9 ? 'critical' : confidence > 0.75 ? 'high' : 'medium',
        signalSource: 'mock_test',
        currentVolume: type === 'volume_spike' ? 150000 : market.volumeNum,
        averageVolume: type === 'volume_spike' ? 30000 : undefined,
        volumeMultiplier: type === 'volume_spike' ? 5.0 : undefined,
        priceChange: type === 'price_movement' ? 15.5 : undefined,
        correlationScore: type === 'coordinated_cross_market' ? 0.85 : undefined
      }
    };
  }

  /**
   * Create mock microstructure signal
   */
  static createMockMicrostructureSignal(type: 'orderbook_imbalance' | 'spread_anomaly' | 'liquidity_shift' = 'orderbook_imbalance'): MicrostructureSignal {
    return {
      marketId: 'test_market_123',
      type,
      confidence: 0.75,
      severity: 'medium',
      timestamp: Date.now(),
      data: {
        current: 0.85,
        baseline: 0.50,
        change: 0.35,
        context: {
          orderbookImbalance: type === 'orderbook_imbalance' ? 0.8 : undefined,
          spreadIncrease: type === 'spread_anomaly' ? 250 : undefined,
          liquidityChange: type === 'liquidity_shift' ? 0.3 : undefined
        }
      }
    };
  }

  /**
   * Create scenario-based test data sets
   */
  static createTestScenario(scenario: 'election_night' | 'earnings_leak' | 'market_manipulation' | 'normal_trading') {
    switch (scenario) {
      case 'election_night':
        return {
          markets: [
            this.createBasicMarket({
              id: 'election_president',
              question: 'Who will win the 2024 Presidential Election?',
              volumeNum: 2000000,
              outcomePrices: ['0.51', '0.49']
            }),
            this.createBasicMarket({
              id: 'election_senate',
              question: 'Will Republicans control Senate?',
              volumeNum: 500000,
              outcomePrices: ['0.65', '0.35']
            })
          ],
          expectedSignals: ['volume_spike', 'cross_market_correlation'],
          timeframe: '2024-11-05T20:00:00Z'
        };

      case 'earnings_leak':
        return {
          markets: this.createRelatedMarkets('Apple', 3),
          expectedSignals: ['coordinated_cross_market', 'front_running'],
          timeframe: '2024-10-30T16:00:00Z' // After hours before earnings
        };

      case 'market_manipulation':
        return {
          markets: [this.createSuspiciousPriceMarket()],
          orderbook: this.createOrderbook('suspicious_price_market', 'imbalanced'),
          ticks: this.createTickData('suspicious_price_market', 100, 'front_running'),
          expectedSignals: ['front_running', 'orderbook_imbalance']
        };

      default: // normal_trading
        return {
          markets: [
            this.createBasicMarket(),
            this.createBasicMarket({ id: 'market_2', question: 'Will it rain tomorrow?' })
          ],
          expectedSignals: [], // No signals expected in normal trading
          timeframe: new Date().toISOString()
        };
    }
  }
}

/**
 * Mock data utilities for test setup and cleanup
 */
export class MockDataUtils {
  
  /**
   * Generate realistic price movements over time
   */
  static generatePriceWalk(startPrice: number, steps: number, volatility: number = 0.02): number[] {
    const prices: number[] = [startPrice];
    let currentPrice = startPrice;
    
    for (let i = 1; i < steps; i++) {
      const change = (Math.random() - 0.5) * volatility;
      currentPrice = Math.max(0.01, Math.min(0.99, currentPrice + change));
      prices.push(currentPrice);
    }
    
    return prices;
  }

  /**
   * Create correlated market movements for testing cross-market detection
   */
  static generateCorrelatedMovements(marketCount: number, correlation: number = 0.8): Array<{ marketId: string; priceChange: number }> {
    const baseMovement = (Math.random() - 0.5) * 0.1; // -5% to +5%
    const movements: Array<{ marketId: string; priceChange: number }> = [];
    
    for (let i = 0; i < marketCount; i++) {
      const correlatedNoise = (Math.random() - 0.5) * 0.02; // Small random component
      const movement = (baseMovement * correlation) + (correlatedNoise * (1 - correlation));
      
      movements.push({
        marketId: `correlated_market_${i}`,
        priceChange: movement * 100 // Convert to percentage
      });
    }
    
    return movements;
  }

  /**
   * Create time series data with anomalies
   */
  static generateAnomalousTimeSeries(length: number, anomalyIndices: number[] = []): number[] {
    const series: number[] = [];
    const baseValue = 50;
    
    for (let i = 0; i < length; i++) {
      let value = baseValue + (Math.random() * 10 - 5); // Normal variation ±5
      
      if (anomalyIndices.includes(i)) {
        value += (Math.random() > 0.5 ? 1 : -1) * (20 + Math.random() * 30); // Anomaly ±20-50
      }
      
      series.push(value);
    }
    
    return series;
  }
}