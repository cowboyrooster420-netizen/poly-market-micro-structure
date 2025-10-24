import dotenv from 'dotenv';
import { EarlyBot } from './bot/EarlyBot';
import { logger } from './utils/logger';
import { validateAndLogConfiguration } from './utils/configValidator';

dotenv.config();

// Validate configuration before starting
validateAndLogConfiguration();

let bot: EarlyBot | null = null;

async function main() {
  logger.info('🚀 Starting Poly Early Bot...');

  try {
    bot = new EarlyBot();
    await bot.initialize();
    await bot.start();
    
    logger.info('✅ Poly Early Bot is running');
  } catch (error) {
    logger.error('❌ Failed to start bot:', error);
    process.exit(1);
  }
}

// Graceful shutdown implementation
let isShuttingDown = false;

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) {
    logger.warn('Shutdown already in progress, forcing exit...');
    process.exit(1);
  }
  
  isShuttingDown = true;
  logger.info(`\n🛑 Received ${signal}, shutting down gracefully...`);
  
  try {
    if (bot) {
      // Stop the bot with timeout
      const shutdownPromise = bot.stop();
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Shutdown timeout')), 10000)
      );
      
      await Promise.race([shutdownPromise, timeoutPromise]);
    }
    
    logger.info('✅ Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    logger.error('❌ Error during shutdown:', error);
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  gracefulShutdown('SIGINT').catch(err => {
    logger.error('Error during SIGINT shutdown:', err);
    process.exit(1);
  });
});

process.on('SIGTERM', () => {
  gracefulShutdown('SIGTERM').catch(err => {
    logger.error('Error during SIGTERM shutdown:', err);
    process.exit(1);
  });
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  gracefulShutdown('uncaughtException').catch(err => {
    logger.error('Error during uncaughtException shutdown:', err);
    process.exit(1);
  });
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  gracefulShutdown('unhandledRejection').catch(err => {
    logger.error('Error during unhandledRejection shutdown:', err);
    process.exit(1);
  });
});

main().catch((error) => {
  logger.error('Fatal error:', error);
  process.exit(1);
});