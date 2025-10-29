import { Market, MarketTier } from '../types';
import { logger } from '../utils/logger';
import { advancedLogger } from '../utils/AdvancedLogger';

export interface CategoryResult {
  category: string | null;
  categoryScore: number;
  isBlacklisted: boolean;
  matchedKeywords: string[];
}

export interface VolumeFilterResult {
  passed: boolean;
  requiredVolume: number;
  actualVolume: number;
  category: string;
  reason?: string;
}

export interface VolumeFilterStats {
  totalMarkets: number;
  passedMarkets: number;
  filteredMarkets: number;
  byCategory: Record<string, { passed: number; filtered: number; totalVolume: number }>;
}

export interface TierAssignment {
  tier: MarketTier;
  reason: string;
  watchlistSignals: string[];
  priority: number;  // Higher = more important (for ranking within tier)
}

export interface TierStats {
  active: number;
  watchlist: number;
  ignored: number;
  watchlistByReason: Record<string, number>;
}

export interface WatchlistCriteria {
  enabled: boolean;
  minVolumeFloor: number;
  maxWatchlistSize: number;
  monitoringIntervalMs: number;
  criteria: {
    minCategoryScore: number;
    minOutcomeCount: number;
    maxDaysToClose: number;
    highEdgeCategories: string[];
    requireMultipleSignals: boolean;
  };
}

export interface OpportunityScore {
  total: number;              // Final composite score (0-100)
  volumeScore: number;        // Volume component (0-30)
  edgeScore: number;          // Information edge component (0-25)
  catalystScore: number;      // Catalyst timing component (0-25)
  qualityScore: number;       // Market quality component (0-20)
  breakdown: {
    volumeRatio: number;      // Actual / threshold volume
    edgeMultiplier: number;   // Category edge multiplier
    daysToClose: number;      // Days until market closes
    spreadBps: number;        // Spread in basis points
    marketAgeDays: number;    // Market age in days
  };
}

export interface OpportunityScoringConfig {
  enabled: boolean;
  volumeScore: {
    weight: number;
    optimalVolumeMultiplier: number;
    illiquidityPenaltyThreshold: number;
    efficiencyPenaltyThreshold: number;
  };
  edgeScore: {
    weight: number;
    highEdgeCategories: Record<string, number>;
    categoryScoreWeight: number;
    multiOutcomeBonus: number;
    maxMultiOutcomeBonus: number;
  };
  catalystScore: {
    weight: number;
    optimalDaysToClose: number;
    minDaysToClose: number;
    maxDaysToClose: number;
    urgencyMultiplier: number;
  };
  qualityScore: {
    weight: number;
    spreadWeight: number;
    ageWeight: number;
    liquidityWeight: number;
    optimalSpreadBps: number;
    maxAgeDays: number;
  };
}

/**
 * MarketCategorizer - Detects market categories based on keyword matching
 * and applies category-specific volume thresholds
 *
 * Categorizes markets into news-driven, event-based categories that have
 * information edges and clear resolution criteria.
 */
export class MarketCategorizer {
  private volumeThresholds: Record<string, number>;
  private watchlistCriteria: WatchlistCriteria;
  private opportunityScoringConfig: OpportunityScoringConfig;
  private readonly categoryKeywords: Record<string, string[]> = {
    politics: [
      'election', 'president', 'senate', 'congress', 'governor',
      'vote', 'nominee', 'cabinet', 'secretary', 'appoint',
      'white house', 'house of representatives', 'senate', 'legislation',
      'republican', 'democrat', 'gop', 'dnc', 'rnc', 'primary',
      'electoral', 'ballot', 'campaign', 'caucus'
    ],

    fed: [
      'fed', 'federal reserve', 'jerome powell', 'interest rate',
      'rate cut', 'rate hike', 'fomc', 'monetary policy',
      'central bank', 'fed chair', 'fed meeting', 'basis points',
      'federal funds rate', 'quantitative', 'tightening', 'dovish', 'hawkish'
    ],

    earnings: [
      'earnings', 'eps', 'revenue', 'quarterly', 'q1', 'q2', 'q3', 'q4',
      'fiscal', 'guidance', 'beat estimates', 'miss estimates',
      'earnings report', 'earnings call', 'analyst estimate',
      'profit', 'loss', 'income statement', 'balance sheet'
    ],

    ceo_changes: [
      'ceo', 'chief executive', 'resign', 'step down', 'appoint ceo',
      'new ceo', 'cfo', 'chief financial', 'executive officer',
      'c-suite', 'board of directors', 'chairman', 'interim ceo'
    ],

    mergers: [
      'merger', 'acquisition', 'buyout', 'takeover', 'acquire',
      'm&a', 'deal', 'bid', 'offer', 'shareholder approval',
      'regulatory approval', 'antitrust', 'consolidation'
    ],

    sports_awards: [
      'mvp', 'rookie of the year', 'roy', 'dpoy', 'defensive player',
      'all-star', 'heisman', 'cy young', 'golden boot', 'ballon d\'or',
      'coach of the year', 'sixth man', 'comeback player',
      'all-nba', 'all-pro', 'all-mlb', 'player of the year'
    ],

    court_cases: [
      'trial', 'verdict', 'sentenced', 'convicted', 'acquitted',
      'supreme court', 'ruling', 'appeal', 'lawsuit', 'litigation',
      'jury', 'judge', 'guilty', 'innocent', 'plea', 'settlement',
      'indictment', 'prosecution', 'defense', 'court case'
    ],

    hollywood_awards: [
      'oscar', 'academy award', 'emmy', 'golden globe',
      'best picture', 'best actor', 'best director', 'grammy',
      'tony', 'bafta', 'sag award', 'best actress',
      'nominations', 'academy', 'film award', 'movie award'
    ],

    economic_data: [
      'cpi', 'inflation', 'jobs report', 'unemployment',
      'gdp', 'nonfarm payroll', 'pce', 'retail sales',
      'consumer confidence', 'pmi', 'ism', 'housing starts',
      'jobless claims', 'trade deficit', 'industrial production',
      'durable goods', 'personal income', 'economic data'
    ],

    world_events: [
      'war', 'invasion', 'treaty', 'sanctions', 'cease-fire',
      'nato', 'un security council', 'summit', 'diplomatic',
      'conflict', 'peace talks', 'military', 'troops',
      'international', 'foreign policy', 'alliance'
    ],

    macro: [
      'recession', 'bear market', 'bull market', 'yield curve',
      'debt ceiling', 'default', 'credit rating', 'downturn',
      'economic growth', 'stock market', 'correction', 'crash',
      's&p 500', 'dow jones', 'nasdaq', 'volatility'
    ],

    crypto_events: [
      'etf approval', 'sec approval', 'token launch', 'mainnet',
      'hard fork', 'halving', 'blockchain', 'smart contract',
      'listing', 'exchange listing', 'protocol upgrade',
      'testnet', 'audit', 'whitepaper', 'ico', 'ido'
    ],

    pardons: [
      'pardon', 'commute sentence', 'clemency', 'presidential pardon',
      'pardoned', 'commutation', 'executive clemency', 'amnesty'
    ]
  };

  private readonly blacklistKeywords: string[] = [
    'price prediction',
    'will reach',
    'hit $',
    'all time high',
    'pump',
    'moon',
    'crash to',
    'what will',
    'how many',
    'how much',
    'total',
    'aggregate',
    'price target',
    'trade at',
    'trading above',
    'trading below',
    'mvp'  // Filter out NBA/MLB MVP markets (too spammy)
  ];

  /**
   * Initialize the categorizer with volume thresholds, watchlist criteria, and scoring config
   */
  constructor(
    volumeThresholds?: Record<string, number>,
    watchlistCriteria?: WatchlistCriteria,
    opportunityScoringConfig?: OpportunityScoringConfig
  ) {
    // Default volume thresholds if not provided
    this.volumeThresholds = volumeThresholds || {
      earnings: 2000,
      ceo_changes: 3000,
      pardons: 3000,
      mergers: 5000,
      court_cases: 5000,
      sports_awards: 4000,
      hollywood_awards: 4000,
      crypto_events: 6000,
      politics: 8000,
      economic_data: 8000,
      world_events: 7000,
      fed: 10000,
      macro: 10000,
      uncategorized: 15000
    };

    // Default watchlist criteria if not provided
    this.watchlistCriteria = watchlistCriteria || {
      enabled: true,
      minVolumeFloor: 500,
      maxWatchlistSize: 100,
      monitoringIntervalMs: 300000,
      criteria: {
        minCategoryScore: 3,
        minOutcomeCount: 5,
        maxDaysToClose: 14,
        highEdgeCategories: ['earnings', 'ceo_changes', 'court_cases', 'pardons'],
        requireMultipleSignals: true
      }
    };

    // Default opportunity scoring config if not provided
    this.opportunityScoringConfig = opportunityScoringConfig || {
      enabled: true,
      volumeScore: {
        weight: 0.3,
        optimalVolumeMultiplier: 1.5,
        illiquidityPenaltyThreshold: 0.3,
        efficiencyPenaltyThreshold: 5.0
      },
      edgeScore: {
        weight: 0.25,
        highEdgeCategories: {
          earnings: 1.5,
          ceo_changes: 1.4,
          court_cases: 1.3,
          pardons: 1.3,
          mergers: 1.2,
          sports_awards: 1.1,
          hollywood_awards: 1.1,
          politics: 1.0,
          economic_data: 0.9,
          world_events: 0.9,
          fed: 0.8,
          macro: 0.8,
          crypto_events: 1.0,
          uncategorized: 0.5
        },
        categoryScoreWeight: 0.4,
        multiOutcomeBonus: 0.5,
        maxMultiOutcomeBonus: 5.0
      },
      catalystScore: {
        weight: 0.25,
        optimalDaysToClose: 4.0,
        minDaysToClose: 0.5,
        maxDaysToClose: 30,
        urgencyMultiplier: 1.5
      },
      qualityScore: {
        weight: 0.2,
        spreadWeight: 0.4,
        ageWeight: 0.3,
        liquidityWeight: 0.3,
        optimalSpreadBps: 150,
        maxAgeDays: 60
      }
    };
  }

  /**
   * Update volume thresholds (used when config changes)
   */
  updateVolumeThresholds(thresholds: Record<string, number>): void {
    this.volumeThresholds = { ...thresholds };
    advancedLogger.info('Volume thresholds updated', {
      component: 'market_categorizer',
      operation: 'update_volume_thresholds',
      metadata: { thresholds }
    });
  }

  /**
   * Update watchlist criteria (used when config changes)
   */
  updateWatchlistCriteria(criteria: WatchlistCriteria): void {
    this.watchlistCriteria = { ...criteria };
    advancedLogger.info('Watchlist criteria updated', {
      component: 'market_categorizer',
      operation: 'update_watchlist_criteria',
      metadata: { criteria }
    });
  }

  /**
   * Update opportunity scoring config (used when config changes)
   */
  updateOpportunityScoringConfig(config: OpportunityScoringConfig): void {
    this.opportunityScoringConfig = { ...config };
    advancedLogger.info('Opportunity scoring config updated', {
      component: 'market_categorizer',
      operation: 'update_opportunity_scoring_config',
      metadata: { config }
    });
  }

  /**
   * Categorize a market based on its question text
   */
  categorize(market: Market): CategoryResult {
    const question = market.question?.toLowerCase() || '';

    // Check blacklist first
    const isBlacklisted = this.checkBlacklist(question);
    if (isBlacklisted) {
      return {
        category: null,
        categoryScore: 0,
        isBlacklisted: true,
        matchedKeywords: []
      };
    }

    // Special handling for crypto - only allow event-based markets
    const cryptoCheck = this.checkCryptoMarket(question);
    if (cryptoCheck.isInvalidCrypto) {
      return {
        category: null,
        categoryScore: 0,
        isBlacklisted: true,
        matchedKeywords: []
      };
    }

    // Score each category
    let bestCategory: string | null = null;
    let bestScore = 0;
    let bestMatches: string[] = [];

    for (const [category, keywords] of Object.entries(this.categoryKeywords)) {
      const result = this.scoreCategory(question, keywords);

      if (result.score > bestScore) {
        bestScore = result.score;
        bestCategory = category;
        bestMatches = result.matches;
      }
    }

    // Minimum threshold: at least 1 keyword match
    if (bestScore < 1) {
      return {
        category: null,
        categoryScore: 0,
        isBlacklisted: false,
        matchedKeywords: []
      };
    }

    logger.debug(`Categorized market as '${bestCategory}' (score: ${bestScore})`, {
      question: market.question?.substring(0, 100),
      matchedKeywords: bestMatches
    });

    return {
      category: bestCategory,
      categoryScore: bestScore,
      isBlacklisted: false,
      matchedKeywords: bestMatches
    };
  }

  /**
   * Score a category based on keyword matches
   */
  private scoreCategory(question: string, keywords: string[]): { score: number; matches: string[] } {
    let score = 0;
    const matches: string[] = [];

    for (const keyword of keywords) {
      if (question.includes(keyword)) {
        score += 1;
        matches.push(keyword);

        // Bonus for exact phrase match (not just substring)
        const regex = new RegExp(`\\b${keyword}\\b`, 'i');
        if (regex.test(question)) {
          score += 0.5;
        }
      }
    }

    return { score, matches };
  }

  /**
   * Check if market question contains blacklisted patterns
   */
  private checkBlacklist(question: string): boolean {
    for (const keyword of this.blacklistKeywords) {
      if (question.includes(keyword)) {
        logger.debug(`Market blacklisted due to keyword: ${keyword}`);
        return true;
      }
    }
    return false;
  }

  /**
   * Special validation for crypto markets - only allow event-based, not price predictions
   */
  private checkCryptoMarket(question: string): { isInvalidCrypto: boolean } {
    // Check if it's a crypto-related market
    const cryptoIndicators = ['bitcoin', 'btc', 'ethereum', 'eth', 'crypto', 'cryptocurrency', 'coin'];
    const isCryptoMarket = cryptoIndicators.some(indicator => question.includes(indicator));

    if (!isCryptoMarket) {
      return { isInvalidCrypto: false };
    }

    // If crypto, check for price prediction patterns
    const pricePredictionPatterns = [
      'price',
      'reach',
      'hit',
      '$',
      'above',
      'below',
      'trading at',
      'trade above',
      'all-time high',
      'ath'
    ];

    const isPricePrediction = pricePredictionPatterns.some(pattern =>
      question.includes(pattern)
    );

    // Check for allowed event-based patterns
    const allowedCryptoPatterns = [
      'etf',
      'approval',
      'launch',
      'mainnet',
      'fork',
      'halving',
      'listing',
      'sec'
    ];

    const hasEventPattern = allowedCryptoPatterns.some(pattern =>
      question.includes(pattern)
    );

    // Invalid if it's price prediction and no event pattern
    if (isPricePrediction && !hasEventPattern) {
      logger.debug('Crypto market rejected: price prediction without event catalyst');
      return { isInvalidCrypto: true };
    }

    return { isInvalidCrypto: false };
  }

  /**
   * Check if a market meets the volume threshold for its category
   */
  checkVolumeThreshold(market: Market): VolumeFilterResult {
    const category = market.category || 'uncategorized';
    const actualVolume = market.volumeNum || 0;
    const requiredVolume = this.volumeThresholds[category] || this.volumeThresholds.uncategorized;

    // Blacklisted markets always fail
    if (market.isBlacklisted) {
      return {
        passed: false,
        requiredVolume,
        actualVolume,
        category,
        reason: 'Market is blacklisted (price prediction or non-event-based)'
      };
    }

    // Check volume threshold
    const passed = actualVolume >= requiredVolume;

    return {
      passed,
      requiredVolume,
      actualVolume,
      category,
      reason: passed ? undefined : `Volume $${actualVolume.toFixed(0)} below threshold $${requiredVolume} for ${category}`
    };
  }

  /**
   * Filter markets based on category-specific volume thresholds
   * Returns only markets that meet their category's volume requirement
   */
  filterMarketsByVolume(markets: Market[]): { passed: Market[]; filtered: Market[]; stats: VolumeFilterStats } {
    const passed: Market[] = [];
    const filtered: Market[] = [];
    const stats: VolumeFilterStats = {
      totalMarkets: markets.length,
      passedMarkets: 0,
      filteredMarkets: 0,
      byCategory: {}
    };

    for (const market of markets) {
      const result = this.checkVolumeThreshold(market);
      const category = result.category;

      // Initialize category stats if needed
      if (!stats.byCategory[category]) {
        stats.byCategory[category] = {
          passed: 0,
          filtered: 0,
          totalVolume: 0
        };
      }

      // Update category volume
      stats.byCategory[category].totalVolume += result.actualVolume;

      if (result.passed) {
        passed.push(market);
        stats.passedMarkets++;
        stats.byCategory[category].passed++;
      } else {
        filtered.push(market);
        stats.filteredMarkets++;
        stats.byCategory[category].filtered++;

        logger.debug(`Market filtered: ${result.reason}`, {
          marketId: market.id,
          question: market.question?.substring(0, 80),
          category: result.category,
          volume: result.actualVolume,
          required: result.requiredVolume
        });
      }
    }

    // Log comprehensive filtering summary
    advancedLogger.info('Volume filtering completed', {
      component: 'market_categorizer',
      operation: 'filter_markets_by_volume',
      metadata: {
        totalMarkets: stats.totalMarkets,
        passedMarkets: stats.passedMarkets,
        filteredMarkets: stats.filteredMarkets,
        filterRate: `${((stats.filteredMarkets / stats.totalMarkets) * 100).toFixed(1)}%`,
        categoryBreakdown: Object.entries(stats.byCategory).map(([cat, data]) => ({
          category: cat,
          passed: data.passed,
          filtered: data.filtered,
          avgVolume: data.totalVolume / (data.passed + data.filtered)
        }))
      }
    });

    return { passed, filtered, stats };
  }

  /**
   * Get the volume threshold for a specific category
   */
  getVolumeThreshold(category: string): number {
    return this.volumeThresholds[category] || this.volumeThresholds.uncategorized;
  }

  /**
   * Get all volume thresholds
   */
  getVolumeThresholds(): Record<string, number> {
    return { ...this.volumeThresholds };
  }

  /**
   * Calculate opportunity score for a market (0-100 scale)
   * Combines volume, edge, catalyst timing, and market quality
   */
  calculateOpportunityScore(market: Market): OpportunityScore {
    if (!this.opportunityScoringConfig.enabled) {
      return {
        total: 50,
        volumeScore: 0,
        edgeScore: 0,
        catalystScore: 0,
        qualityScore: 0,
        breakdown: {
          volumeRatio: 0,
          edgeMultiplier: 0,
          daysToClose: 0,
          spreadBps: 0,
          marketAgeDays: 0
        }
      };
    }

    const category = market.category || 'uncategorized';
    const volume = market.volumeNum || 0;
    const categoryScore = market.categoryScore || 0;
    const outcomeCount = market.outcomeCount || 2;
    const spread = market.spread || 0;
    const marketAge = market.marketAge || 0;
    const timeToClose = market.timeToClose || Infinity;

    const threshold = this.volumeThresholds[category] || this.volumeThresholds.uncategorized;
    const volumeRatio = volume / threshold;
    const daysToClose = timeToClose / (1000 * 60 * 60 * 24);
    const marketAgeDays = marketAge / (1000 * 60 * 60 * 24);

    // Component 1: Volume Score (0-30)
    const volumeScore = this.calculateVolumeScore(volumeRatio);

    // Component 2: Edge Score (0-25)
    const edgeScore = this.calculateEdgeScore(category, categoryScore, outcomeCount);

    // Component 3: Catalyst Score (0-25)
    const catalystScore = this.calculateCatalystScore(daysToClose);

    // Component 4: Quality Score (0-20)
    const qualityScore = this.calculateQualityScore(spread, marketAgeDays, volumeRatio);

    // Combine into total (0-100)
    const total = Math.round(volumeScore + edgeScore + catalystScore + qualityScore);

    const edgeMultiplier = this.opportunityScoringConfig.edgeScore.highEdgeCategories[category] || 0.5;

    return {
      total: Math.min(100, Math.max(0, total)),
      volumeScore: Math.round(volumeScore * 10) / 10,
      edgeScore: Math.round(edgeScore * 10) / 10,
      catalystScore: Math.round(catalystScore * 10) / 10,
      qualityScore: Math.round(qualityScore * 10) / 10,
      breakdown: {
        volumeRatio: Math.round(volumeRatio * 100) / 100,
        edgeMultiplier: Math.round(edgeMultiplier * 100) / 100,
        daysToClose: Math.round(daysToClose * 10) / 10,
        spreadBps: Math.round(spread),
        marketAgeDays: Math.round(marketAgeDays * 10) / 10
      }
    };
  }

  /**
   * Calculate volume score (0-30): Balance liquidity vs efficiency
   * Sweet spot: 1.5x threshold, penalties for too low or too high
   */
  private calculateVolumeScore(volumeRatio: number): number {
    const config = this.opportunityScoringConfig.volumeScore;
    const maxPoints = config.weight * 100; // 30 points

    // Optimal volume: 1.5x threshold
    const optimalRatio = config.optimalVolumeMultiplier;

    // Penalize extreme illiquidity (<30% of threshold)
    if (volumeRatio < config.illiquidityPenaltyThreshold) {
      const penalty = (config.illiquidityPenaltyThreshold - volumeRatio) / config.illiquidityPenaltyThreshold;
      return maxPoints * (1 - penalty * 0.7); // Up to 70% penalty
    }

    // Penalize extreme efficiency (>5x threshold = market too efficient)
    if (volumeRatio > config.efficiencyPenaltyThreshold) {
      const excess = volumeRatio - config.efficiencyPenaltyThreshold;
      const penalty = Math.min(excess / 10, 0.5); // Up to 50% penalty
      return maxPoints * (1 - penalty);
    }

    // Between 30% and 5x: use gaussian-like curve centered at optimal
    const distance = Math.abs(volumeRatio - optimalRatio);
    const normalizedDistance = distance / optimalRatio;
    const score = Math.exp(-normalizedDistance * normalizedDistance);

    return maxPoints * score;
  }

  /**
   * Calculate edge score (0-25): Information advantage
   * Based on category edge multiplier, category confidence, and multi-outcome bonus
   */
  private calculateEdgeScore(category: string, categoryScore: number, outcomeCount: number): number {
    const config = this.opportunityScoringConfig.edgeScore;
    const maxPoints = config.weight * 100; // 25 points

    // Base edge from category
    const edgeMultiplier = config.highEdgeCategories[category] || 0.5;
    let score = edgeMultiplier * maxPoints;

    // Category confidence factor (higher score = more confident categorization)
    const categoryConfidence = Math.min(categoryScore / 10, 1.0);
    score *= (0.6 + 0.4 * categoryConfidence); // Scale by 0.6-1.0 based on confidence

    // Multi-outcome bonus
    if (outcomeCount >= 5) {
      const bonus = Math.min((outcomeCount - 4) * config.multiOutcomeBonus, config.maxMultiOutcomeBonus);
      score += bonus;
    }

    return Math.min(score, maxPoints);
  }

  /**
   * Calculate catalyst score (0-25): Time urgency
   * Sweet spot: 4 days before close, penalties for too soon or too far
   */
  private calculateCatalystScore(daysToClose: number): number {
    const config = this.opportunityScoringConfig.catalystScore;
    const maxPoints = config.weight * 100; // 25 points

    // Too soon to act (<12 hours)
    if (daysToClose < config.minDaysToClose) {
      return maxPoints * 0.3; // 30% score if too urgent
    }

    // Too far to matter (>30 days)
    if (daysToClose > config.maxDaysToClose) {
      const decay = Math.exp(-(daysToClose - config.maxDaysToClose) / 30);
      return maxPoints * 0.5 * decay; // Decay from 50%
    }

    // Sweet spot: gaussian curve centered at optimal (4 days)
    const distance = Math.abs(daysToClose - config.optimalDaysToClose);
    const sigma = config.optimalDaysToClose / 2; // Standard deviation
    const gaussian = Math.exp(-(distance * distance) / (2 * sigma * sigma));
    let score = maxPoints * gaussian;

    // Urgency multiplier for markets closing within 7 days
    if (daysToClose <= 7) {
      score *= config.urgencyMultiplier;
      score = Math.min(score, maxPoints); // Cap at max
    }

    return score;
  }

  /**
   * Calculate quality score (0-20): Market efficiency indicators
   * Based on spread, market age, and liquidity depth
   */
  private calculateQualityScore(spreadBps: number, marketAgeDays: number, volumeRatio: number): number {
    const config = this.opportunityScoringConfig.qualityScore;
    const maxPoints = config.weight * 100; // 20 points

    // Spread component: wider spread = more opportunity
    // Optimal: 150 bps spread
    const spreadDistance = Math.abs(spreadBps - config.optimalSpreadBps);
    const spreadScore = Math.exp(-spreadDistance / 100) * config.spreadWeight * maxPoints;

    // Age component: newer = less discovered
    // Markets <7 days old get bonus, decay after 60 days
    let ageScore: number;
    if (marketAgeDays < 7) {
      ageScore = config.ageWeight * maxPoints; // Full points for new markets
    } else if (marketAgeDays < config.maxAgeDays) {
      const ageFactor = 1 - (marketAgeDays - 7) / (config.maxAgeDays - 7);
      ageScore = ageFactor * config.ageWeight * maxPoints;
    } else {
      ageScore = 0; // No age bonus for old markets
    }

    // Liquidity component: decent liquidity (but not too much)
    // Best: 0.5x - 3x threshold
    let liquidityScore: number;
    if (volumeRatio >= 0.5 && volumeRatio <= 3.0) {
      liquidityScore = config.liquidityWeight * maxPoints;
    } else if (volumeRatio < 0.5) {
      liquidityScore = (volumeRatio / 0.5) * config.liquidityWeight * maxPoints;
    } else {
      const penalty = Math.min((volumeRatio - 3.0) / 10, 0.7);
      liquidityScore = (1 - penalty) * config.liquidityWeight * maxPoints;
    }

    return spreadScore + ageScore + liquidityScore;
  }

  /**
   * Assign tier to a market based on volume and watchlist criteria
   */
  assignTier(market: Market): TierAssignment {
    const category = market.category || 'uncategorized';
    const volume = market.volumeNum || 0;
    const categoryScore = market.categoryScore || 0;
    const outcomeCount = market.outcomeCount || 2;
    const timeToClose = market.timeToClose || Infinity;
    const daysToClose = timeToClose / (1000 * 60 * 60 * 24);

    // Blacklisted markets are always ignored
    if (market.isBlacklisted) {
      return {
        tier: MarketTier.IGNORED,
        reason: 'Blacklisted (price prediction or non-event-based)',
        watchlistSignals: [],
        priority: 0
      };
    }

    // Markets below absolute minimum volume floor are ignored
    if (volume < this.watchlistCriteria.minVolumeFloor) {
      return {
        tier: MarketTier.IGNORED,
        reason: `Volume $${volume.toFixed(0)} below absolute minimum floor $${this.watchlistCriteria.minVolumeFloor}`,
        watchlistSignals: [],
        priority: 0
      };
    }

    // Check if market meets volume threshold for active tier
    const requiredVolume = this.volumeThresholds[category] || this.volumeThresholds.uncategorized;
    if (volume >= requiredVolume) {
      return {
        tier: MarketTier.ACTIVE,
        reason: `Volume $${volume.toFixed(0)} meets threshold $${requiredVolume} for ${category}`,
        watchlistSignals: [],
        priority: this.calculatePriority(market, volume, requiredVolume)
      };
    }

    // Market didn't meet volume threshold - evaluate for watchlist
    if (!this.watchlistCriteria.enabled) {
      return {
        tier: MarketTier.IGNORED,
        reason: `Volume $${volume.toFixed(0)} below threshold $${requiredVolume}, watchlist disabled`,
        watchlistSignals: [],
        priority: 0
      };
    }

    // Evaluate watchlist signals
    const watchlistSignals: string[] = [];
    const criteria = this.watchlistCriteria.criteria;

    // Signal 1: High category score (strong keyword match)
    if (categoryScore >= criteria.minCategoryScore) {
      watchlistSignals.push(`Strong category match (score: ${categoryScore})`);
    }

    // Signal 2: Multi-outcome market
    if (outcomeCount >= criteria.minOutcomeCount) {
      watchlistSignals.push(`Multi-outcome market (${outcomeCount} outcomes)`);
    }

    // Signal 3: Closing soon (catalyst approaching)
    if (daysToClose <= criteria.maxDaysToClose) {
      watchlistSignals.push(`Closing soon (${daysToClose.toFixed(1)} days)`);
    }

    // Signal 4: High-edge category
    if (criteria.highEdgeCategories.includes(category)) {
      watchlistSignals.push(`High-edge category (${category})`);
    }

    // Decide watchlist eligibility
    const minSignalsRequired = criteria.requireMultipleSignals ? 2 : 1;
    if (watchlistSignals.length >= minSignalsRequired) {
      return {
        tier: MarketTier.WATCHLIST,
        reason: `${watchlistSignals.length} watchlist signals met`,
        watchlistSignals,
        priority: this.calculatePriority(market, volume, requiredVolume, watchlistSignals.length)
      };
    }

    // No signals met - ignore
    return {
      tier: MarketTier.IGNORED,
      reason: `Only ${watchlistSignals.length}/${minSignalsRequired} watchlist signals (volume $${volume.toFixed(0)} < $${requiredVolume})`,
      watchlistSignals: [],
      priority: 0
    };
  }

  /**
   * Calculate priority score for a market within its tier (higher = more important)
   */
  private calculatePriority(market: Market, actualVolume: number, requiredVolume: number, watchlistSignals: number = 0): number {
    let priority = 0;

    // Volume factor (how far above/below threshold)
    const volumeRatio = actualVolume / requiredVolume;
    priority += volumeRatio * 100;

    // Category score factor
    const categoryScore = market.categoryScore || 0;
    priority += categoryScore * 10;

    // Multi-outcome bonus
    const outcomeCount = market.outcomeCount || 2;
    if (outcomeCount >= 5) {
      priority += outcomeCount * 2;
    }

    // Time urgency factor (markets closing soon are higher priority)
    const timeToClose = market.timeToClose || Infinity;
    const daysToClose = timeToClose / (1000 * 60 * 60 * 24);
    if (daysToClose <= 7) {
      priority += (7 - daysToClose) * 5; // 0-35 bonus for markets closing within a week
    }

    // Watchlist signals bonus
    priority += watchlistSignals * 15;

    return Math.round(priority);
  }

  /**
   * Assign tiers to a batch of markets and return them sorted by tier and priority
   */
  assignTiers(markets: Market[]): { active: Market[]; watchlist: Market[]; ignored: Market[]; stats: TierStats } {
    const active: Market[] = [];
    const watchlist: Market[] = [];
    const ignored: Market[] = [];
    const stats: TierStats = {
      active: 0,
      watchlist: 0,
      ignored: 0,
      watchlistByReason: {}
    };

    for (const market of markets) {
      const assignment = this.assignTier(market);

      // Attach tier info to market
      market.tier = assignment.tier;
      market.tierReason = assignment.reason;
      market.tierPriority = assignment.priority;
      market.tierUpdatedAt = Date.now();

      // PERFORMANCE OPTIMIZATION: Only calculate expensive opportunity scores for monitored markets
      // Skip IGNORED tier to avoid scoring 2000+ markets that won't be tracked
      if (assignment.tier !== MarketTier.IGNORED) {
        const oppScore = this.calculateOpportunityScore(market);
        market.opportunityScore = oppScore.total;
        market.volumeScore = oppScore.volumeScore;
        market.edgeScore = oppScore.edgeScore;
        market.catalystScore = oppScore.catalystScore;
        market.qualityScore = oppScore.qualityScore;
        market.scoreUpdatedAt = Date.now();
      } else {
        // Set minimal scores for ignored markets
        market.opportunityScore = 0;
        market.volumeScore = 0;
        market.edgeScore = 0;
        market.catalystScore = 0;
        market.qualityScore = 0;
        market.scoreUpdatedAt = Date.now();
      }

      // Sort into tier buckets
      switch (assignment.tier) {
        case MarketTier.ACTIVE:
          active.push(market);
          stats.active++;
          break;
        case MarketTier.WATCHLIST:
          watchlist.push(market);
          stats.watchlist++;

          // Track watchlist reasons
          const signals = assignment.watchlistSignals.length.toString();
          stats.watchlistByReason[signals] = (stats.watchlistByReason[signals] || 0) + 1;
          break;
        case MarketTier.IGNORED:
          ignored.push(market);
          stats.ignored++;
          break;
      }

      logger.debug(`Market assigned to ${assignment.tier} tier`, {
        marketId: market.id,
        question: market.question?.substring(0, 60),
        tier: assignment.tier,
        reason: assignment.reason,
        priority: assignment.priority,
        volume: market.volumeNum
      });
    }

    // Sort by priority within each tier (highest first)
    active.sort((a, b) => (b.tierPriority || 0) - (a.tierPriority || 0));
    watchlist.sort((a, b) => (b.tierPriority || 0) - (a.tierPriority || 0));

    // Enforce watchlist size limit
    const maxWatchlist = this.watchlistCriteria.maxWatchlistSize;
    if (watchlist.length > maxWatchlist) {
      const excess = watchlist.splice(maxWatchlist);
      excess.forEach(m => {
        m.tier = MarketTier.IGNORED;
        m.tierReason = 'Watchlist capacity exceeded';
        ignored.push(m);
      });
      stats.watchlist = watchlist.length;
      stats.ignored += excess.length;
    }

    advancedLogger.info('Tier assignment completed', {
      component: 'market_categorizer',
      operation: 'assign_tiers',
      metadata: {
        totalMarkets: markets.length,
        active: stats.active,
        watchlist: stats.watchlist,
        ignored: stats.ignored,
        watchlistUtilization: `${stats.watchlist}/${maxWatchlist}`,
        watchlistSignalBreakdown: stats.watchlistByReason
      }
    });

    return { active, watchlist, ignored, stats };
  }

  /**
   * Get all enabled categories
   */
  getCategories(): string[] {
    return Object.keys(this.categoryKeywords);
  }

  /**
   * Check if a category is valid
   */
  isValidCategory(category: string): boolean {
    return category in this.categoryKeywords;
  }
}

// Singleton instance
export const marketCategorizer = new MarketCategorizer();
