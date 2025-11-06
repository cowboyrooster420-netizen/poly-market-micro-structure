import { 
  EnhancedMicrostructureMetrics, 
  Market, 
  EarlySignal, 
  BotConfig,
  LeakDetectionSignal 
} from '../types';
import { logger } from '../utils/logger';

export interface FrontRunningScore {
  marketId: string;
  score: number;
  confidence: number;
  leakProbability: number;
  timeToNews: number; // Estimated minutes until news breaks
  components: {
    microPriceWeight: number;
    volumeWeight: number;
    liquidityDropWeight: number;
    spreadStabilityBonus: number;
    crossMarketConfirmation: number;
    offHoursMultiplier: number;
  };
  metadata: {
    microPriceDelta: number;
    volumeWeighted: number;
    liquidityDrop: number;
    spreadBps: number;
    correlatedMarkets: number;
    isOffHours: boolean;
    topicCluster?: string;
  };
}

export interface LeakageEvent {
  marketId: string;
  timestamp: number;
  frontRunScore: number;
  actualNewsTime?: number; // When news actually broke
  leadTime?: number; // How early we detected it
  validated: boolean;
  signalType: string;
}

export class FrontRunningHeuristicEngine {
  private config: BotConfig;
  private marketScores: Map<string, FrontRunningScore> = new Map();
  private historicalLeaks: LeakageEvent[] = [];
  private scoreHistory: Map<string, number[]> = new Map(); // For calibration
  
  // Configurable parameters for the heuristic
  private readonly HEURISTIC_PARAMS = {
    // Base thresholds
    MIN_LEAK_SCORE: 0.5,
    HIGH_CONFIDENCE_THRESHOLD: 0.8,
    CRITICAL_THRESHOLD: 0.9,
    
    // Component weights for the main formula
    // Score = (Δmicroprice × Δvolume_weighted × liquidity_drop) / (spread_bps + ε)
    MICRO_PRICE_WEIGHT: 100,
    VOLUME_WEIGHT: 10,
    LIQUIDITY_DROP_WEIGHT: 0.5,
    SPREAD_EPSILON: 1, // Prevent division by zero
    
    // Bonus multipliers
    SPREAD_STABILITY_BONUS: 1.2, // When spread is stable during activity
    CROSS_MARKET_MULTIPLIER: 1.5, // When multiple markets move together
    OFF_HOURS_MULTIPLIER: 2.0, // Higher weight for off-hours activity
    
    // Time predictions (minutes)
    BASE_TIME_TO_NEWS: 5, // Base estimate: 5 minutes
    MAX_TIME_TO_NEWS: 30, // Maximum prediction window
    
    // Historical validation
    MAX_HISTORICAL_EVENTS: 1000,
    VALIDATION_WINDOW_HOURS: 2, // How long to wait for news validation
  };

  constructor(config: BotConfig) {
    this.config = config;
  }

  /**
   * Calculate front-running score using the core heuristic formula
   */
  calculateFrontRunScore(
    metrics: EnhancedMicrostructureMetrics,
    market: Market,
    correlatedMarkets: Market[] = [],
    topicCluster?: string
  ): FrontRunningScore {
    const marketId = metrics.marketId;
    
    // Core Formula: Score = (Δmicroprice × Δvolume_weighted × liquidity_drop) / (spread_bps + ε)
    const microPriceDelta = Math.abs(metrics.microPriceDrift);
    const volumeWeighted = this.calculateVolumeWeight(market, metrics);
    const liquidityDrop = Math.abs(metrics.depth1Change);
    const spreadBps = Math.max(metrics.spreadBps, this.HEURISTIC_PARAMS.SPREAD_EPSILON);
    
    // Base score calculation
    const baseScore = (microPriceDelta * volumeWeighted * liquidityDrop) / spreadBps;
    
    // Component analysis
    const components = {
      microPriceWeight: microPriceDelta * this.HEURISTIC_PARAMS.MICRO_PRICE_WEIGHT,
      volumeWeight: volumeWeighted * this.HEURISTIC_PARAMS.VOLUME_WEIGHT,
      liquidityDropWeight: liquidityDrop * this.HEURISTIC_PARAMS.LIQUIDITY_DROP_WEIGHT,
      spreadStabilityBonus: this.calculateSpreadStabilityBonus(metrics),
      crossMarketConfirmation: this.calculateCrossMarketBonus(correlatedMarkets),
      offHoursMultiplier: this.calculateOffHoursMultiplier(metrics.timestamp)
    };
    
    // Apply bonuses and multipliers
    let adjustedScore = baseScore;
    adjustedScore *= components.spreadStabilityBonus;
    adjustedScore *= components.crossMarketConfirmation;
    adjustedScore *= components.offHoursMultiplier;
    
    // Normalize score to 0-1 range
    const normalizedScore = Math.tanh(adjustedScore / 10); // Sigmoid-like normalization
    
    // Calculate confidence based on multiple factors
    const confidence = this.calculateConfidence(metrics, components, correlatedMarkets);
    
    // Calculate leak probability
    const leakProbability = this.calculateLeakProbability(normalizedScore, confidence, components);
    
    // Estimate time to news
    const timeToNews = this.estimateTimeToNews(normalizedScore, components);
    
    const score: FrontRunningScore = {
      marketId,
      score: normalizedScore,
      confidence,
      leakProbability,
      timeToNews,
      components,
      metadata: {
        microPriceDelta,
        volumeWeighted,
        liquidityDrop,
        spreadBps,
        correlatedMarkets: correlatedMarkets.length,
        isOffHours: components.offHoursMultiplier > 1,
        topicCluster
      }
    };
    
    // Store score and maintain history
    this.marketScores.set(marketId, score);
    this.updateScoreHistory(marketId, normalizedScore);
    
    // Log significant scores
    if (normalizedScore > this.HEURISTIC_PARAMS.MIN_LEAK_SCORE) {
      logger.info(`🎯 FRONT-RUN SCORE: ${marketId.substring(0, 8)}...`, {
        score: normalizedScore.toFixed(3),
        confidence: confidence.toFixed(3),
        leakProbability: (leakProbability * 100).toFixed(1) + '%',
        timeToNews: timeToNews.toFixed(1) + 'min',
        microPrice: microPriceDelta.toFixed(6),
        liquidityDrop: liquidityDrop.toFixed(1) + '%',
        correlatedMarkets: correlatedMarkets.length,
        topicCluster
      });
    }
    
    return score;
  }

  /**
   * Calculate volume weight component
   */
  private calculateVolumeWeight(market: Market, metrics: EnhancedMicrostructureMetrics): number {
    // Use volume z-score as weight, with baseline normalization
    const volumeWeight = Math.max(1, metrics.volumeZScore);
    
    // Apply market size normalization
    const sizeMultiplier = Math.log10(Math.max(1000, market.volumeNum)) / 6; // Normalize to log scale
    
    return volumeWeight * sizeMultiplier;
  }

  /**
   * Calculate spread stability bonus
   */
  private calculateSpreadStabilityBonus(metrics: EnhancedMicrostructureMetrics): number {
    // Bonus when spread is stable (< 10% change) during high activity
    const spreadStable = Math.abs(metrics.spreadChange) < 10;
    const hasActivity = metrics.depthZScore > 2 || metrics.imbalanceZScore > 2;
    
    return (spreadStable && hasActivity) ? this.HEURISTIC_PARAMS.SPREAD_STABILITY_BONUS : 1.0;
  }

  /**
   * Calculate cross-market confirmation bonus
   */
  private calculateCrossMarketBonus(correlatedMarkets: Market[]): number {
    if (correlatedMarkets.length < 2) return 1.0;
    
    // Bonus increases with number of correlated markets, capped at 3x
    const bonus = 1 + (correlatedMarkets.length - 1) * 0.2;
    return Math.min(bonus, this.HEURISTIC_PARAMS.CROSS_MARKET_MULTIPLIER);
  }

  /**
   * Calculate off-hours multiplier
   */
  private calculateOffHoursMultiplier(timestamp: number): number {
    const hour = new Date(timestamp).getHours();
    const isOffHours = hour < 6 || hour > 22; // 10 PM - 6 AM EST
    
    return isOffHours ? this.HEURISTIC_PARAMS.OFF_HOURS_MULTIPLIER : 1.0;
  }

  /**
   * Calculate overall confidence score
   */
  private calculateConfidence(
    metrics: EnhancedMicrostructureMetrics,
    components: any,
    correlatedMarkets: Market[]
  ): number {
    let confidence = 0;
    
    // Base confidence from microstructure strength
    if (metrics.microPriceDrift > 0.001) confidence += 0.3;
    if (metrics.liquidityVacuum) confidence += 0.2;
    if (metrics.imbalanceZScore > 2) confidence += 0.2; // Lowered from 3 to 2
    
    // Bonus from cross-market confirmation
    if (correlatedMarkets.length >= 2) confidence += 0.2;
    if (correlatedMarkets.length >= 3) confidence += 0.1;
    
    // Z-score strength bonus
    const avgZScore = (metrics.depthZScore + metrics.imbalanceZScore + metrics.volumeZScore) / 3;
    if (avgZScore > 2) confidence += 0.1; // Lowered from 3 to 2
    if (avgZScore > 4) confidence += 0.1; // Lowered from 5 to 4
    
    // Off-hours bonus (higher confidence for off-hours signals)
    if (components.offHoursMultiplier > 1) confidence += 0.1;
    
    return Math.min(1.0, confidence);
  }

  /**
   * Calculate probability that this is a genuine information leak
   */
  private calculateLeakProbability(score: number, confidence: number, components: any): number {
    // Base probability from score
    let probability = score * 0.7;
    
    // Confidence adjustment
    probability += confidence * 0.2;
    
    // Component-specific adjustments
    if (components.spreadStabilityBonus > 1) probability += 0.1;
    if (components.crossMarketConfirmation > 1) probability += 0.15;
    if (components.offHoursMultiplier > 1) probability += 0.1;
    
    // Historical calibration (if we have data)
    const historicalAccuracy = this.getHistoricalAccuracy();
    if (historicalAccuracy > 0) {
      probability *= historicalAccuracy;
    }
    
    return Math.min(1.0, Math.max(0.0, probability));
  }

  /**
   * Estimate time until news breaks (in minutes)
   */
  private estimateTimeToNews(score: number, components: any): number {
    // Higher scores suggest shorter time to news
    let timeEstimate = this.HEURISTIC_PARAMS.BASE_TIME_TO_NEWS * (1 - score);
    
    // Adjustments based on signal strength
    if (components.crossMarketConfirmation > 1.2) timeEstimate *= 0.7; // Cross-market suggests imminent news
    if (components.offHoursMultiplier > 1) timeEstimate *= 1.5; // Off-hours might take longer
    if (components.spreadStabilityBonus > 1) timeEstimate *= 0.8; // Stable spread suggests organized activity
    
    // Ensure reasonable bounds
    return Math.max(1, Math.min(timeEstimate, this.HEURISTIC_PARAMS.MAX_TIME_TO_NEWS));
  }

  /**
   * Create leak detection signal when score exceeds threshold
   */
  createLeakSignal(
    score: FrontRunningScore,
    market: Market,
    correlatedMarkets: Market[] = []
  ): EarlySignal | null {
    if (score.score < this.HEURISTIC_PARAMS.MIN_LEAK_SCORE) return null;
    
    const severity = score.score > this.HEURISTIC_PARAMS.CRITICAL_THRESHOLD ? 'critical' :
                    score.score > this.HEURISTIC_PARAMS.HIGH_CONFIDENCE_THRESHOLD ? 'high' : 'medium';
    
    const signal: EarlySignal = {
      marketId: score.marketId,
      market,
      signalType: 'information_leak',
      confidence: score.confidence,
      timestamp: Date.now(),
      metadata: {
        severity,
        signalSource: 'front_running_heuristic',
        frontRunScore: score.score,
        leakProbability: score.leakProbability,
        timeToNews: score.timeToNews,
        correlatedMarkets: correlatedMarkets.map(m => m.id),
        topicCluster: score.metadata.topicCluster,
        components: score.components,
        heuristicData: score.metadata,
        leakType: 'front_running_heuristic'
      }
    };
    
    // Record this as a potential leak event
    this.recordLeakageEvent(score, 'front_running_heuristic');
    
    return signal;
  }

  /**
   * Record a potential leakage event for later validation
   */
  private recordLeakageEvent(score: FrontRunningScore, signalType: string): void {
    const event: LeakageEvent = {
      marketId: score.marketId,
      timestamp: Date.now(),
      frontRunScore: score.score,
      validated: false,
      signalType
    };
    
    this.historicalLeaks.push(event);
    
    // Cleanup old events
    if (this.historicalLeaks.length > this.HEURISTIC_PARAMS.MAX_HISTORICAL_EVENTS) {
      this.historicalLeaks.shift();
    }
  }

  /**
   * Validate a leak event when news actually breaks
   */
  validateLeakEvent(marketId: string, newsTimestamp: number): boolean {
    const validationWindow = this.HEURISTIC_PARAMS.VALIDATION_WINDOW_HOURS * 60 * 60 * 1000;
    let validated = false;
    
    for (const event of this.historicalLeaks) {
      if (event.marketId === marketId && 
          !event.validated &&
          newsTimestamp > event.timestamp &&
          newsTimestamp - event.timestamp < validationWindow) {
        
        event.actualNewsTime = newsTimestamp;
        event.leadTime = (newsTimestamp - event.timestamp) / (60 * 1000); // Convert to minutes
        event.validated = true;
        validated = true;
        
        logger.info(`✅ LEAK VALIDATED: ${marketId.substring(0, 8)}...`, {
          leadTime: event.leadTime.toFixed(1) + 'min',
          score: event.frontRunScore.toFixed(3),
          signalType: event.signalType
        });
      }
    }
    
    return validated;
  }

  /**
   * Get historical accuracy rate for calibration
   */
  private getHistoricalAccuracy(): number {
    const validatedEvents = this.historicalLeaks.filter(e => e.validated);
    const totalPredictions = this.historicalLeaks.filter(e => e.timestamp < Date.now() - this.HEURISTIC_PARAMS.VALIDATION_WINDOW_HOURS * 60 * 60 * 1000);
    
    if (totalPredictions.length < 10) return 0; // Need sufficient data
    
    return validatedEvents.length / totalPredictions.length;
  }

  /**
   * Update score history for a market
   */
  private updateScoreHistory(marketId: string, score: number): void {
    if (!this.scoreHistory.has(marketId)) {
      this.scoreHistory.set(marketId, []);
    }
    
    const history = this.scoreHistory.get(marketId)!;
    history.push(score);
    
    // Keep only last 100 scores
    if (history.length > 100) {
      history.shift();
    }
  }

  /**
   * Get current score for a market
   */
  getMarketScore(marketId: string): FrontRunningScore | null {
    return this.marketScores.get(marketId) || null;
  }

  /**
   * Get top markets by front-running score
   */
  getTopScoringMarkets(limit: number = 10): FrontRunningScore[] {
    return Array.from(this.marketScores.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Get performance statistics
   */
  getPerformanceStats(): {
    totalPredictions: number;
    validatedLeaks: number;
    accuracy: number;
    averageLeadTime: number;
    activeScores: number;
  } {
    const validatedEvents = this.historicalLeaks.filter(e => e.validated);
    const averageLeadTime = validatedEvents.length > 0 ?
      validatedEvents.reduce((sum, e) => sum + (e.leadTime || 0), 0) / validatedEvents.length : 0;
    
    return {
      totalPredictions: this.historicalLeaks.length,
      validatedLeaks: validatedEvents.length,
      accuracy: this.getHistoricalAccuracy(),
      averageLeadTime,
      activeScores: this.marketScores.size
    };
  }

  /**
   * Cleanup stale data
   */
  cleanup(): void {
    const now = Date.now();
    const staleThreshold = 24 * 60 * 60 * 1000; // 24 hours
    
    // Remove stale market scores
    for (const [marketId, score] of this.marketScores) {
      if (now - score.metadata.microPriceDelta > staleThreshold) { // Using microPriceDelta as timestamp proxy
        this.marketScores.delete(marketId);
        this.scoreHistory.delete(marketId);
      }
    }
    
    // Clean up old leak events
    this.historicalLeaks = this.historicalLeaks.filter(event => 
      now - event.timestamp < 7 * 24 * 60 * 60 * 1000 // Keep 7 days
    );
  }

  /**
   * Health check
   */
  healthCheck(): { healthy: boolean; details: any } {
    const stats = this.getPerformanceStats();
    
    return {
      healthy: true, // This service is always healthy unless there's an exception
      details: {
        activeMarkets: this.marketScores.size,
        totalPredictions: stats.totalPredictions,
        accuracy: stats.accuracy,
        averageLeadTime: stats.averageLeadTime,
        historicalEvents: this.historicalLeaks.length,
        lastUpdate: new Date().toISOString()
      }
    };
  }
}