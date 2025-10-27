import { Market, MarketClassification, MarketFilterConfig } from '../types';
import { logger } from '../utils/logger';
import { advancedLogger } from '../utils/AdvancedLogger';

export class MarketClassifier {
  private config: MarketFilterConfig;
  private trendPatterns: RegExp[];
  private eventKeywords: RegExp[];

  constructor(config: MarketFilterConfig) {
    this.config = config;

    // Compile regex patterns for performance
    this.trendPatterns = config.trendBasedPatterns.map(pattern =>
      new RegExp(pattern, 'i')
    );

    this.eventKeywords = config.eventBasedKeywords.map(keyword =>
      new RegExp(`\\b${keyword}\\b`, 'i')
    );

    advancedLogger.info('MarketClassifier initialized', {
      component: 'market_classifier',
      operation: 'initialize',
      metadata: {
        trendPatterns: config.trendBasedPatterns.length,
        eventKeywords: config.eventBasedKeywords.length,
        scoreThreshold: config.scoreThreshold
      }
    });
  }

  /**
   * Classify a market as event-based or trend-based
   */
  classifyMarket(market: Market): MarketClassification {
    const reasons: string[] = [];
    let score = 0;
    let marketType: MarketClassification['marketType'] = 'general';

    // 1. Time-based scoring (30% weight)
    const timeScore = this.calculateTimeScore(market, reasons);
    score += timeScore;

    // 2. Pattern-based scoring (40% weight)
    const patternScore = this.calculatePatternScore(market, reasons);
    score += patternScore;

    // 3. Tag-based scoring (20% weight)
    const tagScore = this.calculateTagScore(market, reasons);
    score += tagScore;

    // 4. Market type detection (10% weight bonus)
    const typeScore = this.detectMarketType(market, reasons);
    marketType = typeScore.type;
    score += typeScore.score;

    // Determine classification
    const isEventBased = score >= this.config.scoreThreshold;
    const isTrendBased = score < 0;
    const confidence = Math.min(1, Math.abs(score));

    const classification: MarketClassification = {
      marketId: market.id,
      isEventBased,
      isTrendBased,
      score,
      confidence,
      reasons,
      marketType,
      daysToResolution: this.getDaysToResolution(market),
      resolutionDate: this.getResolutionDate(market)
    };

    // Individual market logging removed to prevent Railway log rate limit
    // Summary statistics are logged in filterMarkets() method instead

    return classification;
  }

  /**
   * Calculate time-based score (0.3 weight)
   */
  private calculateTimeScore(market: Market, reasons: string[]): number {
    const daysToResolution = this.getDaysToResolution(market);

    if (daysToResolution === undefined) {
      // No end date - likely trend-based
      reasons.push('No resolution date specified');
      return -0.3;
    }

    if (daysToResolution < this.config.minDaysToResolution) {
      reasons.push(`Resolves soon (${daysToResolution} days)`);
      return 0;  // Don't penalize short-term markets
    }

    if (daysToResolution > this.config.maxDaysToResolution) {
      reasons.push(`Resolves far out (${daysToResolution} days)`);
      return 0;  // Don't penalize long-term markets
    }

    // Optimal range: 1-90 days
    if (daysToResolution <= 30) {
      reasons.push(`Near-term event (${daysToResolution} days)`);
      return 0.3;
    } else if (daysToResolution <= 60) {
      reasons.push(`Medium-term event (${daysToResolution} days)`);
      return 0.2;
    } else {
      reasons.push(`Long-term event (${daysToResolution} days)`);
      return 0.1;
    }
  }

  /**
   * Calculate pattern-based score (0.4 weight)
   */
  private calculatePatternScore(market: Market, reasons: string[]): number {
    let score = 0;
    const question = market.question.toLowerCase();
    const description = market.description?.toLowerCase() || '';
    const text = `${question} ${description}`;

    // Check for trend-based patterns (negative scoring)
    let hasTrendPattern = false;
    for (const pattern of this.trendPatterns) {
      if (pattern.test(text)) {
        const match = text.match(pattern);
        reasons.push(`Trend pattern detected: "${match?.[0]}"`);
        score -= 0.4;
        hasTrendPattern = true;
        break; // One match is enough to disqualify
      }
    }

    // Check for event-based keywords (positive scoring)
    let keywordMatches = 0;
    const matchedKeywords: string[] = [];
    for (const keyword of this.eventKeywords) {
      if (keyword.test(text)) {
        keywordMatches++;
        if (keywordMatches <= 2) {
          const match = text.match(keyword);
          matchedKeywords.push(match?.[0] || '');
        }
      }
    }

    if (keywordMatches > 0) {
      const keywordScore = Math.min(0.4, keywordMatches * 0.15);
      score += keywordScore;
      reasons.push(`Event keywords: ${matchedKeywords.join(', ')}`);

      // Bonus: If has event keyword + year reference + near-term end date, it's likely a legitimate event
      // Example: "Who wins 2025 NYC election?" has "win" + "2025" + end date in 2025
      if (/202[5-9]/.test(text) && !hasTrendPattern) {
        const daysToResolution = this.getDaysToResolution(market);
        if (daysToResolution !== undefined && daysToResolution <= 365) {
          score += 0.1; // Bonus for year-referenced events with near-term resolution
          reasons.push(`Event with year reference and near-term resolution`);
        }
      }
    }

    return score;
  }

  /**
   * Calculate tag-based score (0.2 weight)
   */
  private calculateTagScore(market: Market, reasons: string[]): number {
    if (!market.tags || market.tags.length === 0) {
      return 0;
    }

    let score = 0;
    const tags = market.tags.map(t => t.toLowerCase());

    // Check for excluded tags
    const excludedTags = tags.filter(tag =>
      this.config.excludeTags.some(excluded => tag.includes(excluded.toLowerCase()))
    );

    if (excludedTags.length > 0) {
      reasons.push(`Excluded tags: ${excludedTags.join(', ')}`);
      score -= 0.2;
    }

    // Check for included tags
    const includedTags = tags.filter(tag =>
      this.config.includeTags.some(included => tag.includes(included.toLowerCase()))
    );

    if (includedTags.length > 0) {
      reasons.push(`Event tags: ${includedTags.join(', ')}`);
      score += 0.2;
    }

    return score;
  }

  /**
   * Detect market type and provide bonus scoring (0.1 weight)
   */
  private detectMarketType(market: Market, reasons: string[]): { type: MarketClassification['marketType']; score: number } {
    const question = market.question.toLowerCase();
    const description = market.description?.toLowerCase() || '';
    const text = `${question} ${description}`;

    // Earnings-related
    if (/\b(earnings|eps|revenue|guidance|beat|miss)\b/i.test(text)) {
      reasons.push('Market type: Earnings report');
      return { type: 'earnings', score: 0.1 };
    }

    // Election-related
    if (/\b(election|win|primary|caucus|vote|poll|candidate)\b/i.test(text) &&
        /\b(president|mayor|governor|senate|congress|mp)\b/i.test(text)) {
      reasons.push('Market type: Election');
      return { type: 'election', score: 0.1 };
    }

    // Sports-related
    if (/\b(win|lose|score|game|match|championship|playoff|super bowl|world series)\b/i.test(text) &&
        /\b(team|player|nfl|nba|mlb|nhl|soccer|football|basketball)\b/i.test(text)) {
      reasons.push('Market type: Sports event');
      return { type: 'sports', score: 0.1 };
    }

    // Legal/Political
    if (/\b(indicted|convicted|sentenced|charged|arrested|impeach|resign)\b/i.test(text)) {
      reasons.push('Market type: Legal/Political event');
      return { type: 'legal', score: 0.1 };
    }

    // News/Announcement
    if (/\b(announce|release|unveil|launch|publish|report this week|this month)\b/i.test(text)) {
      reasons.push('Market type: News/Announcement');
      return { type: 'news', score: 0.1 };
    }

    // Crypto price prediction (trend-based, negative score)
    if (/\b(bitcoin|btc|ethereum|eth|solana|sol|crypto)\b/i.test(text) &&
        /\b(hit|reach|\$\d+|price|above|below)\b/i.test(text)) {
      reasons.push('Market type: Crypto price prediction (trend-based)');
      return { type: 'crypto-price', score: -0.1 };
    }

    return { type: 'general', score: 0 };
  }

  /**
   * Get days until market resolution
   */
  private getDaysToResolution(market: Market): number | undefined {
    const resolutionDate = this.getResolutionDate(market);
    if (!resolutionDate) return undefined;

    const now = new Date();
    const diffMs = resolutionDate.getTime() - now.getTime();
    const days = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

    return days;
  }

  /**
   * Get market resolution date
   */
  private getResolutionDate(market: Market): Date | undefined {
    if (!market.endDate) return undefined;

    try {
      const date = new Date(market.endDate);
      if (isNaN(date.getTime())) return undefined;
      return date;
    } catch {
      return undefined;
    }
  }

  /**
   * Check if a market should be filtered (convenience method)
   */
  shouldFilterMarket(market: Market): boolean {
    if (!this.config.enabled) return false;

    const classification = this.classifyMarket(market);
    return !classification.isEventBased;
  }

  /**
   * Filter an array of markets
   */
  filterMarkets(markets: Market[]): Market[] {
    if (!this.config.enabled) {
      logger.info('Market filtering is disabled');
      return markets;
    }

    const startCount = markets.length;
    const filtered = markets.filter(m => !this.shouldFilterMarket(m));
    const filteredCount = startCount - filtered.length;

    advancedLogger.info('Markets filtered for event-based trading', {
      component: 'market_classifier',
      operation: 'filter_markets',
      metadata: {
        totalMarkets: startCount,
        filteredOut: filteredCount,
        remaining: filtered.length,
        filterRate: `${((filteredCount / startCount) * 100).toFixed(1)}%`
      }
    });

    // Log sample of filtered markets
    if (filteredCount > 0) {
      const samples = markets
        .filter(m => this.shouldFilterMarket(m))
        .slice(0, 3)
        .map(m => ({
          question: m.question.substring(0, 60),
          classification: this.classifyMarket(m)
        }));

      logger.debug(`Sample filtered markets: ${JSON.stringify(samples, null, 2)}`);
    }

    return filtered;
  }

  /**
   * Get classification statistics
   */
  getStatistics(markets: Market[]): {
    total: number;
    eventBased: number;
    trendBased: number;
    byType: Record<string, number>;
  } {
    const stats = {
      total: markets.length,
      eventBased: 0,
      trendBased: 0,
      byType: {} as Record<string, number>
    };

    for (const market of markets) {
      const classification = this.classifyMarket(market);

      if (classification.isEventBased) stats.eventBased++;
      if (classification.isTrendBased) stats.trendBased++;

      const type = classification.marketType || 'general';
      stats.byType[type] = (stats.byType[type] || 0) + 1;
    }

    return stats;
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<MarketFilterConfig>): void {
    this.config = { ...this.config, ...config };

    // Recompile patterns if they changed
    if (config.trendBasedPatterns) {
      this.trendPatterns = this.config.trendBasedPatterns.map(pattern =>
        new RegExp(pattern, 'i')
      );
    }

    if (config.eventBasedKeywords) {
      this.eventKeywords = this.config.eventBasedKeywords.map(keyword =>
        new RegExp(`\\b${keyword}\\b`, 'i')
      );
    }

    advancedLogger.info('MarketClassifier configuration updated', {
      component: 'market_classifier',
      operation: 'update_config',
      metadata: config
    });
  }
}
