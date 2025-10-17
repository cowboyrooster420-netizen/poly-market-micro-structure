const { parentPort, workerData } = require('worker_threads');

/**
 * Statistical Worker for CPU-intensive calculations
 * Handles statistical computations in a separate thread to avoid blocking the main thread
 */

if (parentPort) {
  parentPort.on('message', async (task) => {
    const startTime = Date.now();
    
    try {
      let result;
      
      switch (task.type) {
        case 'statistical_calculation':
          result = await performStatisticalCalculation(task.data);
          break;
        case 'correlation_analysis':
          result = await performCorrelationAnalysis(task.data);
          break;
        case 'anomaly_detection':
          result = await performAnomalyDetection(task.data);
          break;
        case 'signal_processing':
          result = await performSignalProcessing(task.data);
          break;
        default:
          throw new Error(`Unknown task type: ${task.type}`);
      }
      
      const processingTime = Date.now() - startTime;
      
      parentPort.postMessage({
        taskId: task.id,
        success: true,
        result,
        processingTimeMs: processingTime,
        workerId: process.pid.toString()
      });
      
    } catch (error) {
      const processingTime = Date.now() - startTime;
      
      parentPort.postMessage({
        taskId: task.id,
        success: false,
        error: error.message,
        processingTimeMs: processingTime,
        workerId: process.pid.toString()
      });
    }
  });
}

/**
 * Perform comprehensive statistical calculations
 */
async function performStatisticalCalculation(data) {
  const { values, config } = data;
  
  if (!values || values.length === 0) {
    throw new Error('No values provided for statistical calculation');
  }
  
  // Sort values for percentile calculations
  const sortedValues = [...values].sort((a, b) => a - b);
  const n = values.length;
  
  // Basic statistics
  const mean = values.reduce((sum, val) => sum + val, 0) / n;
  const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / (n - 1);
  const standardDeviation = Math.sqrt(variance);
  
  // Median
  const median = n % 2 === 0 
    ? (sortedValues[n/2 - 1] + sortedValues[n/2]) / 2
    : sortedValues[Math.floor(n/2)];
  
  // Percentiles
  const percentile5 = sortedValues[Math.floor(0.05 * n)];
  const percentile95 = sortedValues[Math.floor(0.95 * n)];
  
  // Skewness and Kurtosis
  const skewness = calculateSkewness(values, mean, standardDeviation);
  const kurtosis = calculateKurtosis(values, mean, standardDeviation);
  
  // Z-scores for outlier detection - avoid division by zero
  const zScores = values.map(val => standardDeviation > 1e-10 ? Math.abs((val - mean) / standardDeviation) : 0);
  const outliers = values.filter((_, index) => zScores[index] > (config?.outlierThreshold || 3));
  
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
    outliers,
    zScores,
    isStatisticallySignificant: n >= (config?.minSampleSize || 30)
  };
}

/**
 * Perform correlation analysis between multiple time series
 */
async function performCorrelationAnalysis(data) {
  const { series1, series2, method = 'pearson' } = data;
  
  if (series1.length !== series2.length) {
    throw new Error('Series must have equal length for correlation analysis');
  }
  
  if (method === 'pearson') {
    return calculatePearsonCorrelation(series1, series2);
  } else if (method === 'spearman') {
    return calculateSpearmanCorrelation(series1, series2);
  } else {
    throw new Error(`Unsupported correlation method: ${method}`);
  }
}

/**
 * Perform anomaly detection using multiple algorithms
 */
async function performAnomalyDetection(data) {
  const { values, config } = data;
  const results = {};
  
  // Z-Score based anomaly detection
  const stats = await performStatisticalCalculation({ values, config });
  results.zScoreAnomalies = stats.outliers;
  
  // Isolation Forest (simplified implementation)
  results.isolationForestAnomalies = performIsolationForest(values, config);
  
  // Moving average based detection
  results.movingAverageAnomalies = performMovingAverageDetection(values, config);
  
  return results;
}

/**
 * Perform signal processing operations
 */
async function performSignalProcessing(data) {
  const { signal, operations } = data;
  let processedSignal = [...signal];
  
  for (const operation of operations) {
    switch (operation.type) {
      case 'smooth':
        processedSignal = applySmoothingFilter(processedSignal, operation.params);
        break;
      case 'normalize':
        processedSignal = normalizeSignal(processedSignal);
        break;
      case 'detrend':
        processedSignal = detrendSignal(processedSignal);
        break;
      case 'fft':
        processedSignal = performFFT(processedSignal);
        break;
    }
  }
  
  return processedSignal;
}

// Helper functions
function calculateSkewness(values, mean, stdDev) {
  if (stdDev === 0) return 0;
  if (values.length < 3) return 0; // Need at least 3 points for skewness calculation
  
  const n = values.length;
  const sum = values.reduce((acc, val) => acc + Math.pow((val - mean) / stdDev, 3), 0);
  return (n / ((n - 1) * (n - 2))) * sum;
}

function calculateKurtosis(values, mean, stdDev) {
  if (stdDev === 0) return 3; // Normal distribution kurtosis = 3
  if (values.length < 4) return 3; // Need at least 4 points for kurtosis calculation
  
  const n = values.length;
  const sum = values.reduce((acc, val) => acc + Math.pow((val - mean) / stdDev, 4), 0);
  return ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * sum - 
         (3 * Math.pow(n - 1, 2)) / ((n - 2) * (n - 3));
}

function calculatePearsonCorrelation(x, y) {
  const n = x.length;
  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
  const sumXX = x.reduce((sum, xi) => sum + xi * xi, 0);
  const sumYY = y.reduce((sum, yi) => sum + yi * yi, 0);
  
  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt((n * sumXX - sumX * sumX) * (n * sumYY - sumY * sumY));
  
  return Math.abs(denominator) < 1e-10 ? 0 : numerator / denominator;
}

function calculateSpearmanCorrelation(x, y) {
  // Convert to ranks
  const xRanks = getRanks(x);
  const yRanks = getRanks(y);
  
  // Calculate Pearson correlation of ranks
  return calculatePearsonCorrelation(xRanks, yRanks);
}

function getRanks(arr) {
  return arr.map((val, index) => ({val, index}))
            .sort((a, b) => a.val - b.val)
            .map((item, rank) => ({...item, rank: rank + 1}))
            .sort((a, b) => a.index - b.index)
            .map(item => item.rank);
}

function performIsolationForest(values, config) {
  // Simplified isolation forest implementation
  const threshold = config?.isolationThreshold || 0.6;
  const anomalies = [];
  
  // This is a simplified version - in production, use a proper isolation forest library
  const stats = values.reduce((acc, val) => {
    acc.sum += val;
    acc.count++;
    return acc;
  }, { sum: 0, count: 0 });
  
  const mean = stats.sum / stats.count;
  const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / stats.count;
  const stdDev = Math.sqrt(variance);
  
  values.forEach((val, index) => {
    const isolation_score = stdDev > 1e-10 ? Math.abs(val - mean) / stdDev : 0;
    if (isolation_score > threshold * 3) {
      anomalies.push({ index, value: val, score: isolation_score });
    }
  });
  
  return anomalies;
}

function performMovingAverageDetection(values, config) {
  const windowSize = config?.windowSize || 10;
  const threshold = config?.threshold || 2;
  const anomalies = [];
  
  for (let i = windowSize; i < values.length; i++) {
    const window = values.slice(i - windowSize, i);
    const mean = window.reduce((sum, val) => sum + val, 0) / windowSize;
    const variance = window.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / windowSize;
    const stdDev = Math.sqrt(variance);
    
    const zScore = stdDev > 1e-10 ? Math.abs((values[i] - mean) / stdDev) : 0;
    if (zScore > threshold) {
      anomalies.push({ index: i, value: values[i], zScore });
    }
  }
  
  return anomalies;
}

function applySmoothingFilter(signal, params) {
  const windowSize = params?.windowSize || 5;
  const result = [];
  
  for (let i = 0; i < signal.length; i++) {
    const start = Math.max(0, i - Math.floor(windowSize / 2));
    const end = Math.min(signal.length, i + Math.floor(windowSize / 2) + 1);
    const window = signal.slice(start, end);
    const smoothed = window.reduce((sum, val) => sum + val, 0) / window.length;
    result.push(smoothed);
  }
  
  return result;
}

function normalizeSignal(signal) {
  const mean = signal.reduce((sum, val) => sum + val, 0) / signal.length;
  const variance = signal.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / signal.length;
  const stdDev = Math.sqrt(variance);
  
  return signal.map(val => stdDev > 1e-10 ? (val - mean) / stdDev : 0);
}

function detrendSignal(signal) {
  // Simple linear detrending
  const n = signal.length;
  const x = Array.from({ length: n }, (_, i) => i);
  
  // Calculate linear regression
  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = signal.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((sum, xi, i) => sum + xi * signal[i], 0);
  const sumXX = x.reduce((sum, xi) => sum + xi * xi, 0);
  
  const slopeDenominator = n * sumXX - sumX * sumX;
  const slope = Math.abs(slopeDenominator) < 1e-10 ? 0 : (n * sumXY - sumX * sumY) / slopeDenominator;
  const intercept = n > 0 ? (sumY - slope * sumX) / n : 0;
  
  // Remove trend
  return signal.map((val, i) => val - (slope * i + intercept));
}

function performFFT(signal) {
  // This is a placeholder for FFT - in production, use a proper FFT library like fft.js
  // For now, return the original signal
  return signal;
}