import { Market } from '../types';
import { logger } from '../utils/logger';

export interface TopicCluster {
  id: string;
  name: string;
  keywords: string[];
  markets: Market[];
  correlationMatrix: Map<string, number>;
  lastUpdated: number;
}

export interface EntityCluster {
  entity: string;
  topics: TopicCluster[];
  marketCount: number;
  totalVolume: number;
}

export class TopicClusteringEngine {
  private clusters: Map<string, TopicCluster> = new Map();
  private entityClusters: Map<string, EntityCluster> = new Map();
  private marketToTopics: Map<string, string[]> = new Map();
  
  // Predefined entity patterns for political/financial markets
  private readonly entityPatterns = {
    'trump': [
      'trump', 'donald trump', 'president trump', 'trump administration', 'trump cabinet',
      'trump executive order', 'truth social', 'mar-a-lago', 'trump policy', 'trump tariff'
    ],
    'biden': [
      'biden', 'joe biden', 'former president biden', 'hunter biden',
      'biden administration'
    ],
    'harris': [
      'harris', 'kamala harris', 'vice president harris', 'vp harris'
    ],
    'election_2028': [
      'election 2028', '2028 election', 'presidential election', 'republican primary',
      'democratic primary', 'gop primary', 'swing state', 'electoral college', 'midterm'
    ],
    'fed': [
      'fed', 'federal reserve', 'jerome powell', 'interest rate', 'rate cut', 'rate hike',
      'monetary policy', 'inflation', 'cpi', 'fomc', 'janet yellen'
    ],
    'crypto': [
      'bitcoin', 'btc', 'ethereum', 'eth', 'crypto', 'cryptocurrency', 'sec crypto',
      'eth etf', 'bitcoin etf', 'coinbase', 'binance', 'sbf', 'alameda'
    ],
    'ukraine': [
      'ukraine', 'russia', 'putin', 'zelensky', 'nato', 'ukraine war', 'russia ukraine',
      'crimea', 'donbas', 'kyiv', 'moscow', 'sanctions russia'
    ],
    'china': [
      'china', 'xi jinping', 'ccp', 'taiwan', 'hong kong', 'trade war', 'tariffs china',
      'south china sea', 'belt and road', 'huawei'
    ],
    'tech': [
      'apple', 'microsoft', 'google', 'amazon', 'meta', 'tesla', 'openai', 'chatgpt',
      'ai regulation', 'antitrust tech', 'elon musk', 'jeff bezos', 'tim cook'
    ],
    'markets': [
      'recession', 'stock market', 'dow jones', 's&p 500', 'nasdaq', 'vix', 'yield curve',
      'bond market', 'dollar', 'unemployment', 'gdp'
    ],
    'climate': [
      'climate change', 'global warming', 'cop28', 'paris agreement', 'carbon emissions',
      'renewable energy', 'solar', 'wind power', 'esg'
    ],
    'earnings': [
      'earnings', 'quarterly earnings', 'earnings report', 'eps', 'revenue beat', 
      'earnings miss', 'guidance', 'earnings call', 'profit', 'quarterly results',
      'earnings season', 'analyst estimates', 'revenue guidance', 'beat estimates'
    ]
  };

  constructor() {
    this.initializeClusters();
  }

  private initializeClusters(): void {
    logger.info('Initializing topic clustering engine...');
    
    for (const [entity, keywords] of Object.entries(this.entityPatterns)) {
      const cluster: TopicCluster = {
        id: entity,
        name: entity.replace('_', ' ').toUpperCase(),
        keywords,
        markets: [],
        correlationMatrix: new Map(),
        lastUpdated: Date.now()
      };
      
      this.clusters.set(entity, cluster);
      
      const entityCluster: EntityCluster = {
        entity,
        topics: [cluster],
        marketCount: 0,
        totalVolume: 0
      };
      
      this.entityClusters.set(entity, entityCluster);
    }
    
    logger.info(`Initialized ${this.clusters.size} topic clusters`);
  }

  /**
   * Classify markets into topic clusters based on keywords
   */
  classifyMarkets(markets: Market[]): void {
    logger.debug(`Classifying ${markets.length} markets into topic clusters`);
    
    // Clear existing market assignments
    for (const cluster of this.clusters.values()) {
      cluster.markets = [];
    }
    this.marketToTopics.clear();
    
    for (const market of markets) {
      const marketTopics = this.classifyMarket(market);
      if (marketTopics.length > 0) {
        this.marketToTopics.set(market.id, marketTopics);
        
        // Add market to relevant clusters
        for (const topicId of marketTopics) {
          const cluster = this.clusters.get(topicId);
          if (cluster) {
            cluster.markets.push(market);
            cluster.lastUpdated = Date.now();
          }
        }
      }
    }
    
    // Update entity cluster statistics
    this.updateEntityStatistics();
    
    logger.info(`Classification complete: ${this.getClassificationSummary()}`);
  }

  /**
   * Classify a single market into relevant topic clusters
   */
  private classifyMarket(market: Market): string[] {
    const topics: string[] = [];
    const searchText = `${market.question} ${market.description || ''}`.toLowerCase();
    
    for (const [clusterId, cluster] of this.clusters) {
      let score = 0;
      let matchedKeywords = 0;
      
      for (const keyword of cluster.keywords) {
        if (searchText.includes(keyword.toLowerCase())) {
          score += 1;
          matchedKeywords++;
          
          // Boost score for exact matches in question
          if (market.question.toLowerCase().includes(keyword.toLowerCase())) {
            score += 2;
          }
        }
      }
      
      // Require at least 1 keyword match and score > 1 for classification
      if (matchedKeywords > 0 && score > 1) {
        topics.push(clusterId);
        
        logger.debug(`Market "${market.question.substring(0, 50)}..." classified as ${clusterId} (score: ${score}, keywords: ${matchedKeywords})`);
      }
    }
    
    return topics;
  }

  /**
   * Update statistics for entity clusters
   */
  private updateEntityStatistics(): void {
    for (const [entityId, entityCluster] of this.entityClusters) {
      const cluster = this.clusters.get(entityId);
      if (cluster) {
        entityCluster.marketCount = cluster.markets.length;
        entityCluster.totalVolume = cluster.markets.reduce((sum, market) => sum + market.volumeNum, 0);
      }
    }
  }

  /**
   * Get markets that are correlated within the same topic cluster
   */
  getCorrelatedMarkets(marketId: string): Market[] {
    const topics = this.marketToTopics.get(marketId) || [];
    const correlatedMarkets: Set<Market> = new Set();
    
    for (const topicId of topics) {
      const cluster = this.clusters.get(topicId);
      if (cluster) {
        for (const market of cluster.markets) {
          if (market.id !== marketId) {
            correlatedMarkets.add(market);
          }
        }
      }
    }
    
    return Array.from(correlatedMarkets);
  }

  /**
   * Get markets within a specific topic cluster
   */
  getTopicMarkets(topicId: string): Market[] {
    const cluster = this.clusters.get(topicId);
    return cluster ? [...cluster.markets] : [];
  }

  /**
   * Get all markets for a specific entity (e.g., all Trump-related markets)
   */
  getEntityMarkets(entity: string): Market[] {
    const entityCluster = this.entityClusters.get(entity);
    if (!entityCluster) return [];
    
    const markets: Set<Market> = new Set();
    for (const topic of entityCluster.topics) {
      for (const market of topic.markets) {
        markets.add(market);
      }
    }
    
    return Array.from(markets);
  }

  /**
   * Calculate cross-market correlation for leak detection
   */
  calculateCrossMarketCorrelation(markets: Market[], timeWindow: number = 2 * 60 * 1000): Map<string, number> {
    const correlations = new Map<string, number>();
    
    // For now, we'll use volume-based correlation as a proxy
    // In a real implementation, you'd use price movement correlation
    for (let i = 0; i < markets.length; i++) {
      for (let j = i + 1; j < markets.length; j++) {
        const market1 = markets[i];
        const market2 = markets[j];
        
        // Simple volume correlation (would be replaced with price correlation in real implementation)
        const volumeRatio = Math.min(market1.volumeNum, market2.volumeNum) / Math.max(market1.volumeNum, market2.volumeNum);
        const correlation = volumeRatio * 0.8; // Placeholder calculation
        
        correlations.set(`${market1.id}-${market2.id}`, correlation);
      }
    }
    
    return correlations;
  }

  /**
   * Detect coordinated movements across correlated markets
   */
  detectCoordinatedMovements(topicId: string, priceChanges: Map<string, number>, threshold: number = 2): {
    markets: Market[];
    averageChange: number;
    correlationScore: number;
  } | null {
    const cluster = this.clusters.get(topicId);
    if (!cluster || cluster.markets.length < 2) return null;
    
    const significantMoves: { market: Market; change: number }[] = [];
    
    for (const market of cluster.markets) {
      const change = priceChanges.get(market.id);
      if (change !== undefined && Math.abs(change) > threshold) {
        significantMoves.push({ market, change });
      }
    }
    
    // Need at least 2 markets moving in same direction
    if (significantMoves.length < 2) return null;
    
    // Check if moves are in same direction
    const positiveMoves = significantMoves.filter(m => m.change > 0).length;
    const negativeMoves = significantMoves.filter(m => m.change < 0).length;
    
    const sameDirection = positiveMoves >= 2 || negativeMoves >= 2;
    if (!sameDirection) return null;
    
    const averageChange = significantMoves.reduce((sum, m) => sum + m.change, 0) / significantMoves.length;
    const correlationScore = significantMoves.length / cluster.markets.length;
    
    return {
      markets: significantMoves.map(m => m.market),
      averageChange,
      correlationScore
    };
  }

  /**
   * Get cluster statistics for monitoring
   */
  getClusterStatistics(): { [key: string]: any } {
    const stats: { [key: string]: any } = {};
    
    for (const [entityId, entityCluster] of this.entityClusters) {
      stats[entityId] = {
        marketCount: entityCluster.marketCount,
        totalVolume: entityCluster.totalVolume,
        averageVolume: entityCluster.marketCount > 0 ? entityCluster.totalVolume / entityCluster.marketCount : 0
      };
    }
    
    return stats;
  }

  /**
   * Get classification summary for logging
   */
  private getClassificationSummary(): string {
    const clustersWithMarkets = Array.from(this.clusters.values()).filter(c => c.markets.length > 0);
    const totalClassifiedMarkets = clustersWithMarkets.reduce((sum, c) => sum + c.markets.length, 0);
    
    return `${clustersWithMarkets.length} active clusters, ${totalClassifiedMarkets} classified markets`;
  }

  /**
   * Get all topic clusters
   */
  getAllClusters(): TopicCluster[] {
    return Array.from(this.clusters.values());
  }

  /**
   * Get entity clusters
   */
  getAllEntityClusters(): EntityCluster[] {
    return Array.from(this.entityClusters.values());
  }

  /**
   * Add custom keyword to a cluster
   */
  addKeywordToCluster(clusterId: string, keyword: string): boolean {
    const cluster = this.clusters.get(clusterId);
    if (cluster && !cluster.keywords.includes(keyword.toLowerCase())) {
      cluster.keywords.push(keyword.toLowerCase());
      logger.info(`Added keyword "${keyword}" to cluster ${clusterId}`);
      return true;
    }
    return false;
  }

  /**
   * Health check for clustering engine
   */
  healthCheck(): { healthy: boolean; details: any } {
    const totalMarkets = Array.from(this.clusters.values()).reduce((sum, c) => sum + c.markets.length, 0);
    const activeClusters = Array.from(this.clusters.values()).filter(c => c.markets.length > 0).length;
    
    return {
      healthy: activeClusters > 0 && totalMarkets > 0,
      details: {
        totalClusters: this.clusters.size,
        activeClusters,
        totalClassifiedMarkets: totalMarkets,
        entityClusters: this.entityClusters.size,
        lastUpdate: Math.max(...Array.from(this.clusters.values()).map(c => c.lastUpdated))
      }
    };
  }
}