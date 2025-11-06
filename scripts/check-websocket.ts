#!/usr/bin/env ts-node
/**
 * Quick script to verify WebSocket connectivity for microstructure detection
 */

import { MicrostructureDetector } from '../src/services/MicrostructureDetector';
import { advancedLogger as logger } from '../src/utils/AdvancedLogger';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

async function checkWebSocket() {
  console.log('🔍 Checking WebSocket connectivity...\n');

  // Create complete config matching BotConfig interface
  const config = {
    checkIntervalMs: 30000,
    minVolumeThreshold: 5000,
    maxMarketsToTrack: 100,
    logLevel: 'info',
    apiUrls: {
      clob: process.env.CLOB_API_URL || 'https://clob.polymarket.com',
      gamma: process.env.GAMMA_API_URL || 'https://gamma-api.polymarket.com'
    },
    microstructure: {
      orderbookImbalanceThreshold: 0.15,
      spreadAnomalyThreshold: 2.0,
      liquidityShiftThreshold: 20,
      tickBufferSize: 1000
    },
    discord: {
      webhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
      enableRichEmbeds: true,
      alertRateLimit: 10
    }
  };

  try {
    // Initialize detector
    const detector = new MicrostructureDetector(config);

    console.log('📡 Initializing MicrostructureDetector...');
    await detector.initialize();

    // Wait 2 seconds for connection
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Check health
    const health = await detector.healthCheck();

    console.log('\n📊 Health Check Results:');
    console.log('========================');
    console.log(`Overall Health: ${health.healthy ? '✅ HEALTHY' : '❌ UNHEALTHY'}`);
    console.log(`\nDetails:`);
    console.log(`  WebSocket Connected: ${health.details.websocket?.connected ? '✅ YES' : '❌ NO'}`);
    console.log(`  Tracked Markets: ${health.details.trackedMarkets}`);
    console.log(`  Total Signals: ${health.details.totalSignals}`);
    console.log(`  Enhanced Analyzer: ${health.details.enhancedAnalyzer?.healthy ? '✅' : '❌'}`);
    console.log(`  Front-Run Engine: ${health.details.frontRunEngine?.healthy ? '✅' : '❌'}`);

    if (health.details.websocket?.connected) {
      console.log('\n🎉 SUCCESS! WebSocket is connected and microstructure detection is operational.');
      console.log('\nYour bot should be detecting:');
      console.log('  🕵️  Stealth accumulation (Z-score > 2)');
      console.log('  🌙 Off-hours anomalies (Z-score > 2)');
      console.log('  📈 Micro-price drift');
      console.log('  💧 Liquidity vacuums');
      console.log('  🔥 Aggressive buyer/seller patterns');
      console.log('  🧊 Iceberg orders');
    } else {
      console.log('\n⚠️  WARNING! WebSocket is NOT connected.');
      console.log('\nPossible issues:');
      console.log('  1. Network connectivity problems');
      console.log('  2. CLOB API URL incorrect in .env');
      console.log('  3. Firewall blocking WebSocket connections');
      console.log('  4. Rate limiting from Polymarket');
      console.log('\nMicrostructure signals (stealth accumulation, off-hours, etc.) will NOT be detected without WebSocket!');
    }

    // Clean up
    await detector.stop();
    process.exit(health.healthy ? 0 : 1);

  } catch (error) {
    console.error('\n❌ ERROR:', error);
    console.error('\nWebSocket connection failed. Check your configuration and network.');
    process.exit(1);
  }
}

checkWebSocket();
