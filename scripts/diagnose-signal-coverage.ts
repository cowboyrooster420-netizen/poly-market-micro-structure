#!/usr/bin/env ts-node

/**
 * Diagnostic Script: Signal Coverage Analysis
 *
 * Purpose: Identify why signals are only being generated for a few markets
 *
 * This script will:
 * 1. Connect to WebSocket and track which markets send orderbook updates
 * 2. Count how many markets are being tracked vs. receiving data
 * 3. Show which markets are "silent" (no orderbook updates)
 * 4. Test signal detection thresholds
 */

import { WebSocketService } from '../src/services/WebSocketService';
import { PolymarketService } from '../src/services/PolymarketService';
import { configManager } from '../src/config/ConfigManager';
import { logger } from '../src/utils/logger';
import { BotConfig } from '../src/types';
import dotenv from 'dotenv';

dotenv.config();

interface MarketStats {
  marketId: string;
  question: string;
  volume: number;
  assetIds: string[];
  orderbookUpdates: number;
  lastUpdate: number;
}

async function main() {
  console.log('');
  console.log('═'.repeat(80));
  console.log('🔍 SIGNAL COVERAGE DIAGNOSTIC');
  console.log('═'.repeat(80));
  console.log('');
  console.log('This script will monitor WebSocket orderbook updates for 60 seconds');
  console.log('to identify which markets are actually receiving data...');
  console.log('');

  // Create config the same way EarlyBot does
  const systemConfig = configManager.getConfig();

  const config: BotConfig = {
    checkIntervalMs: systemConfig.detection.markets.refreshIntervalMs,
    minVolumeThreshold: systemConfig.detection.markets.minVolumeThreshold,
    maxMarketsToTrack: systemConfig.detection.markets.maxMarketsToTrack,
    logLevel: systemConfig.environment.logLevel,
    apiUrls: {
      clob: process.env.CLOB_API_URL || 'https://clob.polymarket.com',
      gamma: process.env.GAMMA_API_URL || 'https://gamma-api.polymarket.com',
    },
    microstructure: {
      orderbookImbalanceThreshold: systemConfig.detection.microstructure.orderbookImbalance.threshold,
      spreadAnomalyThreshold: systemConfig.detection.microstructure.frontRunning.spreadImpactThreshold,
      liquidityShiftThreshold: systemConfig.detection.microstructure.liquidityVacuum.depthDropThreshold,
      tickBufferSize: systemConfig.performance.memory.maxRingBufferSize,
    },
    discord: {
      webhookUrl: process.env.DISCORD_WEBHOOK_URL,
      enableRichEmbeds: process.env.DISCORD_RICH_EMBEDS !== 'false',
      alertRateLimit: systemConfig.detection.alerts.discordRateLimit,
    },
  };

  const polymarket = new PolymarketService(config);
  const webSocket = new WebSocketService(config);

  // Track orderbook updates per market
  const marketStats = new Map<string, MarketStats>();

  // Set up WebSocket handler
  webSocket.onOrderbook((orderbook) => {
    const marketId = orderbook.marketId;

    if (!marketStats.has(marketId)) {
      marketStats.set(marketId, {
        marketId,
        question: 'Unknown',
        volume: 0,
        assetIds: [],
        orderbookUpdates: 0,
        lastUpdate: Date.now()
      });
    }

    const stats = marketStats.get(marketId)!;
    stats.orderbookUpdates++;
    stats.lastUpdate = Date.now();
  });

  // Initialize services
  await polymarket.initialize();
  await webSocket.connect();

  console.log('✅ Connected to Polymarket API and WebSocket');
  console.log('');

  // Get active markets
  console.log('📥 Fetching active markets...');
  const markets = await polymarket.getActiveMarkets();

  console.log(`Found ${markets.length} active markets after filtering`);
  console.log('');

  // Sort by volume and take top 500
  const sortedMarkets = [...markets]
    .filter(m => m.metadata?.assetIds && m.metadata.assetIds.length > 0)
    .sort((a, b) => b.volumeNum - a.volumeNum)
    .slice(0, 500);

  console.log(`Top ${sortedMarkets.length} markets with asset IDs will be tracked`);
  console.log('');

  // Subscribe to all markets
  console.log('📡 Subscribing to markets via WebSocket...');
  let subscribed = 0;
  for (const market of sortedMarkets) {
    const assetIds = market.metadata?.assetIds || [];

    // Initialize stats
    marketStats.set(market.id, {
      marketId: market.id,
      question: market.question,
      volume: market.volumeNum,
      assetIds,
      orderbookUpdates: 0,
      lastUpdate: 0
    });

    // Subscribe to each asset ID
    for (const assetId of assetIds) {
      webSocket.subscribeToMarket(assetId);
      subscribed++;
    }
  }

  console.log(`✅ Subscribed to ${subscribed} asset IDs across ${sortedMarkets.length} markets`);
  console.log('');
  console.log('⏱️  Monitoring for 60 seconds...');
  console.log('');

  // Monitor for 60 seconds
  const monitoringPeriod = 60000; // 60 seconds
  const startTime = Date.now();
  let lastReport = startTime;

  const reportInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const marketsWithUpdates = Array.from(marketStats.values()).filter(s => s.orderbookUpdates > 0).length;
    const totalUpdates = Array.from(marketStats.values()).reduce((sum, s) => sum + s.orderbookUpdates, 0);

    console.log(`[${elapsed}s] Updates: ${totalUpdates} | Markets with data: ${marketsWithUpdates}/${sortedMarkets.length}`);
  }, 5000);

  // Wait for monitoring period
  await new Promise(resolve => setTimeout(resolve, monitoringPeriod));

  clearInterval(reportInterval);

  console.log('');
  console.log('═'.repeat(80));
  console.log('📊 RESULTS');
  console.log('═'.repeat(80));
  console.log('');

  // Analyze results
  const stats = Array.from(marketStats.values());
  const withUpdates = stats.filter(s => s.orderbookUpdates > 0);
  const withoutUpdates = stats.filter(s => s.orderbookUpdates === 0);
  const totalUpdates = stats.reduce((sum, s) => sum + s.orderbookUpdates, 0);

  console.log(`Total markets tracked: ${stats.length}`);
  console.log(`Markets with orderbook updates: ${withUpdates.length} (${((withUpdates.length / stats.length) * 100).toFixed(1)}%)`);
  console.log(`Markets WITHOUT updates: ${withoutUpdates.length} (${((withoutUpdates.length / stats.length) * 100).toFixed(1)}%)`);
  console.log(`Total orderbook updates received: ${totalUpdates}`);
  console.log('');

  if (withUpdates.length > 0) {
    console.log('🎯 Top 10 Most Active Markets (by orderbook updates):');
    console.log('─'.repeat(80));
    withUpdates
      .sort((a, b) => b.orderbookUpdates - a.orderbookUpdates)
      .slice(0, 10)
      .forEach((stat, i) => {
        console.log(`${i + 1}. [${stat.orderbookUpdates} updates] ${stat.question.substring(0, 60)}`);
        console.log(`   Volume: $${stat.volume.toFixed(0)} | Asset IDs: ${stat.assetIds.length}`);
        console.log('');
      });
  }

  if (withoutUpdates.length > 0) {
    console.log('❌ Sample of Markets with NO Updates (first 10):');
    console.log('─'.repeat(80));
    withoutUpdates
      .slice(0, 10)
      .forEach((stat, i) => {
        console.log(`${i + 1}. ${stat.question.substring(0, 60)}`);
        console.log(`   Volume: $${stat.volume.toFixed(0)} | Asset IDs: ${stat.assetIds.length} | [${stat.assetIds.map(id => id.substring(0, 8)).join(', ')}]`);
        console.log('');
      });
  }

  console.log('═'.repeat(80));
  console.log('💡 DIAGNOSIS');
  console.log('═'.repeat(80));
  console.log('');

  const coverage = (withUpdates.length / stats.length) * 100;

  if (coverage < 10) {
    console.log('🔴 CRITICAL: Less than 10% of markets are receiving orderbook updates!');
    console.log('');
    console.log('Possible causes:');
    console.log('  1. WebSocket connection issues');
    console.log('  2. Asset ID extraction is incorrect');
    console.log('  3. Polymarket API changed format');
    console.log('  4. Subscription limit reached (max 1000 subscriptions)');
    console.log('');
    console.log('Recommended action: Check asset ID extraction in PolymarketService.ts');
  } else if (coverage < 50) {
    console.log('🟡 WARNING: Less than 50% of markets are receiving orderbook updates');
    console.log('');
    console.log('This explains why you\'re only getting signals for a few markets!');
    console.log('');
    console.log('Possible causes:');
    console.log('  1. Low-volume markets don\'t have active trading');
    console.log('  2. Asset IDs may be wrong for some markets');
    console.log('  3. Some markets may be paused/inactive');
    console.log('');
    console.log('Recommended action:');
    console.log('  - Focus on markets that DO receive updates (these are actively traded)');
    console.log('  - Consider filtering out markets without orderbook activity');
  } else {
    console.log('✅ GOOD: Most markets are receiving orderbook updates');
    console.log('');
    console.log('If you\'re still only seeing signals for a few markets, the issue is likely:');
    console.log('  1. Signal detection thresholds are too strict');
    console.log('  2. Most markets don\'t have anomalous activity');
    console.log('');
    console.log('Recommended action:');
    console.log('  - Lower signal detection thresholds in config/detection-config.json');
    console.log('  - Check signal performance tracker to see detection rates');
  }

  console.log('');

  // Cleanup
  webSocket.disconnect();
}

main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});
