#!/usr/bin/env node

import { webDashboard } from '../dashboard/WebDashboard';
import { EarlyBot } from '../bot/EarlyBot';
import { advancedLogger } from '../utils/AdvancedLogger';
import { configManager } from '../config/ConfigManager';

/**
 * CLI command to start the web dashboard
 */

async function startDashboard() {
  try {
    console.log('🚀 Starting Poly Early Bot Web Dashboard...\n');

    // Load configuration
    const systemConfig = configManager.getConfig();
    
    if (!systemConfig.features.enableWebDashboard) {
      console.log('❌ Web dashboard is disabled in configuration');
      console.log('   Enable it by setting features.enableWebDashboard to true');
      process.exit(1);
    }

    // Initialize bot instance (for monitoring)
    const bot = new EarlyBot();
    await bot.initialize();
    
    // Set bot instance for dashboard monitoring
    webDashboard.setBotInstance(bot);

    // Start the dashboard
    await webDashboard.start();
    
    const dashboardPort = parseInt(process.env.DASHBOARD_PORT || '3001');
    
    console.log('✅ Dashboard started successfully!');
    console.log('');
    console.log('📊 Dashboard URL: http://localhost:' + dashboardPort);
    console.log('🔧 API Endpoints:');
    console.log('   • GET  /api/dashboard  - Dashboard data');
    console.log('   • GET  /api/config     - Bot configuration');
    console.log('   • POST /api/config     - Update configuration');
    console.log('   • GET  /api/signals    - Recent signals');
    console.log('   • GET  /api/workers    - Worker thread stats');
    console.log('   • GET  /health         - Health check');
    console.log('');
    console.log('🎮 Features:');
    console.log('   • Real-time bot monitoring');
    console.log('   • Live signal feed');
    console.log('   • Configuration management');
    console.log('   • Worker thread performance');
    console.log('   • System health metrics');
    console.log('');
    
    // Optionally start the bot for live monitoring
    if (process.argv.includes('--with-bot')) {
      console.log('🤖 Starting bot for live monitoring...');
      await bot.start();
      console.log('✅ Bot started and being monitored by dashboard');
    } else {
      console.log('💡 Use --with-bot flag to also start the bot for live monitoring');
    }
    
    console.log('');
    console.log('Press Ctrl+C to stop the dashboard');

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\n🛑 Shutting down dashboard...');
      
      try {
        if (process.argv.includes('--with-bot')) {
          await bot.stop();
        }
        await webDashboard.stop();
        console.log('✅ Dashboard stopped gracefully');
        process.exit(0);
      } catch (error) {
        console.error('❌ Error during shutdown:', error);
        process.exit(1);
      }
    });

  } catch (error) {
    console.error('❌ Failed to start dashboard:', error);
    advancedLogger.error('Dashboard startup failed', error as Error, {
      component: 'dashboard_cli',
      operation: 'startup'
    });
    process.exit(1);
  }
}

// Parse command line arguments
function showHelp() {
  console.log(`
🤖 Poly Early Bot Web Dashboard

Usage: npm run dashboard [options]

Options:
  --with-bot     Also start the bot for live monitoring
  --help         Show this help message

Examples:
  npm run dashboard                  # Start dashboard only
  npm run dashboard -- --with-bot   # Start dashboard with live bot monitoring
  
Environment Variables:
  DASHBOARD_PORT=3001               # Dashboard port (default: 3001)
  DASHBOARD_AUTH=true               # Enable authentication (default: false)
  DASHBOARD_AUTH_TOKEN=secret       # Authentication token
  ENABLE_WEB_DASHBOARD=true         # Enable dashboard feature

The dashboard provides:
• Real-time monitoring of bot status and performance
• Live feed of detected signals
• Interactive configuration management
• Worker thread performance metrics
• System health monitoring
• Manual signal validation interface
`);
}

// Check for help flag
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  showHelp();
  process.exit(0);
}

// Start the dashboard
startDashboard().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});