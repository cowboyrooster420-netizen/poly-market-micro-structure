import { logger } from '../utils/logger';

/**
 * Robust statistical models for anomaly detection and signal validation
 * Replaces placeholder calculations with proper statistical methods
 */

export interface StatisticalConfig {
  windowSize: number; // Rolling window size for calculations
  outlierThreshold: number; // Standard deviations for outlier detection
  minSampleSize: number; // Minimum samples required for statistical significance
  confidenceLevel: number; // Confidence level for statistical tests (0.95 = 95%)
  ewmaAlpha: number; // Exponentially weighted moving average smoothing factor
}

export interface StatisticalMetrics {
  mean: number;
  standardDeviation: number;
  variance: number;
  skewness: number;
  kurtosis: number;
  median: number;
  percentile95: number;
  percentile5: number;
  sampleSize: number;
  isStatisticallySignificant: boolean;
}

export interface ZScoreResult {
  zScore: number;
  pValue: number;
  isAnomaly: boolean;
  confidenceLevel: number;
  standardError: number;
}

export interface TrendAnalysis {
  trend: 'upward' | 'downward' | 'sideways';
  slope: number;
  rSquared: number;
  significance: number;
  changePoints: number[];
}

export interface VolatilityMetrics {
  historicalVolatility: number;
  ewmaVolatility: number;
  parkinsonVolatility: number; // High-low volatility estimator
  garmanKlassVolatility: number; // OHLC volatility estimator
  volatilityOfVolatility: number;
  volatilityRatio: number; // Current vs historical
}

export class RingBuffer<T> {
  private buffer: T[] = [];
  private pointer = 0;
  private filled = false;

  constructor(private capacity: number) {}

  push(item: T): void {
    this.buffer[this.pointer] = item;
    this.pointer = (this.pointer + 1) % this.capacity;
    if (this.pointer === 0) {
      this.filled = true;
    }
  }

  getAll(): T[] {
    if (!this.filled) {
      return this.buffer.slice(0, this.pointer);
    }
    return [...this.buffer.slice(this.pointer), ...this.buffer.slice(0, this.pointer)];
  }

  length(): number {
    return this.filled ? this.capacity : this.pointer;
  }

  clear(): void {
    this.buffer = [];
    this.pointer = 0;
    this.filled = false;
  }

  isFull(): boolean {
    return this.filled;
  }

  getLatest(): T | undefined {
    if (this.length() === 0) return undefined;
    const latest = this.pointer === 0 ? this.capacity - 1 : this.pointer - 1;
    return this.buffer[latest];
  }

  getLast(n: number): T[] {
    const all = this.getAll();
    return all.slice(-n);
  }
}

export class StatisticalModels {
  private config: StatisticalConfig;

  // Data storage for different metrics
  private priceBuffers = new Map<string, RingBuffer<number>>();
  private volumeBuffers = new Map<string, RingBuffer<number>>();
  private spreadBuffers = new Map<string, RingBuffer<number>>();
  private depthBuffers = new Map<string, RingBuffer<number>>();
  private imbalanceBuffers = new Map<string, RingBuffer<number>>();

  // EWMA (Exponentially Weighted Moving Average) state
  private priceEWMA = new Map<string, number>();
  private volumeEWMA = new Map<string, number>();
  private spreadEWMA = new Map<string, number>();
  private depthEWMA = new Map<string, number>();
  private imbalanceEWMA = new Map<string, number>();

  // Baseline calculations storage
  private timeOfDayBaselines = new Map<string, Map<number, StatisticalMetrics>>();

  constructor(config: StatisticalConfig) {
    this.config = config;
    logger.info('Statistical models initialized with robust calculation methods');
  }

  /**
   * Add a data point for statistical tracking
   */
  addDataPoint(marketId: string, type: 'price' | 'volume' | 'spread' | 'depth' | 'imbalance', value: number): void {
    const bufferMap = this.getBufferMap(type);
    const ewmaMap = this.getEWMAMap(type);

    if (!bufferMap.has(marketId)) {
      bufferMap.set(marketId, new RingBuffer<number>(this.config.windowSize));
    }

    const buffer = bufferMap.get(marketId)!;
    buffer.push(value);

    // Update EWMA
    const currentEWMA = ewmaMap.get(marketId) || value;
    const newEWMA = this.config.ewmaAlpha * value + (1 - this.config.ewmaAlpha) * currentEWMA;
    ewmaMap.set(marketId, newEWMA);
  }

  /**
   * Calculate comprehensive statistical metrics for a dataset
   */
  calculateStatistics(data: number[]): StatisticalMetrics {
    if (data.length === 0) {
      return this.getEmptyStatistics();
    }

    const sortedData = [...data].sort((a, b) => a - b);
    const n = data.length;

    // Basic statistics
    const mean = data.reduce((sum, val) => sum + val, 0) / n;
    const variance = data.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / (n - 1);
    const standardDeviation = Math.sqrt(variance);

    // Median and percentiles
    const median = n % 2 === 0 
      ? (sortedData[n / 2 - 1] + sortedData[n / 2]) / 2 
      : sortedData[Math.floor(n / 2)];
    
    const percentile5 = this.percentile(sortedData, 0.05);
    const percentile95 = this.percentile(sortedData, 0.95);

    // Higher-order moments
    const skewness = this.calculateSkewness(data, mean, standardDeviation);
    const kurtosis = this.calculateKurtosis(data, mean, standardDeviation);

    return {
      mean,
      standardDeviation,
      variance,
      skewness,
      kurtosis,
      median,
      percentile95,
      percentile5,
      sampleSize: n,
      isStatisticallySignificant: n >= this.config.minSampleSize
    };
  }

  /**
   * Calculate robust Z-score with proper statistical testing
   */
  calculateZScore(marketId: string, type: 'price' | 'volume' | 'spread' | 'depth' | 'imbalance', currentValue: number): ZScoreResult {
    const buffer = this.getBufferMap(type).get(marketId);
    
    if (!buffer || buffer.length() < this.config.minSampleSize) {
      return {
        zScore: 0,
        pValue: 1,
        isAnomaly: false,
        confidenceLevel: 0,
        standardError: 0
      };
    }

    const data = buffer.getAll();
    const stats = this.calculateStatistics(data);

    if (stats.standardDeviation === 0) {
      return {
        zScore: 0,
        pValue: 1,
        isAnomaly: false,
        confidenceLevel: 0,
        standardError: 0
      };
    }

    const zScore = (currentValue - stats.mean) / stats.standardDeviation;
    const standardError = stats.standardDeviation / Math.sqrt(stats.sampleSize);
    
    // Calculate p-value using standard normal distribution approximation
    const pValue = 2 * (1 - this.normalCDF(Math.abs(zScore)));
    
    // Determine if it's an anomaly based on threshold
    const isAnomaly = Math.abs(zScore) > this.config.outlierThreshold;
    
    // Calculate confidence level
    const confidenceLevel = 1 - pValue;

    return {
      zScore,
      pValue,
      isAnomaly,
      confidenceLevel,
      standardError
    };
  }

  /**
   * Calculate time-of-day adjusted Z-score for better baseline comparison
   */
  calculateTimeAdjustedZScore(
    marketId: string, 
    type: 'price' | 'volume' | 'spread' | 'depth' | 'imbalance', 
    currentValue: number,
    timestamp: number
  ): ZScoreResult {
    const hourOfDay = new Date(timestamp).getUTCHours();
    const timeBaseline = this.getTimeOfDayBaseline(marketId, hourOfDay, type);

    if (!timeBaseline || !timeBaseline.isStatisticallySignificant) {
      // Fallback to regular Z-score if no time baseline available
      return this.calculateZScore(marketId, type, currentValue);
    }

    const zScore = timeBaseline.standardDeviation > 0 
      ? (currentValue - timeBaseline.mean) / timeBaseline.standardDeviation 
      : 0;

    const standardError = timeBaseline.standardDeviation / Math.sqrt(timeBaseline.sampleSize);
    const pValue = 2 * (1 - this.normalCDF(Math.abs(zScore)));
    const isAnomaly = Math.abs(zScore) > this.config.outlierThreshold;
    const confidenceLevel = 1 - pValue;

    return {
      zScore,
      pValue,
      isAnomaly,
      confidenceLevel,
      standardError
    };
  }

  /**
   * Perform trend analysis using linear regression
   */
  performTrendAnalysis(marketId: string, type: 'price' | 'volume' | 'spread' | 'depth' | 'imbalance'): TrendAnalysis {
    const buffer = this.getBufferMap(type).get(marketId);
    
    if (!buffer || buffer.length() < this.config.minSampleSize) {
      return {
        trend: 'sideways',
        slope: 0,
        rSquared: 0,
        significance: 0,
        changePoints: []
      };
    }

    const data = buffer.getAll();
    const regression = this.linearRegression(data);
    
    // Determine trend direction
    let trend: 'upward' | 'downward' | 'sideways' = 'sideways';
    if (Math.abs(regression.slope) > 0.01) { // Minimum slope threshold
      trend = regression.slope > 0 ? 'upward' : 'downward';
    }

    // Detect change points using simple method
    const changePoints = this.detectChangePoints(data);

    return {
      trend,
      slope: regression.slope,
      rSquared: regression.rSquared,
      significance: regression.significance,
      changePoints
    };
  }

  /**
   * Calculate comprehensive volatility metrics
   */
  calculateVolatilityMetrics(marketId: string, prices: number[], highs?: number[], lows?: number[], opens?: number[]): VolatilityMetrics {
    if (prices.length < 2) {
      return {
        historicalVolatility: 0,
        ewmaVolatility: 0,
        parkinsonVolatility: 0,
        garmanKlassVolatility: 0,
        volatilityOfVolatility: 0,
        volatilityRatio: 1
      };
    }

    // Calculate returns
    // For prediction markets, use absolute probability changes instead of log returns
    // to avoid bias. Log returns assume unbounded prices and make the same absolute
    // move (e.g., 0.10 → 0.11) appear more volatile than 0.90 → 0.91
    const returns = [];
    for (let i = 1; i < prices.length; i++) {
      returns.push(prices[i] - prices[i - 1]); // Absolute probability change
    }

    // Historical volatility (standard deviation of returns)
    const historicalVolatility = this.calculateStatistics(returns).standardDeviation * Math.sqrt(252); // Annualized

    // EWMA volatility
    const ewmaVolatility = this.calculateEWMAVolatility(returns);

    // Parkinson volatility (using high-low if available)
    const parkinsonVolatility = (highs && lows) ? this.calculateParkinsonVolatility(highs, lows) : historicalVolatility;

    // Garman-Klass volatility (using OHLC if available)
    const garmanKlassVolatility = (opens && highs && lows) ? 
      this.calculateGarmanKlassVolatility(opens, highs, lows, prices) : historicalVolatility;

    // Volatility of volatility
    const volatilityWindow = 20;
    const rollingVols = [];
    for (let i = volatilityWindow; i < returns.length; i++) {
      const windowReturns = returns.slice(i - volatilityWindow, i);
      rollingVols.push(this.calculateStatistics(windowReturns).standardDeviation);
    }
    const volatilityOfVolatility = rollingVols.length > 0 ? this.calculateStatistics(rollingVols).standardDeviation : 0;

    // Current vs historical volatility ratio
    const recentVolatility = returns.length >= 20 ? 
      this.calculateStatistics(returns.slice(-20)).standardDeviation : historicalVolatility;
    const volatilityRatio = historicalVolatility > 0 ? recentVolatility / historicalVolatility : 1;

    return {
      historicalVolatility,
      ewmaVolatility,
      parkinsonVolatility,
      garmanKlassVolatility,
      volatilityOfVolatility,
      volatilityRatio
    };
  }

  /**
   * Detect structural breaks and regime changes
   */
  detectStructuralBreaks(marketId: string, type: 'price' | 'volume' | 'spread' | 'depth' | 'imbalance'): number[] {
    const buffer = this.getBufferMap(type).get(marketId);
    
    if (!buffer || buffer.length() < this.config.minSampleSize * 2) {
      return [];
    }

    const data = buffer.getAll();
    return this.detectChangePoints(data);
  }

  /**
   * Update time-of-day baselines for better anomaly detection
   */
  updateTimeOfDayBaselines(marketId: string, timestamp: number): void {
    const hourOfDay = new Date(timestamp).getUTCHours();
    
    if (!this.timeOfDayBaselines.has(marketId)) {
      this.timeOfDayBaselines.set(marketId, new Map());
    }

    const marketBaselines = this.timeOfDayBaselines.get(marketId)!;

    // Update baselines for each metric type
    const types: Array<'price' | 'volume' | 'spread' | 'depth' | 'imbalance'> = ['price', 'volume', 'spread', 'depth', 'imbalance'];
    
    for (const type of types) {
      const buffer = this.getBufferMap(type).get(marketId);
      if (buffer && buffer.length() >= this.config.minSampleSize) {
        const hourlyData = this.extractHourlyData(buffer, hourOfDay);
        if (hourlyData.length >= this.config.minSampleSize) {
          const key = hourOfDay * 1000 + types.indexOf(type); // Composite key
          marketBaselines.set(key, this.calculateStatistics(hourlyData));
        }
      }
    }
  }

  /**
   * Get market health score based on statistical stability
   */
  getMarketHealthScore(marketId: string): number {
    let totalScore = 0;
    let validMetrics = 0;

    const types: Array<'price' | 'volume' | 'spread' | 'depth' | 'imbalance'> = ['price', 'volume', 'spread', 'depth', 'imbalance'];
    
    for (const type of types) {
      const buffer = this.getBufferMap(type).get(marketId);
      if (buffer && buffer.length() >= this.config.minSampleSize) {
        const data = buffer.getAll();
        const stats = this.calculateStatistics(data);
        
        // Score based on statistical properties
        let score = 0;
        
        // Reward sufficient sample size
        score += Math.min(stats.sampleSize / this.config.windowSize, 1) * 25;
        
        // Reward low skewness (symmetric distribution)
        score += Math.max(0, 25 - Math.abs(stats.skewness) * 5);
        
        // Reward normal kurtosis (around 3)
        score += Math.max(0, 25 - Math.abs(stats.kurtosis - 3) * 2);
        
        // Reward low coefficient of variation (stability)
        const cv = stats.mean !== 0 ? stats.standardDeviation / Math.abs(stats.mean) : 1;
        score += Math.max(0, 25 - cv * 50);
        
        totalScore += score;
        validMetrics++;
      }
    }

    return validMetrics > 0 ? totalScore / validMetrics : 0;
  }

  // Private helper methods

  private getBufferMap(type: string): Map<string, RingBuffer<number>> {
    switch (type) {
      case 'price': return this.priceBuffers;
      case 'volume': return this.volumeBuffers;
      case 'spread': return this.spreadBuffers;
      case 'depth': return this.depthBuffers;
      case 'imbalance': return this.imbalanceBuffers;
      default: throw new Error(`Unknown buffer type: ${type}`);
    }
  }

  private getEWMAMap(type: string): Map<string, number> {
    switch (type) {
      case 'price': return this.priceEWMA;
      case 'volume': return this.volumeEWMA;
      case 'spread': return this.spreadEWMA;
      case 'depth': return this.depthEWMA;
      case 'imbalance': return this.imbalanceEWMA;
      default: throw new Error(`Unknown EWMA type: ${type}`);
    }
  }

  private getEmptyStatistics(): StatisticalMetrics {
    return {
      mean: 0,
      standardDeviation: 0,
      variance: 0,
      skewness: 0,
      kurtosis: 0,
      median: 0,
      percentile95: 0,
      percentile5: 0,
      sampleSize: 0,
      isStatisticallySignificant: false
    };
  }

  private percentile(sortedData: number[], p: number): number {
    const index = p * (sortedData.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const weight = index % 1;
    
    if (upper >= sortedData.length) return sortedData[sortedData.length - 1];
    return sortedData[lower] * (1 - weight) + sortedData[upper] * weight;
  }

  private calculateSkewness(data: number[], mean: number, stdDev: number): number {
    if (stdDev === 0) return 0;
    if (data.length < 3) return 0; // Need at least 3 points for skewness calculation
    
    const n = data.length;
    const sum = data.reduce((acc, val) => acc + Math.pow((val - mean) / stdDev, 3), 0);
    return (n / ((n - 1) * (n - 2))) * sum;
  }

  private calculateKurtosis(data: number[], mean: number, stdDev: number): number {
    if (stdDev === 0) return 3; // Normal distribution kurtosis = 3
    if (data.length < 4) return 3; // Need at least 4 points for kurtosis calculation
    
    const n = data.length;
    const sum = data.reduce((acc, val) => acc + Math.pow((val - mean) / stdDev, 4), 0);
    
    // Calculate excess kurtosis first
    const excessKurtosis = ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * sum - (3 * (n - 1) * (n - 1)) / ((n - 2) * (n - 3));
    
    // Return regular kurtosis (excess + 3) since the code expects normal distribution = 3
    return excessKurtosis + 3;
  }

  private normalCDF(z: number): number {
    // Approximation of cumulative distribution function for standard normal distribution
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989423 * Math.exp(-z * z / 2);
    const prob = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z > 0 ? 1 - prob : prob;
  }

  private linearRegression(data: number[]): { slope: number; intercept: number; rSquared: number; significance: number } {
    const n = data.length;
    const x = Array.from({ length: n }, (_, i) => i);
    
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = data.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((sum, xi, i) => sum + xi * data[i], 0);
    const sumXX = x.reduce((sum, xi) => sum + xi * xi, 0);
    const sumYY = data.reduce((sum, yi) => sum + yi * yi, 0);
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    
    // Calculate R-squared
    const yMean = sumY / n;
    const ssRes = data.reduce((sum, yi, i) => {
      const predicted = slope * i + intercept;
      return sum + (yi - predicted) ** 2;
    }, 0);
    const ssTot = data.reduce((sum, yi) => sum + (yi - yMean) ** 2, 0);
    const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 0;
    
    // Simple significance test (t-statistic approximation)
    const residualStdError = Math.sqrt(ssRes / (n - 2));
    const slopeStdError = residualStdError / Math.sqrt(sumXX - sumX * sumX / n);
    const tStat = Math.abs(slope / slopeStdError);
    const significance = Math.max(0, Math.min(1, 1 - this.normalCDF(tStat)));
    
    return { slope, intercept, rSquared, significance };
  }

  private detectChangePoints(data: number[]): number[] {
    // Simple change point detection using sliding window variance
    const changePoints: number[] = [];
    const windowSize = Math.min(10, Math.floor(data.length / 5));
    
    if (data.length < windowSize * 2) return changePoints;
    
    for (let i = windowSize; i < data.length - windowSize; i++) {
      const before = data.slice(i - windowSize, i);
      const after = data.slice(i, i + windowSize);
      
      const beforeStats = this.calculateStatistics(before);
      const afterStats = this.calculateStatistics(after);
      
      // Detect significant change in mean or variance
      const meanChange = Math.abs(beforeStats.mean - afterStats.mean);
      const varChange = Math.abs(beforeStats.variance - afterStats.variance);
      
      const combinedStdDev = Math.sqrt((beforeStats.variance + afterStats.variance) / 2);
      
      if (meanChange > 2 * combinedStdDev || varChange > beforeStats.variance * 2) {
        changePoints.push(i);
      }
    }
    
    return changePoints;
  }

  private calculateEWMAVolatility(returns: number[]): number {
    if (returns.length < 2) return 0;
    
    let ewmaVar = returns[0] ** 2;
    const lambda = 0.94; // Standard EWMA decay factor
    
    for (let i = 1; i < returns.length; i++) {
      ewmaVar = lambda * ewmaVar + (1 - lambda) * returns[i] ** 2;
    }
    
    return Math.sqrt(ewmaVar * 252); // Annualized
  }

  private calculateParkinsonVolatility(highs: number[], lows: number[]): number {
    if (highs.length !== lows.length || highs.length < 2) return 0;
    
    const logRatios = highs.map((high, i) => Math.log(high / lows[i]) ** 2);
    const avgLogRatio = logRatios.reduce((sum, ratio) => sum + ratio, 0) / logRatios.length;
    
    return Math.sqrt(avgLogRatio / (4 * Math.log(2)) * 252); // Annualized
  }

  private calculateGarmanKlassVolatility(opens: number[], highs: number[], lows: number[], closes: number[]): number {
    if (opens.length !== closes.length || opens.length < 2) return 0;
    
    let sum = 0;
    for (let i = 0; i < opens.length; i++) {
      const hlTerm = 0.5 * Math.log(highs[i] / lows[i]) ** 2;
      const ocTerm = (2 * Math.log(2) - 1) * Math.log(closes[i] / opens[i]) ** 2;
      sum += hlTerm - ocTerm;
    }
    
    return Math.sqrt(sum / opens.length * 252); // Annualized
  }

  private getTimeOfDayBaseline(marketId: string, hourOfDay: number, type: 'price' | 'volume' | 'spread' | 'depth' | 'imbalance'): StatisticalMetrics | null {
    const marketBaselines = this.timeOfDayBaselines.get(marketId);
    if (!marketBaselines) return null;
    
    const types: Array<'price' | 'volume' | 'spread' | 'depth' | 'imbalance'> = ['price', 'volume', 'spread', 'depth', 'imbalance'];
    const key = hourOfDay * 1000 + types.indexOf(type);
    return marketBaselines.get(key) || null;
  }

  private extractHourlyData(buffer: RingBuffer<number>, targetHour: number): number[] {
    // This is a simplified version - in practice, you'd need timestamps with each data point
    // For now, return recent data as a placeholder
    const data = buffer.getAll();
    return data.slice(-Math.min(20, data.length)); // Recent 20 points as proxy
  }

  /**
   * Calculate Pearson correlation coefficient between two datasets
   */
  calculateCorrelation(x: number[], y: number[]): number {
    if (x.length !== y.length || x.length < 2) {
      return 0;
    }

    const n = x.length;
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
    const sumXX = x.reduce((sum, xi) => sum + xi * xi, 0);
    const sumYY = y.reduce((sum, yi) => sum + yi * yi, 0);

    const numerator = n * sumXY - sumX * sumY;
    const denominator = Math.sqrt((n * sumXX - sumX * sumX) * (n * sumYY - sumY * sumY));

    // Use proper epsilon comparison for floating-point safety
    return Math.abs(denominator) < 1e-10 ? 0 : numerator / denominator;
  }

  /**
   * Calculate Spearman rank correlation coefficient between two datasets
   */
  calculateSpearmanCorrelation(x: number[], y: number[]): number {
    if (x.length !== y.length || x.length < 2) {
      return 0;
    }

    // Convert to ranks
    const xRanks = this.convertToRanks(x);
    const yRanks = this.convertToRanks(y);

    // Calculate Pearson correlation of ranks
    return this.calculateCorrelation(xRanks, yRanks);
  }

  private convertToRanks(data: number[]): number[] {
    const indexed = data.map((value, index) => ({ value, index }));
    indexed.sort((a, b) => a.value - b.value);
    
    const ranks = new Array(data.length);
    for (let i = 0; i < indexed.length; i++) {
      ranks[indexed[i].index] = i + 1; // Ranks start from 1
    }
    
    return ranks;
  }
}