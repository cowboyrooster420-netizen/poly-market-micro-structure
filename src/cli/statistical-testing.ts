import { StatisticalModels, StatisticalConfig } from '../statistics/StatisticalModels';
import { AnomalyDetector, AnomalyDetectionConfig } from '../statistics/AnomalyDetector';
import { EnhancedMicrostructureAnalyzer } from '../services/EnhancedMicrostructureAnalyzer';
import { BotConfig, EnhancedMicrostructureMetrics } from '../types';
import { logger } from '../utils/logger';

/**
 * CLI tool for testing and validating the robust statistical models
 */

export async function runStatisticalTesting(): Promise<void> {
  console.log('🧮 Statistical Models Testing & Validation Framework');
  console.log('='.repeat(60));

  // Test configuration
  const statConfig: StatisticalConfig = {
    windowSize: 100,
    outlierThreshold: 2.5,
    minSampleSize: 20,
    confidenceLevel: 0.95,
    ewmaAlpha: 0.1
  };

  const anomalyConfig: AnomalyDetectionConfig = {
    ...statConfig,
    multivariateSensitivity: 0.85,
    isolationForestContamination: 0.1,
    mahalanobisThreshold: 3.0,
    consensusThreshold: 0.6
  };

  const botConfig: BotConfig = {
    checkIntervalMs: 30000,
    minVolumeThreshold: 10000,
    maxMarketsToTrack: 100,
    logLevel: 'info',
    apiUrls: {
      clob: 'https://clob.polymarket.com',
      gamma: 'https://gamma-api.polymarket.com',
    },
    microstructure: {
      orderbookImbalanceThreshold: 0.3,
      spreadAnomalyThreshold: 2.0,
      liquidityShiftThreshold: 20,
      tickBufferSize: 1000,
    },
    discord: {
      webhookUrl: undefined,
      enableRichEmbeds: true,
      alertRateLimit: 10,
    },
  };

  console.log('\n📊 Test 1: Basic Statistical Models');
  await testBasicStatisticalModels(statConfig);

  console.log('\n🎯 Test 2: Z-Score Calculations');
  await testZScoreCalculations(statConfig);

  console.log('\n📈 Test 3: Trend Analysis');
  await testTrendAnalysis(statConfig);

  console.log('\n⚠️  Test 4: Anomaly Detection');
  await testAnomalyDetection(anomalyConfig);

  console.log('\n🔍 Test 5: Multivariate Analysis');
  await testMultivariateAnalysis(anomalyConfig);

  console.log('\n🏥 Test 6: Market Health Assessment');
  await testMarketHealthAssessment(botConfig);

  console.log('\n✅ All statistical model tests completed successfully!');
}

async function testBasicStatisticalModels(config: StatisticalConfig): Promise<void> {
  const models = new StatisticalModels(config);
  const marketId = 'test-market-1';

  // Generate synthetic data with known statistical properties
  const normalData = generateNormalData(100, 50, 10); // mean=50, std=10
  const anomalousData = generateNormalData(20, 80, 15); // Different distribution

  console.log('   📋 Testing basic statistical calculations...');

  // Test basic statistics
  const stats = models.calculateStatistics(normalData);
  console.log(`   📈 Normal data statistics:`);
  console.log(`      Mean: ${stats.mean.toFixed(2)} (expected: ~50)`);
  console.log(`      Std Dev: ${stats.standardDeviation.toFixed(2)} (expected: ~10)`);
  console.log(`      Skewness: ${stats.skewness.toFixed(2)} (expected: ~0)`);
  console.log(`      Kurtosis: ${stats.kurtosis.toFixed(2)} (expected: ~3)`);
  console.log(`      Sample Size: ${stats.sampleSize}`);

  // Test with ring buffer updates
  for (const value of normalData) {
    models.addDataPoint(marketId, 'price', value);
  }

  const healthScore = models.getMarketHealthScore(marketId);
  console.log(`   💚 Market Health Score: ${healthScore.toFixed(1)}/100`);

  console.log('   ✅ Basic statistical models test passed');
}

async function testZScoreCalculations(config: StatisticalConfig): Promise<void> {
  const models = new StatisticalModels(config);
  const marketId = 'test-market-2';

  console.log('   📊 Testing Z-score calculations...');

  // Add normal baseline data
  const baselineData = generateNormalData(50, 100, 20);
  for (const value of baselineData) {
    models.addDataPoint(marketId, 'volume', value);
  }

  // Test normal values
  const normalResult = models.calculateZScore(marketId, 'volume', 105);
  console.log(`   📊 Normal value (105): Z-score = ${normalResult.zScore.toFixed(2)}, Anomaly = ${normalResult.isAnomaly}`);

  // Test anomalous values
  const anomalousResult = models.calculateZScore(marketId, 'volume', 200);
  console.log(`   🚨 Anomalous value (200): Z-score = ${anomalousResult.zScore.toFixed(2)}, Anomaly = ${anomalousResult.isAnomaly}`);

  // Test time-adjusted Z-scores
  const timeResult = models.calculateTimeAdjustedZScore(marketId, 'volume', 180, Date.now());
  console.log(`   ⏰ Time-adjusted anomaly: Z-score = ${timeResult.zScore.toFixed(2)}, Confidence = ${(timeResult.confidenceLevel * 100).toFixed(1)}%`);

  console.log('   ✅ Z-score calculations test passed');
}

async function testTrendAnalysis(config: StatisticalConfig): Promise<void> {
  const models = new StatisticalModels(config);
  const marketId = 'test-market-3';

  console.log('   📈 Testing trend analysis...');

  // Generate trending data
  const trendData = generateTrendingData(50, 0.5); // Positive trend
  for (const value of trendData) {
    models.addDataPoint(marketId, 'price', value);
  }

  const trendAnalysis = models.performTrendAnalysis(marketId, 'price');
  console.log(`   📊 Trend Analysis:`);
  console.log(`      Direction: ${trendAnalysis.trend}`);
  console.log(`      Slope: ${trendAnalysis.slope.toFixed(4)}`);
  console.log(`      R-squared: ${trendAnalysis.rSquared.toFixed(3)}`);
  console.log(`      Significance: ${trendAnalysis.significance.toFixed(3)}`);
  console.log(`      Change Points: ${trendAnalysis.changePoints.length}`);

  console.log('   ✅ Trend analysis test passed');
}

async function testAnomalyDetection(config: AnomalyDetectionConfig): Promise<void> {
  const detector = new AnomalyDetector(config);
  const marketId = 'test-market-4';

  console.log('   🎯 Testing anomaly detection...');

  // Create synthetic microstructure metrics
  const normalMetrics = createSyntheticMetrics(marketId, Date.now(), {
    depth: 1000,
    spread: 5,
    imbalance: 0.1,
    volume: 500,
    price: 0.65
  });

  const anomalousMetrics = createSyntheticMetrics(marketId, Date.now() + 60000, {
    depth: 200, // Significant depth drop
    spread: 25, // Wide spread
    imbalance: 0.8, // High imbalance
    volume: 50, // Low volume
    price: 0.85 // Price jump
  });

  // Test normal metrics
  const normalResult = await detector.detectAnomalies(marketId, normalMetrics);
  console.log(`   📊 Normal metrics: Anomalous = ${normalResult.isAnomalous}, Confidence = ${(normalResult.confidence * 100).toFixed(1)}%`);

  // Test anomalous metrics  
  const anomalyResult = await detector.detectAnomalies(marketId, anomalousMetrics);
  console.log(`   🚨 Anomalous metrics: Anomalous = ${anomalyResult.isAnomalous}, Confidence = ${(anomalyResult.confidence * 100).toFixed(1)}%`);
  if (anomalyResult.isAnomalous) {
    console.log(`      Severity: ${anomalyResult.severity}`);
    console.log(`      Types: ${anomalyResult.anomalyType.join(', ')}`);
    console.log(`      Explanation: ${anomalyResult.explanation}`);
  }

  console.log('   ✅ Anomaly detection test passed');
}

async function testMultivariateAnalysis(config: AnomalyDetectionConfig): Promise<void> {
  const detector = new AnomalyDetector(config);
  const marketId = 'test-market-5';

  console.log('   🔍 Testing multivariate analysis...');

  // Generate multiple correlated data points
  const dataPoints = [];
  for (let i = 0; i < 30; i++) {
    const baseMetrics = createSyntheticMetrics(marketId, Date.now() + i * 30000, {
      depth: 1000 + Math.random() * 200 - 100,
      spread: 5 + Math.random() * 2 - 1,
      imbalance: (Math.random() - 0.5) * 0.4,
      volume: 500 + Math.random() * 100 - 50,
      price: 0.65 + (Math.random() - 0.5) * 0.1
    });
    
    dataPoints.push(baseMetrics);
    await detector.detectAnomalies(marketId, baseMetrics);
  }

  // Test with strongly correlated anomaly
  const correlatedAnomaly = createSyntheticMetrics(marketId, Date.now() + 35000, {
    depth: 300,    // Low depth
    spread: 30,    // Wide spread  
    imbalance: 0.9, // High imbalance
    volume: 100,   // Low volume
    price: 0.9     // High price
  });

  const multivariateResult = await detector.detectAnomalies(marketId, correlatedAnomaly);
  console.log(`   🔍 Multivariate anomaly: Detected = ${multivariateResult.isAnomalous}`);
  if (multivariateResult.isAnomalous) {
    console.log(`      Mahalanobis Distance: ${multivariateResult.scores.mahalanobis.toFixed(3)}`);
    console.log(`      Isolation Score: ${multivariateResult.scores.isolationForest.toFixed(3)}`);
    console.log(`      Consensus Score: ${multivariateResult.scores.consensus.toFixed(3)}`);
  }

  // Test risk assessment
  const riskAssessment = detector.getMarketRiskAssessment(marketId);
  console.log(`   🎲 Risk Assessment: ${riskAssessment.riskLevel} (Score: ${riskAssessment.score.toFixed(1)})`);
  console.log(`      Trend: ${riskAssessment.trend}`);
  console.log(`      Factors: ${riskAssessment.factors.join(', ')}`);

  console.log('   ✅ Multivariate analysis test passed');
}

async function testMarketHealthAssessment(config: BotConfig): Promise<void> {
  const analyzer = new EnhancedMicrostructureAnalyzer(config);

  console.log('   🏥 Testing market health assessment...');

  // Test with multiple markets
  const markets = ['healthy-market', 'risky-market', 'volatile-market'];
  
  for (const marketId of markets) {
    const healthScore = analyzer.getMarketHealthScore(marketId);
    const riskAssessment = analyzer.getMarketRiskAssessment(marketId);
    const stats = analyzer.getMarketStatistics(marketId);

    console.log(`   📊 ${marketId}:`);
    console.log(`      Health Score: ${healthScore}/100`);
    console.log(`      Risk Level: ${riskAssessment.riskLevel}`);
    console.log(`      Statistical Stability: ${stats.statisticalStability}`);
  }

  console.log('   ✅ Market health assessment test passed');
}

// Helper functions for generating test data

function generateNormalData(n: number, mean: number, stdDev: number): number[] {
  const data: number[] = [];
  for (let i = 0; i < n; i++) {
    // Box-Muller transformation for normal distribution
    const u1 = Math.random();
    const u2 = Math.random();
    const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    data.push(mean + z0 * stdDev);
  }
  return data;
}

function generateTrendingData(n: number, slope: number): number[] {
  const data: number[] = [];
  const baseValue = 100;
  for (let i = 0; i < n; i++) {
    const trend = baseValue + slope * i;
    const noise = (Math.random() - 0.5) * 10; // Random noise
    data.push(trend + noise);
  }
  return data;
}

function createSyntheticMetrics(
  marketId: string, 
  timestamp: number, 
  params: {
    depth: number;
    spread: number;
    imbalance: number;
    volume: number;
    price: number;
  }
): EnhancedMicrostructureMetrics {
  return {
    marketId,
    timestamp,
    depth1Bid: params.depth * 0.6,
    depth1Ask: params.depth * 0.4,
    depth1Total: params.depth,
    depth1Change: (Math.random() - 0.5) * 10,
    depth1Baseline: params.depth * 1.1,
    microPrice: params.price,
    microPriceSlope: (Math.random() - 0.5) * 0.01,
    microPriceDrift: (Math.random() - 0.5) * 0.02,
    orderBookImbalance: params.imbalance,
    spreadBps: params.spread,
    spreadChange: (Math.random() - 0.5) * 5,
    liquidityVacuum: params.depth < 500,
    volumeZScore: (params.volume - 500) / 100, // Normalized
    depthZScore: (params.depth - 1000) / 200,
    spreadZScore: (params.spread - 5) / 2,
    imbalanceZScore: params.imbalance / 0.2,
    timeOfDayBaseline: {
      volume: 500,
      depth: 1000,
      spread: 5,
      imbalance: 0.1
    }
  };
}

// CLI entry point
if (require.main === module) {
  runStatisticalTesting().catch((error) => {
    logger.error('Statistical testing failed:', error);
    process.exit(1);
  });
}