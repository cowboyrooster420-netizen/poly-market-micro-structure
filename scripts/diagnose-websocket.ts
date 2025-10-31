#!/usr/bin/env ts-node

/**
 * Diagnostic: Check WebSocket subscription status
 *
 * This will tell us:
 * - How many markets are being tracked
 * - How many WebSocket subscriptions are active
 * - Which markets are actually subscribed
 */

import { EarlyBot } from '../src/bot/EarlyBot';
import { logger } from '../src/utils/logger';

async function main() {
  console.log('🔍 WebSocket Subscription Diagnostic\n');

  const bot = new EarlyBot();
  await bot.initialize();

  // Give it a moment to connect and subscribe
  console.log('⏳ Waiting 10 seconds for WebSocket to connect and subscribe...\n');
  await new Promise(resolve => setTimeout(resolve, 10000));

  // Access private fields via reflection
  const microstructureDetector = (bot as any).microstructureDetector;
  const webSocketService = (bot as any).webSocketService || microstructureDetector?.webSocketService;

  if (!microstructureDetector) {
    console.error('❌ Could not access microstructureDetector');
    process.exit(1);
  }

  if (!webSocketService) {
    console.error('❌ Could not access webSocketService');
    process.exit(1);
  }

  const trackedMarkets = microstructureDetector.trackedMarkets;
  const subscribedMarkets = webSocketService.subscribedMarkets;
  const isConnected = webSocketService.isConnected;

  console.log('═'.repeat(80));
  console.log('WEBSOCKET STATUS');
  console.log('═'.repeat(80));
  console.log(`WebSocket Connected: ${isConnected ? '✅ YES' : '❌ NO'}`);
  console.log(`Tracked Markets: ${trackedMarkets?.size || 0}`);
  console.log(`Subscribed Markets: ${subscribedMarkets?.size || 0}`);
  console.log('');

  if (subscribedMarkets && subscribedMarkets.size > 0) {
    console.log('Sample Subscribed Markets (first 20):');
    console.log('-'.repeat(80));
    const markets = Array.from(subscribedMarkets).slice(0, 20);
    markets.forEach((marketId, i) => {
      console.log(`${(i + 1).toString().padStart(2)}. ${marketId}`);
    });

    if (subscribedMarkets.size > 20) {
      console.log(`... and ${subscribedMarkets.size - 20} more`);
    }
  }

  console.log('');
  console.log('═'.repeat(80));

  // Show discrepancy if exists
  if (trackedMarkets && subscribedMarkets) {
    const trackedCount = trackedMarkets.size;
    const subscribedCount = subscribedMarkets.size;

    if (trackedCount !== subscribedCount) {
      console.log('⚠️  WARNING: Mismatch between tracked and subscribed markets!');
      console.log(`   Tracked: ${trackedCount}`);
      console.log(`   Subscribed: ${subscribedCount}`);
      console.log(`   Missing: ${trackedCount - subscribedCount}`);
      console.log('');
      console.log('This means WebSocket subscriptions are failing for some markets.');
    } else {
      console.log('✅ All tracked markets are properly subscribed');
    }
  }

  await bot.stop();
  console.log('');
  console.log('✅ Diagnostic complete');
  process.exit(0);
}

main().catch(error => {
  console.error('❌ Error:', error);
  process.exit(1);
});
