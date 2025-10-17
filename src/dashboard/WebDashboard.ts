import express from 'express';
import { createServer } from 'http';
import { Server as SocketIO } from 'socket.io';
import path from 'path';
import { EarlyBot } from '../bot/EarlyBot';
import { metricsCollector } from '../monitoring/MetricsCollector';
import { statisticalWorkerService } from '../services/StatisticalWorkerService';
import { configManager } from '../config/ConfigManager';
import { advancedLogger } from '../utils/AdvancedLogger';
import { errorHandler } from '../utils/ErrorHandler';

export interface DashboardConfig {
  port: number;
  enableAuth: boolean;
  authToken?: string;
  corsOrigins: string[];
}

export interface DashboardData {
  timestamp: number;
  bot: {
    running: boolean;
    uptime: number;
    healthScore: number;
    trackedMarkets: number;
    lastScanTime: number;
  };
  metrics: {
    signalsDetected: number;
    alertsSent: number;
    errorsCount: number;
    averageResponseTime: number;
    memoryUsage: number;
    cpuUsage: number;
  };
  recentSignals: Array<{
    marketId: string;
    signalType: string;
    confidence: number;
    timestamp: number;
    marketQuestion: string;
  }>;
  configuration: {
    volumeThreshold: number;
    priceThreshold: number;
    correlationThreshold: number;
    activeFeatures: string[];
  };
  workerThreads: {
    activeWorkers: number;
    totalTasks: number;
    averageProcessingTime: number;
    errorRate: number;
  };
}

/**
 * Web Dashboard for monitoring the Poly Early Bot
 * Provides real-time monitoring, configuration management, and signal validation
 */
export class WebDashboard {
  private app: express.Application;
  private server: any;
  private io: SocketIO;
  private config: DashboardConfig;
  private bot?: EarlyBot;
  private isRunning = false;
  private updateInterval?: NodeJS.Timeout;
  private recentSignals: Array<any> = [];

  constructor(config: DashboardConfig) {
    this.config = config;
    this.app = express();
    this.server = createServer(this.app);
    this.io = new SocketIO(this.server, {
      cors: {
        origin: config.corsOrigins,
        methods: ["GET", "POST"]
      }
    });

    this.setupExpress();
    this.setupSocketIO();
    this.setupRoutes();

    advancedLogger.info('Web dashboard initialized', {
      component: 'web_dashboard',
      operation: 'initialize',
      metadata: { port: config.port, authEnabled: config.enableAuth }
    });
  }

  /**
   * Set the bot instance for monitoring
   */
  setBotInstance(bot: EarlyBot): void {
    this.bot = bot;
    
    // Subscribe to real-time signal events if the bot supports it
    // This would require the bot to emit events, but for now we'll poll
  }

  /**
   * Start the web dashboard server
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server.listen(this.config.port, () => {
          this.isRunning = true;
          
          // Start real-time data updates
          this.startDataUpdates();
          
          advancedLogger.info(`Web dashboard started on port ${this.config.port}`, {
            component: 'web_dashboard',
            operation: 'start',
            metadata: { url: `http://localhost:${this.config.port}` }
          });
          
          resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Stop the web dashboard server
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.isRunning = false;
      
      if (this.updateInterval) {
        clearInterval(this.updateInterval);
      }
      
      this.server.close(() => {
        advancedLogger.info('Web dashboard stopped', {
          component: 'web_dashboard',
          operation: 'stop'
        });
        resolve();
      });
    });
  }

  private setupExpress(): void {
    // Serve static files
    this.app.use(express.static(path.join(__dirname, 'public')));
    this.app.use(express.json());

    // Basic authentication middleware
    if (this.config.enableAuth) {
      this.app.use((req, res, next) => {
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (token !== this.config.authToken) {
          return res.status(401).json({ error: 'Unauthorized' });
        }
        next();
      });
    }

    // CORS
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', this.config.corsOrigins.join(','));
      res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      next();
    });
  }

  private setupSocketIO(): void {
    this.io.on('connection', (socket) => {
      advancedLogger.info('Dashboard client connected', {
        component: 'web_dashboard',
        operation: 'client_connection',
        metadata: { socketId: socket.id }
      });

      // Send initial data
      this.sendDashboardData(socket);

      // Handle client requests
      socket.on('get_dashboard_data', () => {
        this.sendDashboardData(socket);
      });

      socket.on('get_configuration', () => {
        socket.emit('configuration_data', configManager.getConfig());
      });

      socket.on('update_configuration', async (newConfig) => {
        try {
          configManager.updateConfig(newConfig);
          socket.emit('configuration_updated', { success: true });
          
          // Broadcast to all clients
          this.io.emit('configuration_changed', newConfig);
          
        } catch (error) {
          socket.emit('configuration_updated', { 
            success: false, 
            error: (error as Error).message 
          });
        }
      });

      socket.on('manual_signal_validation', async (signalId) => {
        // This would integrate with a manual signal validation system
        socket.emit('validation_result', { 
          signalId, 
          status: 'validated',
          timestamp: Date.now()
        });
      });

      socket.on('disconnect', () => {
        advancedLogger.info('Dashboard client disconnected', {
          component: 'web_dashboard',
          operation: 'client_disconnection',
          metadata: { socketId: socket.id }
        });
      });
    });
  }

  private setupRoutes(): void {
    // Health check
    this.app.get('/health', (req, res) => {
      res.json({ 
        status: 'healthy', 
        timestamp: Date.now(),
        dashboard: this.isRunning
      });
    });

    // Get current dashboard data
    this.app.get('/api/dashboard', async (req, res) => {
      try {
        const data = await this.getDashboardData();
        res.json(data);
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    });

    // Get bot configuration
    this.app.get('/api/config', (req, res) => {
      try {
        const config = configManager.getConfig();
        res.json(config);
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    });

    // Update bot configuration
    this.app.post('/api/config', (req, res) => {
      try {
        configManager.updateConfig(req.body);
        res.json({ success: true, message: 'Configuration updated' });
        
        // Broadcast to WebSocket clients
        this.io.emit('configuration_changed', req.body);
        
      } catch (error) {
        res.status(400).json({ error: (error as Error).message });
      }
    });

    // Get recent signals
    this.app.get('/api/signals', (req, res) => {
      const limit = parseInt(req.query.limit as string) || 50;
      res.json(this.recentSignals.slice(-limit));
    });

    // Validate a signal manually
    this.app.post('/api/signals/:id/validate', (req, res) => {
      const signalId = req.params.id;
      const validation = req.body;
      
      // Store validation (in production, this would go to a database)
      advancedLogger.info('Manual signal validation received', {
        component: 'web_dashboard',
        operation: 'signal_validation',
        metadata: { signalId, validation }
      });
      
      res.json({ success: true, signalId, validation });
    });

    // Get worker thread statistics
    this.app.get('/api/workers', async (req, res) => {
      try {
        const stats = statisticalWorkerService.getPerformanceStats();
        const health = await statisticalWorkerService.healthCheck();
        res.json({ stats, health });
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    });

    // Serve the main dashboard page
    this.app.get('/', (req, res) => {
      res.send(this.getDashboardHTML());
    });
  }

  private async getDashboardData(): Promise<DashboardData> {
    const botHealth = this.bot ? await this.bot.getHealthStatus() : null;
    const systemMetrics = metricsCollector.getCurrentMetrics();
    const workerStats = statisticalWorkerService.getPerformanceStats();
    const systemConfig = configManager.getConfig();
    
    return {
      timestamp: Date.now(),
      bot: {
        running: botHealth?.running || false,
        uptime: botHealth?.uptime || 0,
        healthScore: botHealth?.score || 0,
        trackedMarkets: botHealth?.trackedMarkets || 0,
        lastScanTime: Date.now() // This would come from the bot's last scan time
      },
      metrics: {
        signalsDetected: systemMetrics?.business?.signalsGenerated || 0,
        alertsSent: systemMetrics?.business?.alertsSent || 0,
        errorsCount: botHealth?.errorStatistics?.totalErrors || 0,
        averageResponseTime: systemMetrics?.application?.responseTime || 0,
        memoryUsage: systemMetrics?.system?.memory?.percentage || 0,
        cpuUsage: systemMetrics?.system?.cpu?.usage || 0
      },
      recentSignals: this.recentSignals.slice(-10),
      configuration: {
        volumeThreshold: systemConfig.detection.signals.volumeSpike.multiplier,
        priceThreshold: systemConfig.detection.signals.priceMovement.percentageThreshold,
        correlationThreshold: systemConfig.detection.signals.crossMarketCorrelation.correlationThreshold,
        activeFeatures: Object.entries(systemConfig.features)
          .filter(([key, value]) => value)
          .map(([key]) => key)
      },
      workerThreads: {
        activeWorkers: workerStats.activeWorkers,
        totalTasks: workerStats.workerStats.reduce((sum, worker) => sum + worker.tasksCompleted, 0),
        averageProcessingTime: workerStats.workerStats.length > 0 ? 
          workerStats.workerStats.reduce((sum, worker) => sum + worker.averageProcessingTime, 0) / workerStats.workerStats.length : 0,
        errorRate: workerStats.workerStats.length > 0 ?
          workerStats.workerStats.reduce((sum, worker) => sum + worker.errorCount, 0) / 
          Math.max(1, workerStats.workerStats.reduce((sum, worker) => sum + worker.tasksCompleted, 0)) : 0
      }
    };
  }

  private async sendDashboardData(socket?: any): Promise<void> {
    try {
      const data = await this.getDashboardData();
      if (socket) {
        socket.emit('dashboard_data', data);
      } else {
        this.io.emit('dashboard_data', data);
      }
    } catch (error) {
      advancedLogger.error('Error sending dashboard data', error as Error, {
        component: 'web_dashboard',
        operation: 'send_data'
      });
    }
  }

  private startDataUpdates(): void {
    // Update dashboard data every 5 seconds
    this.updateInterval = setInterval(() => {
      this.sendDashboardData();
    }, 5000);
  }

  /**
   * Add a signal to the recent signals list (called by the bot)
   */
  addSignal(signal: any): void {
    this.recentSignals.push({
      marketId: signal.marketId,
      signalType: signal.signalType,
      confidence: signal.confidence,
      timestamp: signal.timestamp,
      marketQuestion: signal.market?.question || 'Unknown'
    });

    // Keep only last 100 signals
    if (this.recentSignals.length > 100) {
      this.recentSignals.shift();
    }

    // Broadcast to connected clients
    this.io.emit('new_signal', this.recentSignals[this.recentSignals.length - 1]);
  }

  private getDashboardHTML(): string {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Poly Early Bot - Dashboard</title>
    <script src="https://cdn.socket.io/4.7.2/socket.io.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body { 
            font-family: 'Segoe UI', Arial, sans-serif; 
            margin: 0; 
            padding: 20px; 
            background: #f5f5f5; 
        }
        .header { 
            background: #2c3e50; 
            color: white; 
            padding: 20px; 
            border-radius: 8px; 
            margin-bottom: 20px; 
        }
        .dashboard-grid { 
            display: grid; 
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); 
            gap: 20px; 
        }
        .card { 
            background: white; 
            padding: 20px; 
            border-radius: 8px; 
            box-shadow: 0 2px 4px rgba(0,0,0,0.1); 
        }
        .metric { 
            display: flex; 
            justify-content: space-between; 
            padding: 10px 0; 
            border-bottom: 1px solid #eee; 
        }
        .status-indicator { 
            display: inline-block; 
            width: 12px; 
            height: 12px; 
            border-radius: 50%; 
            margin-right: 8px; 
        }
        .status-running { background: #27ae60; }
        .status-stopped { background: #e74c3c; }
        .signal-item { 
            padding: 10px; 
            margin: 5px 0; 
            background: #f8f9fa; 
            border-radius: 4px; 
            border-left: 4px solid #3498db; 
        }
        .confidence-high { border-left-color: #27ae60; }
        .confidence-medium { border-left-color: #f39c12; }
        .confidence-low { border-left-color: #e74c3c; }
        button { 
            background: #3498db; 
            color: white; 
            border: none; 
            padding: 10px 20px; 
            border-radius: 4px; 
            cursor: pointer; 
        }
        button:hover { background: #2980b9; }
        .chart-container { height: 200px; position: relative; }
    </style>
</head>
<body>
    <div class="header">
        <h1>🤖 Poly Early Bot Dashboard</h1>
        <p>Real-time monitoring and signal validation</p>
    </div>

    <div class="dashboard-grid">
        <div class="card">
            <h3>Bot Status</h3>
            <div class="metric">
                <span>Status:</span>
                <span id="bot-status">
                    <span class="status-indicator status-stopped"></span>
                    Checking...
                </span>
            </div>
            <div class="metric">
                <span>Uptime:</span>
                <span id="bot-uptime">-</span>
            </div>
            <div class="metric">
                <span>Health Score:</span>
                <span id="health-score">-</span>
            </div>
            <div class="metric">
                <span>Tracked Markets:</span>
                <span id="tracked-markets">-</span>
            </div>
        </div>

        <div class="card">
            <h3>System Metrics</h3>
            <div class="metric">
                <span>Signals Detected:</span>
                <span id="signals-count">-</span>
            </div>
            <div class="metric">
                <span>Alerts Sent:</span>
                <span id="alerts-count">-</span>
            </div>
            <div class="metric">
                <span>Memory Usage:</span>
                <span id="memory-usage">-</span>
            </div>
            <div class="metric">
                <span>CPU Usage:</span>
                <span id="cpu-usage">-</span>
            </div>
        </div>

        <div class="card">
            <h3>Worker Threads</h3>
            <div class="metric">
                <span>Active Workers:</span>
                <span id="active-workers">-</span>
            </div>
            <div class="metric">
                <span>Total Tasks:</span>
                <span id="total-tasks">-</span>
            </div>
            <div class="metric">
                <span>Avg Processing Time:</span>
                <span id="avg-processing">-</span>
            </div>
            <div class="metric">
                <span>Error Rate:</span>
                <span id="error-rate">-</span>
            </div>
        </div>

        <div class="card">
            <h3>Configuration</h3>
            <div class="metric">
                <span>Volume Threshold:</span>
                <span id="volume-threshold">-</span>
            </div>
            <div class="metric">
                <span>Price Threshold:</span>
                <span id="price-threshold">-</span>
            </div>
            <div class="metric">
                <span>Correlation Threshold:</span>
                <span id="correlation-threshold">-</span>
            </div>
            <button onclick="showConfigModal()">Update Configuration</button>
        </div>

        <div class="card" style="grid-column: 1 / -1;">
            <h3>Recent Signals</h3>
            <div id="recent-signals">Loading...</div>
        </div>

        <div class="card" style="grid-column: 1 / -1;">
            <h3>Performance Chart</h3>
            <div class="chart-container">
                <canvas id="performanceChart"></canvas>
            </div>
        </div>
    </div>

    <script>
        const socket = io();
        let performanceChart;

        // Initialize the performance chart
        function initChart() {
            const ctx = document.getElementById('performanceChart').getContext('2d');
            performanceChart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [{
                        label: 'Signals per Minute',
                        data: [],
                        borderColor: '#3498db',
                        tension: 0.1
                    }, {
                        label: 'CPU Usage %',
                        data: [],
                        borderColor: '#e74c3c',
                        tension: 0.1
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        x: { display: false }
                    }
                }
            });
        }

        // Update dashboard with real-time data
        socket.on('dashboard_data', (data) => {
            // Update bot status
            const indicator = data.bot.running ? 'status-running' : 'status-stopped';
            const status = data.bot.running ? 'Running' : 'Stopped';
            document.getElementById('bot-status').innerHTML = 
                '<span class="status-indicator ' + indicator + '"></span>' + status;
            
            document.getElementById('bot-uptime').textContent = 
                Math.floor(data.bot.uptime / 1000 / 60) + ' minutes';
            document.getElementById('health-score').textContent = 
                (data.bot.healthScore * 100).toFixed(1) + '%';
            document.getElementById('tracked-markets').textContent = data.bot.trackedMarkets;

            // Update metrics
            document.getElementById('signals-count').textContent = data.metrics.signalsDetected;
            document.getElementById('alerts-count').textContent = data.metrics.alertsSent;
            document.getElementById('memory-usage').textContent = data.metrics.memoryUsage.toFixed(1) + '%';
            document.getElementById('cpu-usage').textContent = data.metrics.cpuUsage.toFixed(1) + '%';

            // Update worker threads
            document.getElementById('active-workers').textContent = data.workerThreads.activeWorkers;
            document.getElementById('total-tasks').textContent = data.workerThreads.totalTasks;
            document.getElementById('avg-processing').textContent = data.workerThreads.averageProcessingTime.toFixed(0) + 'ms';
            document.getElementById('error-rate').textContent = (data.workerThreads.errorRate * 100).toFixed(2) + '%';

            // Update configuration
            document.getElementById('volume-threshold').textContent = data.configuration.volumeThreshold + 'x';
            document.getElementById('price-threshold').textContent = data.configuration.priceThreshold + '%';
            document.getElementById('correlation-threshold').textContent = data.configuration.correlationThreshold;

            // Update recent signals
            updateRecentSignals(data.recentSignals);

            // Update chart
            updateChart(data);
        });

        socket.on('new_signal', (signal) => {
            addSignalToList(signal);
        });

        function updateRecentSignals(signals) {
            const container = document.getElementById('recent-signals');
            if (signals.length === 0) {
                container.innerHTML = '<p>No recent signals</p>';
                return;
            }

            container.innerHTML = signals.map(signal => {
                const confidenceClass = signal.confidence > 0.8 ? 'confidence-high' : 
                                       signal.confidence > 0.6 ? 'confidence-medium' : 'confidence-low';
                return '<div class="signal-item ' + confidenceClass + '">' +
                       '<strong>' + signal.signalType + '</strong> ' +
                       '(Confidence: ' + (signal.confidence * 100).toFixed(0) + '%) - ' +
                       signal.marketQuestion.substring(0, 50) + '...' +
                       '<br><small>' + new Date(signal.timestamp).toLocaleTimeString() + '</small>' +
                       '</div>';
            }).join('');
        }

        function addSignalToList(signal) {
            // Add new signal to the top of the list
            const container = document.getElementById('recent-signals');
            const confidenceClass = signal.confidence > 0.8 ? 'confidence-high' : 
                                   signal.confidence > 0.6 ? 'confidence-medium' : 'confidence-low';
            const signalHtml = '<div class="signal-item ' + confidenceClass + '">' +
                              '<strong>' + signal.signalType + '</strong> ' +
                              '(Confidence: ' + (signal.confidence * 100).toFixed(0) + '%) - ' +
                              signal.marketQuestion.substring(0, 50) + '...' +
                              '<br><small>' + new Date(signal.timestamp).toLocaleTimeString() + '</small>' +
                              '</div>';
            container.insertAdjacentHTML('afterbegin', signalHtml);
        }

        function updateChart(data) {
            if (!performanceChart) return;

            const now = new Date().toLocaleTimeString();
            performanceChart.data.labels.push(now);
            performanceChart.data.datasets[0].data.push(data.metrics.signalsDetected);
            performanceChart.data.datasets[1].data.push(data.metrics.cpuUsage);

            // Keep only last 20 data points
            if (performanceChart.data.labels.length > 20) {
                performanceChart.data.labels.shift();
                performanceChart.data.datasets[0].data.shift();
                performanceChart.data.datasets[1].data.shift();
            }

            performanceChart.update();
        }

        function showConfigModal() {
            alert('Configuration modal would open here. In a full implementation, this would show a form to update bot settings.');
        }

        // Initialize
        initChart();
        
        // Request initial data
        socket.emit('get_dashboard_data');
    </script>
</body>
</html>`;
  }
}

// Export singleton instance
export const webDashboard = new WebDashboard({
  port: parseInt(process.env.DASHBOARD_PORT || '3001'),
  enableAuth: process.env.DASHBOARD_AUTH === 'true',
  authToken: process.env.DASHBOARD_AUTH_TOKEN || 'dashboard-secret',
  corsOrigins: ['http://localhost:3000', 'http://localhost:3001']
});