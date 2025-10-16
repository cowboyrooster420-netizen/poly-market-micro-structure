import { StatisticalModels, StatisticalConfig, ZScoreResult, TrendAnalysis, VolatilityMetrics } from './StatisticalModels';
import { EnhancedMicrostructureMetrics, AnomalyScore } from '../types';
import { logger } from '../utils/logger';

export interface AnomalyDetectionConfig extends StatisticalConfig {
  multivariateSensitivity: number; // Sensitivity for multivariate anomaly detection
  isolationForestContamination: number; // Expected proportion of outliers
  mahalanobisThreshold: number; // Threshold for Mahalanobis distance
  consensusThreshold: number; // Minimum agreement between methods
}

export interface AnomalyDetectionResult {
  isAnomalous: boolean;
  confidence: number;
  anomalyType: string[];
  scores: {
    univariate: Map<string, ZScoreResult>;
    mahalanobis: number;
    isolationForest: number;
    consensus: number;
  };
  severity: 'low' | 'medium' | 'high' | 'critical';
  explanation: string;
  recommendations: string[];
}

export interface MultivariateFeatures {
  volume: number;
  depth: number;
  spread: number;
  imbalance: number;
  microPrice: number;
  volatility: number;
  timestamp: number;
}

export class AnomalyDetector {
  private statisticalModels: StatisticalModels;
  private config: AnomalyDetectionConfig;
  
  // Storage for multivariate analysis
  private featureHistory = new Map<string, MultivariateFeatures[]>();
  private correlationMatrix = new Map<string, number[][]>();
  private covarianceMatrix = new Map<string, number[][]>();
  
  // Isolation Forest simplified implementation
  private isolationTrees = new Map<string, IsolationTree[]>();
  private readonly NUM_TREES = 100;
  private readonly SUBSAMPLE_SIZE = 256;

  constructor(config: AnomalyDetectionConfig) {
    this.config = config;
    this.statisticalModels = new StatisticalModels(config);
    
    logger.info('Advanced anomaly detector initialized with multivariate methods');
  }

  /**
   * Main anomaly detection method that combines multiple approaches
   */
  async detectAnomalies(marketId: string, metrics: EnhancedMicrostructureMetrics): Promise<AnomalyDetectionResult> {
    // Update statistical models with new data
    this.updateStatisticalModels(marketId, metrics);
    
    // Extract features for multivariate analysis
    const features = this.extractFeatures(metrics);
    this.updateFeatureHistory(marketId, features);

    // Run different anomaly detection methods
    const univariateScores = this.performUnivariateDetection(marketId, metrics);
    const mahalanobisScore = this.calculateMahalanobisDistance(marketId, features);
    const isolationScore = this.calculateIsolationForestScore(marketId, features);
    
    // Combine scores using consensus approach
    const consensusScore = this.calculateConsensusScore(univariateScores, mahalanobisScore, isolationScore);
    
    // Determine anomaly status and type
    const isAnomalous = consensusScore > this.config.consensusThreshold;
    const anomalyTypes = this.classifyAnomalyTypes(univariateScores, mahalanobisScore, isolationScore);
    const severity = this.determineSeverity(consensusScore, anomalyTypes);
    
    // Generate explanation and recommendations
    const explanation = this.generateExplanation(univariateScores, mahalanobisScore, isolationScore, anomalyTypes);
    const recommendations = this.generateRecommendations(anomalyTypes, severity);

    return {
      isAnomalous,
      confidence: consensusScore,
      anomalyType: anomalyTypes,
      scores: {
        univariate: univariateScores,
        mahalanobis: mahalanobisScore,
        isolationForest: isolationScore,
        consensus: consensusScore
      },
      severity,
      explanation,
      recommendations
    };
  }

  /**
   * Calculate comprehensive anomaly score for database storage
   */
  calculateAnomalyScore(marketId: string, metrics: EnhancedMicrostructureMetrics): AnomalyScore {
    const features = this.extractFeatures(metrics);
    
    // Individual feature anomaly scores
    const volumeAnomaly = this.statisticalModels.calculateZScore(marketId, 'volume', features.volume).zScore;
    const depthAnomaly = this.statisticalModels.calculateZScore(marketId, 'depth', features.depth).zScore;
    const spreadAnomaly = this.statisticalModels.calculateZScore(marketId, 'spread', features.spread).zScore;
    const imbalanceAnomaly = this.statisticalModels.calculateZScore(marketId, 'imbalance', features.imbalance).zScore;
    const priceAnomaly = this.statisticalModels.calculateZScore(marketId, 'price', features.microPrice).zScore;

    // Combined scores
    const mahalanobisDistance = this.calculateMahalanobisDistance(marketId, features);
    const isolationForestScore = this.calculateIsolationForestScore(marketId, features);
    
    // Weighted combination
    const combinedScore = (
      Math.abs(volumeAnomaly) * 0.2 +
      Math.abs(depthAnomaly) * 0.2 +
      Math.abs(spreadAnomaly) * 0.15 +
      Math.abs(imbalanceAnomaly) * 0.25 +
      Math.abs(priceAnomaly) * 0.2
    ) * 0.5 + (mahalanobisDistance * 0.3 + isolationForestScore * 0.2);

    // Classification
    const isAnomalous = combinedScore > this.config.outlierThreshold;
    const anomalyTypes = this.classifyAnomalyTypes(
      new Map([
        ['volume', { zScore: volumeAnomaly, isAnomaly: Math.abs(volumeAnomaly) > this.config.outlierThreshold } as ZScoreResult],
        ['depth', { zScore: depthAnomaly, isAnomaly: Math.abs(depthAnomaly) > this.config.outlierThreshold } as ZScoreResult],
        ['spread', { zScore: spreadAnomaly, isAnomaly: Math.abs(spreadAnomaly) > this.config.outlierThreshold } as ZScoreResult],
        ['imbalance', { zScore: imbalanceAnomaly, isAnomaly: Math.abs(imbalanceAnomaly) > this.config.outlierThreshold } as ZScoreResult],
        ['price', { zScore: priceAnomaly, isAnomaly: Math.abs(priceAnomaly) > this.config.outlierThreshold } as ZScoreResult]
      ]),
      mahalanobisDistance,
      isolationForestScore
    );

    return {
      marketId,
      timestamp: metrics.timestamp,
      volumeAnomaly: Math.abs(volumeAnomaly),
      depthAnomaly: Math.abs(depthAnomaly),
      spreadAnomaly: Math.abs(spreadAnomaly),
      imbalanceAnomaly: Math.abs(imbalanceAnomaly),
      priceAnomaly: Math.abs(priceAnomaly),
      mahalanobisDistance,
      isolationForestScore,
      combinedScore,
      isAnomalous,
      anomalyType: anomalyTypes,
      confidence: Math.min(combinedScore / this.config.outlierThreshold, 1.0)
    };
  }

  /**
   * Get market risk assessment based on recent anomaly patterns
   */
  getMarketRiskAssessment(marketId: string): {
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
    score: number;
    factors: string[];
    trend: 'improving' | 'stable' | 'deteriorating';
  } {
    const featureHistory = this.featureHistory.get(marketId) || [];
    
    if (featureHistory.length < 10) {
      return {
        riskLevel: 'low',
        score: 0,
        factors: ['Insufficient data for risk assessment'],
        trend: 'stable'
      };
    }

    const recentFeatures = featureHistory.slice(-20); // Last 20 data points
    let anomalyCount = 0;
    let totalRiskScore = 0;
    const riskFactors: string[] = [];

    for (const features of recentFeatures) {
      // Check each feature for anomalies
      const volumeZ = this.statisticalModels.calculateZScore(marketId, 'volume', features.volume);
      const depthZ = this.statisticalModels.calculateZScore(marketId, 'depth', features.depth);
      const spreadZ = this.statisticalModels.calculateZScore(marketId, 'spread', features.spread);
      const imbalanceZ = this.statisticalModels.calculateZScore(marketId, 'imbalance', features.imbalance);

      if (volumeZ.isAnomaly) anomalyCount++;
      if (depthZ.isAnomaly) anomalyCount++;
      if (spreadZ.isAnomaly) anomalyCount++;
      if (imbalanceZ.isAnomaly) anomalyCount++;

      totalRiskScore += Math.abs(volumeZ.zScore) + Math.abs(depthZ.zScore) + Math.abs(spreadZ.zScore) + Math.abs(imbalanceZ.zScore);
    }

    const avgRiskScore = totalRiskScore / recentFeatures.length;
    const anomalyRate = anomalyCount / (recentFeatures.length * 4); // 4 features per data point

    // Determine risk level
    let riskLevel: 'low' | 'medium' | 'high' | 'critical' = 'low';
    if (avgRiskScore > 8 || anomalyRate > 0.3) {
      riskLevel = 'critical';
      riskFactors.push('High frequency of statistical anomalies');
    } else if (avgRiskScore > 5 || anomalyRate > 0.2) {
      riskLevel = 'high';
      riskFactors.push('Elevated anomaly detection signals');
    } else if (avgRiskScore > 2 || anomalyRate > 0.1) {
      riskLevel = 'medium';
      riskFactors.push('Moderate statistical variations detected');
    }

    // Determine trend
    const firstHalf = recentFeatures.slice(0, 10);
    const secondHalf = recentFeatures.slice(10);
    
    const firstHalfScore = this.calculateAverageAnomalyScore(marketId, firstHalf);
    const secondHalfScore = this.calculateAverageAnomalyScore(marketId, secondHalf);
    
    let trend: 'improving' | 'stable' | 'deteriorating' = 'stable';
    const trendDiff = secondHalfScore - firstHalfScore;
    if (trendDiff > 1) {
      trend = 'deteriorating';
    } else if (trendDiff < -1) {
      trend = 'improving';
    }

    return {
      riskLevel,
      score: avgRiskScore,
      factors: riskFactors.length > 0 ? riskFactors : ['Normal market behavior'],
      trend
    };
  }

  // Private methods

  private updateStatisticalModels(marketId: string, metrics: EnhancedMicrostructureMetrics): void {
    // Add data points to statistical models
    this.statisticalModels.addDataPoint(marketId, 'volume', metrics.volumeZScore); // Use raw volume if available
    this.statisticalModels.addDataPoint(marketId, 'depth', metrics.depth1Total);
    this.statisticalModels.addDataPoint(marketId, 'spread', metrics.spreadBps);
    this.statisticalModels.addDataPoint(marketId, 'imbalance', metrics.orderBookImbalance);
    this.statisticalModels.addDataPoint(marketId, 'price', metrics.microPrice);
    
    // Update time-of-day baselines
    this.statisticalModels.updateTimeOfDayBaselines(marketId, metrics.timestamp);
  }

  private extractFeatures(metrics: EnhancedMicrostructureMetrics): MultivariateFeatures {
    return {
      volume: metrics.volumeZScore,
      depth: metrics.depth1Total,
      spread: metrics.spreadBps,
      imbalance: metrics.orderBookImbalance,
      microPrice: metrics.microPrice,
      volatility: Math.abs(metrics.microPriceDrift),
      timestamp: metrics.timestamp
    };
  }

  private updateFeatureHistory(marketId: string, features: MultivariateFeatures): void {
    if (!this.featureHistory.has(marketId)) {
      this.featureHistory.set(marketId, []);
    }
    
    const history = this.featureHistory.get(marketId)!;
    history.push(features);
    
    // Keep only recent history (sliding window)
    if (history.length > this.config.windowSize) {
      history.shift();
    }
    
    // Update covariance matrix periodically
    if (history.length >= this.config.minSampleSize && history.length % 10 === 0) {
      this.updateCovarianceMatrix(marketId, history);
    }
  }

  private performUnivariateDetection(marketId: string, metrics: EnhancedMicrostructureMetrics): Map<string, ZScoreResult> {
    const results = new Map<string, ZScoreResult>();
    
    // Use time-adjusted Z-scores for better anomaly detection
    results.set('volume', this.statisticalModels.calculateTimeAdjustedZScore(marketId, 'volume', metrics.volumeZScore, metrics.timestamp));
    results.set('depth', this.statisticalModels.calculateTimeAdjustedZScore(marketId, 'depth', metrics.depth1Total, metrics.timestamp));
    results.set('spread', this.statisticalModels.calculateTimeAdjustedZScore(marketId, 'spread', metrics.spreadBps, metrics.timestamp));
    results.set('imbalance', this.statisticalModels.calculateTimeAdjustedZScore(marketId, 'imbalance', metrics.orderBookImbalance, metrics.timestamp));
    results.set('price', this.statisticalModels.calculateTimeAdjustedZScore(marketId, 'price', metrics.microPrice, metrics.timestamp));
    
    return results;
  }

  private calculateMahalanobisDistance(marketId: string, features: MultivariateFeatures): number {
    const covMatrix = this.covarianceMatrix.get(marketId);
    const history = this.featureHistory.get(marketId) || [];
    
    if (!covMatrix || history.length < this.config.minSampleSize) {
      return 0;
    }

    // Calculate mean vector
    const means = this.calculateMeanVector(history);
    
    // Feature vector (excluding timestamp)
    const x = [features.volume, features.depth, features.spread, features.imbalance, features.microPrice, features.volatility];
    
    // Calculate difference from mean
    const diff = x.map((val, i) => val - means[i]);
    
    // Calculate Mahalanobis distance: sqrt((x - μ)ᵀ Σ⁻¹ (x - μ))
    try {
      const invCov = this.invertMatrix(covMatrix);
      const mahalanobisSquared = this.quadraticForm(diff, invCov);
      return Math.sqrt(Math.max(0, mahalanobisSquared));
    } catch (error) {
      logger.warn(`Error calculating Mahalanobis distance for market ${marketId}:`, error);
      return 0;
    }
  }

  private calculateIsolationForestScore(marketId: string, features: MultivariateFeatures): number {
    let trees = this.isolationTrees.get(marketId);
    const history = this.featureHistory.get(marketId) || [];
    
    if (!trees || history.length < this.config.minSampleSize) {
      if (history.length >= this.config.minSampleSize) {
        // Build new isolation forest
        trees = this.buildIsolationForest(history);
        this.isolationTrees.set(marketId, trees);
      } else {
        return 0;
      }
    }

    // Calculate anomaly score
    const x = [features.volume, features.depth, features.spread, features.imbalance, features.microPrice, features.volatility];
    let totalPathLength = 0;
    
    for (const tree of trees) {
      totalPathLength += this.getPathLength(tree, x, 0);
    }
    
    const avgPathLength = totalPathLength / trees.length;
    const n = Math.min(history.length, this.SUBSAMPLE_SIZE);
    const expectedLength = this.expectedPathLength(n);
    
    // Anomaly score: higher values indicate more anomalous points
    return Math.pow(2, -avgPathLength / expectedLength);
  }

  private calculateConsensusScore(
    univariateScores: Map<string, ZScoreResult>,
    mahalanobisScore: number,
    isolationScore: number
  ): number {
    // Count univariate anomalies
    let univariateAnomalies = 0;
    let maxUnivariatZ = 0;
    
    for (const [, score] of univariateScores) {
      if (score.isAnomaly) univariateAnomalies++;
      maxUnivariatZ = Math.max(maxUnivariatZ, Math.abs(score.zScore));
    }

    // Normalize scores
    const univariateScore = Math.min(maxUnivariatZ / this.config.outlierThreshold, 1.0);
    const mahalanobisNormalized = Math.min(mahalanobisScore / this.config.mahalanobisThreshold, 1.0);
    const isolationNormalized = isolationScore; // Already normalized

    // Weighted consensus
    const weights = {
      univariate: 0.4,
      mahalanobis: 0.35,
      isolation: 0.25
    };

    return (
      univariateScore * weights.univariate +
      mahalanobisNormalized * weights.mahalanobis +
      isolationNormalized * weights.isolation
    );
  }

  private classifyAnomalyTypes(
    univariateScores: Map<string, ZScoreResult>,
    mahalanobisScore: number,
    isolationScore: number
  ): string[] {
    const types: string[] = [];

    // Check univariate anomalies
    for (const [feature, score] of univariateScores) {
      if (score.isAnomaly) {
        types.push(`${feature}_anomaly`);
      }
    }

    // Check multivariate anomalies
    if (mahalanobisScore > this.config.mahalanobisThreshold) {
      types.push('multivariate_anomaly');
    }

    if (isolationScore > this.config.isolationForestContamination) {
      types.push('isolation_anomaly');
    }

    // Classify combination patterns
    if (types.length >= 3) {
      types.push('systemic_anomaly');
    }

    return types.length > 0 ? types : ['normal'];
  }

  private determineSeverity(consensusScore: number, anomalyTypes: string[]): 'low' | 'medium' | 'high' | 'critical' {
    if (anomalyTypes.includes('systemic_anomaly') || consensusScore > 0.9) {
      return 'critical';
    } else if (anomalyTypes.includes('multivariate_anomaly') || consensusScore > 0.7) {
      return 'high';
    } else if (anomalyTypes.length > 1 || consensusScore > 0.5) {
      return 'medium';
    } else {
      return 'low';
    }
  }

  private generateExplanation(
    univariateScores: Map<string, ZScoreResult>,
    mahalanobisScore: number,
    isolationScore: number,
    anomalyTypes: string[]
  ): string {
    if (anomalyTypes.includes('normal')) {
      return 'Market metrics are within normal statistical ranges.';
    }

    const explanations: string[] = [];

    for (const [feature, score] of univariateScores) {
      if (score.isAnomaly) {
        explanations.push(`${feature} shows ${Math.abs(score.zScore).toFixed(1)} standard deviations from normal`);
      }
    }

    if (mahalanobisScore > this.config.mahalanobisThreshold) {
      explanations.push(`Multivariate pattern significantly deviates from historical norms`);
    }

    if (isolationScore > this.config.isolationForestContamination) {
      explanations.push(`Isolation forest detected unusual feature combinations`);
    }

    return explanations.join('; ');
  }

  private generateRecommendations(anomalyTypes: string[], severity: 'low' | 'medium' | 'high' | 'critical'): string[] {
    const recommendations: string[] = [];

    if (severity === 'critical') {
      recommendations.push('Consider immediate position review and risk assessment');
      recommendations.push('Implement enhanced monitoring and circuit breakers');
    } else if (severity === 'high') {
      recommendations.push('Increase monitoring frequency');
      recommendations.push('Review recent market events and news');
    } else if (severity === 'medium') {
      recommendations.push('Monitor closely for trend continuation');
      recommendations.push('Validate signals with additional data sources');
    }

    if (anomalyTypes.includes('volume_anomaly')) {
      recommendations.push('Investigate unusual volume patterns');
    }

    if (anomalyTypes.includes('spread_anomaly')) {
      recommendations.push('Check for liquidity issues or market maker activity');
    }

    if (anomalyTypes.includes('multivariate_anomaly')) {
      recommendations.push('Examine correlations with broader market movements');
    }

    return recommendations.length > 0 ? recommendations : ['Continue normal monitoring'];
  }

  // Matrix operations and helper methods
  
  private updateCovarianceMatrix(marketId: string, history: MultivariateFeatures[]): void {
    const features = history.map(h => [h.volume, h.depth, h.spread, h.imbalance, h.microPrice, h.volatility]);
    const covMatrix = this.calculateCovarianceMatrix(features);
    this.covarianceMatrix.set(marketId, covMatrix);
  }

  private calculateMeanVector(history: MultivariateFeatures[]): number[] {
    const n = history.length;
    const sums = [0, 0, 0, 0, 0, 0];
    
    for (const h of history) {
      sums[0] += h.volume;
      sums[1] += h.depth;
      sums[2] += h.spread;
      sums[3] += h.imbalance;
      sums[4] += h.microPrice;
      sums[5] += h.volatility;
    }
    
    return sums.map(sum => sum / n);
  }

  private calculateCovarianceMatrix(features: number[][]): number[][] {
    const n = features.length;
    const m = features[0].length;
    
    // Calculate means
    const means = new Array(m).fill(0);
    for (const row of features) {
      for (let j = 0; j < m; j++) {
        means[j] += row[j];
      }
    }
    for (let j = 0; j < m; j++) {
      means[j] /= n;
    }
    
    // Calculate covariance matrix
    const cov = Array(m).fill(null).map(() => Array(m).fill(0));
    
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < m; j++) {
        let sum = 0;
        for (const row of features) {
          sum += (row[i] - means[i]) * (row[j] - means[j]);
        }
        cov[i][j] = sum / (n - 1);
      }
    }
    
    return cov;
  }

  private invertMatrix(matrix: number[][]): number[][] {
    // Simple matrix inversion using Gaussian elimination
    const n = matrix.length;
    const augmented = matrix.map((row, i) => [...row, ...Array(n).fill(0).map((_, j) => i === j ? 1 : 0)]);
    
    // Forward elimination
    for (let i = 0; i < n; i++) {
      // Find pivot
      let maxRow = i;
      for (let k = i + 1; k < n; k++) {
        if (Math.abs(augmented[k][i]) > Math.abs(augmented[maxRow][i])) {
          maxRow = k;
        }
      }
      
      // Swap rows
      [augmented[i], augmented[maxRow]] = [augmented[maxRow], augmented[i]];
      
      // Make diagonal element 1
      const pivot = augmented[i][i];
      if (Math.abs(pivot) < 1e-10) {
        throw new Error('Matrix is singular');
      }
      
      for (let j = 0; j < 2 * n; j++) {
        augmented[i][j] /= pivot;
      }
      
      // Eliminate column
      for (let k = 0; k < n; k++) {
        if (k !== i) {
          const factor = augmented[k][i];
          for (let j = 0; j < 2 * n; j++) {
            augmented[k][j] -= factor * augmented[i][j];
          }
        }
      }
    }
    
    // Extract inverse matrix
    return augmented.map(row => row.slice(n));
  }

  private quadraticForm(vector: number[], matrix: number[][]): number {
    const n = vector.length;
    let result = 0;
    
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        result += vector[i] * matrix[i][j] * vector[j];
      }
    }
    
    return result;
  }

  private buildIsolationForest(history: MultivariateFeatures[]): IsolationTree[] {
    const trees: IsolationTree[] = [];
    const features = history.map(h => [h.volume, h.depth, h.spread, h.imbalance, h.microPrice, h.volatility]);
    
    for (let i = 0; i < this.NUM_TREES; i++) {
      // Random subsample
      const subsample = this.randomSample(features, Math.min(this.SUBSAMPLE_SIZE, features.length));
      const tree = this.buildIsolationTree(subsample, 0, Math.ceil(Math.log2(this.SUBSAMPLE_SIZE)));
      trees.push(tree);
    }
    
    return trees;
  }

  private buildIsolationTree(data: number[][], depth: number, maxDepth: number): IsolationTree {
    if (data.length <= 1 || depth >= maxDepth) {
      return { type: 'leaf', size: data.length };
    }
    
    // Random feature and split point
    const feature = Math.floor(Math.random() * data[0].length);
    const values = data.map(row => row[feature]);
    const min = Math.min(...values);
    const max = Math.max(...values);
    
    if (min === max) {
      return { type: 'leaf', size: data.length };
    }
    
    const splitValue = min + Math.random() * (max - min);
    
    const left = data.filter(row => row[feature] < splitValue);
    const right = data.filter(row => row[feature] >= splitValue);
    
    return {
      type: 'node',
      feature,
      splitValue,
      left: this.buildIsolationTree(left, depth + 1, maxDepth),
      right: this.buildIsolationTree(right, depth + 1, maxDepth)
    };
  }

  private getPathLength(tree: IsolationTree, point: number[], depth: number): number {
    if (tree.type === 'leaf') {
      return depth + this.expectedPathLength(tree.size || 1);
    }
    
    if (point[tree.feature!] < tree.splitValue!) {
      return this.getPathLength(tree.left!, point, depth + 1);
    } else {
      return this.getPathLength(tree.right!, point, depth + 1);
    }
  }

  private expectedPathLength(n: number): number {
    if (n <= 1) return 0;
    return 2 * (Math.log(n - 1) + 0.5772156649) - 2 * (n - 1) / n; // Euler's constant ≈ 0.5772156649
  }

  private randomSample<T>(array: T[], size: number): T[] {
    const result = [...array];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result.slice(0, size);
  }

  private calculateAverageAnomalyScore(marketId: string, features: MultivariateFeatures[]): number {
    let totalScore = 0;
    
    for (const feature of features) {
      const volumeZ = this.statisticalModels.calculateZScore(marketId, 'volume', feature.volume);
      const depthZ = this.statisticalModels.calculateZScore(marketId, 'depth', feature.depth);
      const spreadZ = this.statisticalModels.calculateZScore(marketId, 'spread', feature.spread);
      const imbalanceZ = this.statisticalModels.calculateZScore(marketId, 'imbalance', feature.imbalance);
      
      totalScore += Math.abs(volumeZ.zScore) + Math.abs(depthZ.zScore) + Math.abs(spreadZ.zScore) + Math.abs(imbalanceZ.zScore);
    }
    
    return totalScore / features.length;
  }
}

// Supporting interfaces
interface IsolationTree {
  type: 'leaf' | 'node';
  size?: number; // For leaf nodes
  feature?: number; // For internal nodes
  splitValue?: number; // For internal nodes
  left?: IsolationTree; // For internal nodes
  right?: IsolationTree; // For internal nodes
}