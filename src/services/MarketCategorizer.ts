import { Market } from '../types';
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

/**
 * MarketCategorizer - Detects market categories based on keyword matching
 * and applies category-specific volume thresholds
 *
 * Categorizes markets into news-driven, event-based categories that have
 * information edges and clear resolution criteria.
 */
export class MarketCategorizer {
  private volumeThresholds: Record<string, number>;
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
    'trading below'
  ];

  /**
   * Initialize the categorizer with volume thresholds
   */
  constructor(volumeThresholds?: Record<string, number>) {
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
