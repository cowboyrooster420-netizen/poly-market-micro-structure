import { Market } from '../types';
import { logger } from '../utils/logger';

export interface CategoryResult {
  category: string | null;
  categoryScore: number;
  isBlacklisted: boolean;
  matchedKeywords: string[];
}

/**
 * MarketCategorizer - Detects market categories based on keyword matching
 *
 * Categorizes markets into news-driven, event-based categories that have
 * information edges and clear resolution criteria.
 */
export class MarketCategorizer {
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
