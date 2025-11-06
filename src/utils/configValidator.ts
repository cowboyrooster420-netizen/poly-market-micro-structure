import { logger } from './logger';
import * as fs from 'fs';
import * as path from 'path';

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

interface DetectionConfig {
  detection: {
    signals: any;
    marketFiltering: any;
    categoryVolumeThresholds: any;
    marketTiers: any;
    opportunityScoring: any;
    alertPrioritization: any;
    microstructure: any;
    statistical: any;
    markets: any;
    alerts: any;
  };
  performance: any;
  environment: any;
  features: any;
}

export function validateEnvironmentVariables(): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Required variables
  const requiredVars = {
    CLOB_API_URL: process.env.CLOB_API_URL,
    GAMMA_API_URL: process.env.GAMMA_API_URL,
  };

  // Validate required variables
  for (const [name, value] of Object.entries(requiredVars)) {
    if (!value) {
      errors.push(`Missing required environment variable: ${name}`);
    } else if (!isValidUrl(value)) {
      errors.push(`Invalid URL for ${name}: ${value}`);
    }
  }

  // Validate optional but important variables
  if (!process.env.DISCORD_WEBHOOK_URL) {
    warnings.push('DISCORD_WEBHOOK_URL not set - Discord alerts will be disabled');
  } else if (!isValidDiscordWebhook(process.env.DISCORD_WEBHOOK_URL)) {
    errors.push('Invalid Discord webhook URL format');
  }

  // Validate numeric values
  const numericValidations = [
    { name: 'CHECK_INTERVAL_MS', value: process.env.CHECK_INTERVAL_MS, min: 1000, max: 300000 },
    { name: 'MIN_VOLUME_THRESHOLD', value: process.env.MIN_VOLUME_THRESHOLD, min: 0, max: 10000000 },
    { name: 'MAX_MARKETS_TO_TRACK', value: process.env.MAX_MARKETS_TO_TRACK, min: 1, max: 1000 },
    { name: 'ORDERBOOK_IMBALANCE_THRESHOLD', value: process.env.ORDERBOOK_IMBALANCE_THRESHOLD, min: 0, max: 1 },
    { name: 'SPREAD_ANOMALY_THRESHOLD', value: process.env.SPREAD_ANOMALY_THRESHOLD, min: 0.1, max: 10 },
    { name: 'LIQUIDITY_SHIFT_THRESHOLD', value: process.env.LIQUIDITY_SHIFT_THRESHOLD, min: 1, max: 100 },
    { name: 'MOMENTUM_THRESHOLD', value: process.env.MOMENTUM_THRESHOLD, min: 0.1, max: 50 },
    { name: 'TICK_BUFFER_SIZE', value: process.env.TICK_BUFFER_SIZE, min: 100, max: 10000 },
    { name: 'DISCORD_RATE_LIMIT', value: process.env.DISCORD_RATE_LIMIT, min: 1, max: 100 },
  ];

  for (const validation of numericValidations) {
    if (validation.value !== undefined) {
      const numValue = parseFloat(validation.value);
      if (isNaN(numValue)) {
        errors.push(`${validation.name} must be a valid number, got: ${validation.value}`);
      } else if (numValue < validation.min || numValue > validation.max) {
        errors.push(`${validation.name} must be between ${validation.min} and ${validation.max}, got: ${numValue}`);
      }
    }
  }

  // Validate log level
  const logLevel = process.env.LOG_LEVEL;
  const validLogLevels = ['debug', 'info', 'warn', 'error'];
  if (logLevel && !validLogLevels.includes(logLevel.toLowerCase())) {
    errors.push(`LOG_LEVEL must be one of: ${validLogLevels.join(', ')}, got: ${logLevel}`);
  }

  // Validate boolean values
  const booleanValidations = [
    { name: 'DISCORD_RICH_EMBEDS', value: process.env.DISCORD_RICH_EMBEDS },
  ];

  for (const validation of booleanValidations) {
    if (validation.value !== undefined && !isValidBoolean(validation.value)) {
      errors.push(`${validation.name} must be 'true' or 'false', got: ${validation.value}`);
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

function isValidDiscordWebhook(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'discord.com' && 
           parsed.pathname.startsWith('/api/webhooks/') &&
           parsed.pathname.split('/').length >= 5;
  } catch {
    return false;
  }
}

function isValidBoolean(value: string): boolean {
  return value.toLowerCase() === 'true' || value.toLowerCase() === 'false';
}

export function validateAndLogConfiguration(): void {
  const result = validateEnvironmentVariables();

  if (result.warnings.length > 0) {
    logger.warn('Configuration warnings:');
    result.warnings.forEach(warning => logger.warn(`  - ${warning}`));
  }

  if (!result.isValid) {
    logger.error('Configuration validation failed:');
    result.errors.forEach(error => logger.error(`  - ${error}`));
    throw new Error('Invalid configuration. Please check your environment variables.');
  }

  logger.info('✅ Configuration validation passed');
}

/**
 * Validate detection-config.json file
 */
export function validateDetectionConfig(configPath?: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    // Load config file
    const path = configPath || './config/detection-config.json';
    if (!fs.existsSync(path)) {
      errors.push(`Configuration file not found: ${path}`);
      return { isValid: false, errors, warnings };
    }

    const configData = fs.readFileSync(path, 'utf-8');
    const config: DetectionConfig = JSON.parse(configData);

    // Validate structure
    if (!config.detection) {
      errors.push('Missing "detection" section in config');
      return { isValid: false, errors, warnings };
    }

    // Validate signal thresholds
    const signals = config.detection.signals;
    if (signals) {
      // Volume spike
      if (signals.volumeSpike) {
        validateRange(errors, 'volumeSpike.multiplier', signals.volumeSpike.multiplier, 1.0, 10.0);
        validateRange(errors, 'volumeSpike.minConfidence', signals.volumeSpike.minConfidence, 0, 1);
      }

      // Price movement
      if (signals.priceMovement) {
        validateRange(errors, 'priceMovement.percentageThreshold', signals.priceMovement.percentageThreshold, 0.1, 50);
        validateRange(errors, 'priceMovement.minVolume', signals.priceMovement.minVolume, 0, 1000000);
      }

      // Activity detection
      if (signals.activityDetection) {
        validateRange(errors, 'activityDetection.activityThreshold', signals.activityDetection.activityThreshold, 0, 100);
        validateRange(errors, 'activityDetection.baselineActivityScore', signals.activityDetection.baselineActivityScore, 0, 100);
      }
    }

    // Validate alert prioritization
    const alertPrioritization = config.detection.alertPrioritization;
    if (alertPrioritization) {
      if (alertPrioritization.thresholds) {
        const t = alertPrioritization.thresholds;
        validateRange(errors, 'alertPrioritization.thresholds.critical', t.critical, 0, 100);
        validateRange(errors, 'alertPrioritization.thresholds.high', t.high, 0, 100);
        validateRange(errors, 'alertPrioritization.thresholds.medium', t.medium, 0, 100);

        // Logical validation: critical > high > medium
        if (t.critical <= t.high) {
          errors.push('alertPrioritization.thresholds.critical must be > high');
        }
        if (t.high <= t.medium) {
          errors.push('alertPrioritization.thresholds.high must be > medium');
        }
      }

      // Validate quality filters
      if (alertPrioritization.qualityFilters) {
        const qf = alertPrioritization.qualityFilters;
        validateRange(errors, 'qualityFilters.minOpportunityScore', qf.minOpportunityScore, 0, 100);
        validateRange(errors, 'qualityFilters.minCategoryScore', qf.minCategoryScore, 0, 10);
        validateRange(errors, 'qualityFilters.minVolumeRatio', qf.minVolumeRatio, 0, 1);
      }
    }

    // Validate microstructure thresholds
    const microstructure = config.detection.microstructure;
    if (microstructure) {
      if (microstructure.orderbookImbalance) {
        validateRange(errors, 'microstructure.orderbookImbalance.threshold', microstructure.orderbookImbalance.threshold, 0, 1);
        validateRange(errors, 'microstructure.orderbookImbalance.depth', microstructure.orderbookImbalance.depth, 1, 100);
        validateRange(errors, 'microstructure.orderbookImbalance.minSpreadBps', microstructure.orderbookImbalance.minSpreadBps, 0, 1000);
      }

      if (microstructure.frontRunning) {
        validateRange(errors, 'microstructure.frontRunning.scoreThreshold', microstructure.frontRunning.scoreThreshold, 0, 1);
      }
    }

    // Validate statistical thresholds
    const statistical = config.detection.statistical;
    if (statistical?.anomalyDetection) {
      validateRange(errors, 'statistical.anomalyDetection.zScoreThreshold', statistical.anomalyDetection.zScoreThreshold, 0.1, 10);
      validateRange(errors, 'statistical.anomalyDetection.mahalanobisThreshold', statistical.anomalyDetection.mahalanobisThreshold, 0.1, 20);
      validateRange(errors, 'statistical.anomalyDetection.isolationForestThreshold', statistical.anomalyDetection.isolationForestThreshold, 0, 1);
    }

    // Validate confidence thresholds
    const alerts = config.detection.alerts;
    if (alerts?.confidenceThresholds) {
      const ct = alerts.confidenceThresholds;
      validateRange(errors, 'alerts.confidenceThresholds.info', ct.info, 0, 1);
      validateRange(errors, 'alerts.confidenceThresholds.warning', ct.warning, 0, 1);
      validateRange(errors, 'alerts.confidenceThresholds.critical', ct.critical, 0, 1);

      // Logical validation: critical > warning > info
      if (ct.critical <= ct.warning) {
        warnings.push('alerts.confidenceThresholds.critical should be > warning');
      }
      if (ct.warning <= ct.info) {
        warnings.push('alerts.confidenceThresholds.warning should be > info');
      }
    }

    // Validate performance settings
    if (config.performance) {
      if (config.performance.processing) {
        const p = config.performance.processing;
        if (p.maxConcurrentRequests !== undefined) {
          validateRange(errors, 'performance.processing.maxConcurrentRequests', p.maxConcurrentRequests, 1, 100);
        }
        if (p.requestTimeoutMs !== undefined) {
          validateRange(errors, 'performance.processing.requestTimeoutMs', p.requestTimeoutMs, 1000, 120000);
        }
      }

      if (config.performance.memory) {
        const m = config.performance.memory;
        if (m.maxRingBufferSize !== undefined) {
          validateRange(errors, 'performance.memory.maxRingBufferSize', m.maxRingBufferSize, 100, 10000);
        }
        if (m.gcThresholdMb !== undefined) {
          validateRange(errors, 'performance.memory.gcThresholdMb', m.gcThresholdMb, 128, 4096);
        }
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };

  } catch (error) {
    if (error instanceof SyntaxError) {
      errors.push(`Invalid JSON syntax in config file: ${error.message}`);
    } else {
      errors.push(`Error reading config file: ${(error as Error).message}`);
    }
    return { isValid: false, errors, warnings };
  }
}

/**
 * Helper function to validate numeric ranges
 */
function validateRange(errors: string[], fieldName: string, value: any, min: number, max: number): void {
  if (value === undefined || value === null) return; // Skip optional fields

  if (typeof value !== 'number' || isNaN(value)) {
    errors.push(`${fieldName} must be a number, got: ${typeof value}`);
    return;
  }

  if (value < min || value > max) {
    errors.push(`${fieldName} must be between ${min} and ${max}, got: ${value}`);
  }
}

/**
 * Comprehensive validation - runs all validators
 */
export function validateAllConfigurations(): ValidationResult {
  const envResult = validateEnvironmentVariables();
  const configResult = validateDetectionConfig();

  return {
    isValid: envResult.isValid && configResult.isValid,
    errors: [...envResult.errors, ...configResult.errors],
    warnings: [...envResult.warnings, ...configResult.warnings]
  };
}