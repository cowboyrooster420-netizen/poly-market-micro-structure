import { logger } from './logger';

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
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