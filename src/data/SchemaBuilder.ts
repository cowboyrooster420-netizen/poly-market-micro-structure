import { SQLDialect } from './DatabaseDialect';

export class SchemaBuilder {
  private dialect: SQLDialect;

  constructor(dialect: SQLDialect) {
    this.dialect = dialect;
  }

  buildSchema(): string {
    const d = this.dialect;

    return `
      -- Markets table
      CREATE TABLE IF NOT EXISTS markets (
        id ${d.varchar(100)} PRIMARY KEY,
        condition_id ${d.varchar(100)},
        question ${d.text()} NOT NULL,
        description ${d.text()},
        outcomes ${d.jsonType()},
        volume ${d.decimal()},
        active ${d.boolean()} DEFAULT ${this.boolValue(true)},
        closed ${d.boolean()} DEFAULT ${this.boolValue(false)},
        end_date ${d.timestamp()},
        created_at ${d.timestamp()} DEFAULT ${d.currentTimestamp()},
        updated_at ${d.timestamp()} DEFAULT ${d.currentTimestamp()},
        metadata ${d.jsonType()},

        -- Category detection fields
        category ${d.varchar(50)},
        category_score ${d.decimal()},
        is_blacklisted ${d.boolean()} DEFAULT ${this.boolValue(false)},
        outcome_count ${d.integer()},
        spread ${d.decimal()},

        -- Two-tier monitoring system
        tier ${d.varchar(20)},
        tier_reason ${d.text()},
        tier_priority ${d.integer()},
        tier_updated_at ${d.timestamp()},

        -- Opportunity scoring
        opportunity_score ${d.decimal()},
        volume_score ${d.decimal()},
        edge_score ${d.decimal()},
        catalyst_score ${d.decimal()},
        quality_score ${d.decimal()},
        score_updated_at ${d.timestamp()}
      );

      -- Historical prices table (time-series)
      CREATE TABLE IF NOT EXISTS market_prices (
        id ${d.serial()} PRIMARY KEY ${d.autoIncrement()},
        market_id ${d.varchar(100)} NOT NULL,
        timestamp ${d.timestamp()} NOT NULL,
        outcome_index ${d.integer()} NOT NULL,
        price ${d.decimal()} NOT NULL,
        volume ${d.decimal()},
        FOREIGN KEY (market_id) REFERENCES markets(id)
      );

      -- Orderbook snapshots
      CREATE TABLE IF NOT EXISTS orderbook_snapshots (
        id ${d.serial()} PRIMARY KEY ${d.autoIncrement()},
        market_id ${d.varchar(100)} NOT NULL,
        timestamp ${d.timestamp()} NOT NULL,
        bids ${d.jsonType()} NOT NULL,
        asks ${d.jsonType()} NOT NULL,
        spread ${d.decimal()},
        mid_price ${d.decimal()},
        best_bid ${d.decimal()},
        best_ask ${d.decimal()},
        FOREIGN KEY (market_id) REFERENCES markets(id)
      );

      -- Trade ticks
      CREATE TABLE IF NOT EXISTS trade_ticks (
        id ${d.serial()} PRIMARY KEY ${d.autoIncrement()},
        market_id ${d.varchar(100)} NOT NULL,
        timestamp ${d.timestamp()} NOT NULL,
        price ${d.decimal()} NOT NULL,
        size ${d.decimal()} NOT NULL,
        side ${d.varchar(4)} NOT NULL CHECK (side IN ('buy', 'sell')),
        FOREIGN KEY (market_id) REFERENCES markets(id)
      );

      -- Signals table
      CREATE TABLE IF NOT EXISTS signals (
        id ${d.serial()} PRIMARY KEY ${d.autoIncrement()},
        market_id ${d.varchar(100)} NOT NULL,
        signal_type ${d.varchar(50)} NOT NULL,
        confidence ${d.decimal()} NOT NULL,
        timestamp ${d.timestamp()} NOT NULL,
        metadata ${d.jsonType()},
        validated ${d.boolean()} DEFAULT ${this.boolValue(false)},
        validation_time ${d.timestamp()},
        outcome ${d.boolean()},
        FOREIGN KEY (market_id) REFERENCES markets(id)
      );

      -- Signal Performance Tracking (P&L and Quality Metrics)
      CREATE TABLE IF NOT EXISTS signal_performance (
        id ${d.uuid()} PRIMARY KEY,
        signal_id ${d.integer()},
        market_id ${d.varchar(100)} NOT NULL,
        signal_type ${d.varchar(50)} NOT NULL,
        confidence ${d.decimal()} NOT NULL,

        -- Entry details
        entry_time ${d.timestamp()} NOT NULL,
        entry_outcome_index ${d.integer()} NOT NULL,
        entry_outcome_name ${d.varchar(100)} NOT NULL,
        entry_price ${d.decimal()} NOT NULL,
        entry_direction ${d.varchar(10)} NOT NULL CHECK (entry_direction IN ('bullish', 'bearish', 'neutral')),

        -- Market state at entry
        market_volume ${d.decimal()},
        market_active ${d.boolean()},

        -- Exit prices at time intervals
        price_30min ${d.decimal()},
        price_1hr ${d.decimal()},
        price_4hr ${d.decimal()},
        price_24hr ${d.decimal()},
        price_7day ${d.decimal()},

        -- P&L calculations (as % return if bought at entry)
        pnl_30min ${d.decimal()},
        pnl_1hr ${d.decimal()},
        pnl_4hr ${d.decimal()},
        pnl_24hr ${d.decimal()},
        pnl_7day ${d.decimal()},

        -- Final resolution (if market closed)
        market_resolved ${d.boolean()} DEFAULT ${this.boolValue(false)},
        resolution_time ${d.timestamp()},
        winning_outcome_index ${d.integer()},
        final_pnl ${d.decimal()},

        -- Signal quality metrics
        was_correct ${d.boolean()},
        magnitude ${d.decimal()},
        max_favorable_move ${d.decimal()},
        max_adverse_move ${d.decimal()},

        -- Additional metadata
        metadata ${d.jsonType()},
        created_at ${d.timestamp()} DEFAULT ${d.currentTimestamp()},
        updated_at ${d.timestamp()} DEFAULT ${d.currentTimestamp()},

        FOREIGN KEY (market_id) REFERENCES markets(id),
        FOREIGN KEY (signal_id) REFERENCES signals(id)
      );

      -- Signal Type Performance Aggregates (Pre-computed stats)
      CREATE TABLE IF NOT EXISTS signal_type_performance (
        signal_type ${d.varchar(50)} PRIMARY KEY,

        -- Volume metrics
        total_signals ${d.integer()} DEFAULT 0,
        signals_last_7d ${d.integer()} DEFAULT 0,
        signals_last_30d ${d.integer()} DEFAULT 0,

        -- Accuracy metrics
        correct_predictions ${d.integer()} DEFAULT 0,
        accuracy ${d.decimal()} DEFAULT 0,
        precision_score ${d.decimal()} DEFAULT 0,
        recall_score ${d.decimal()} DEFAULT 0,
        f1_score ${d.decimal()} DEFAULT 0,

        -- Financial performance
        avg_pnl_30min ${d.decimal()} DEFAULT 0,
        avg_pnl_1hr ${d.decimal()} DEFAULT 0,
        avg_pnl_24hr ${d.decimal()} DEFAULT 0,
        avg_pnl_final ${d.decimal()} DEFAULT 0,

        -- Risk metrics
        sharpe_ratio ${d.decimal()} DEFAULT 0,
        win_rate ${d.decimal()} DEFAULT 0,
        avg_win ${d.decimal()} DEFAULT 0,
        avg_loss ${d.decimal()} DEFAULT 0,
        max_drawdown ${d.decimal()} DEFAULT 0,

        -- Bayesian confidence adjustment
        prior_confidence ${d.decimal()} DEFAULT 0.5,
        posterior_confidence ${d.decimal()} DEFAULT 0.5,

        -- Expected value
        expected_value ${d.decimal()} DEFAULT 0,
        kelly_fraction ${d.decimal()} DEFAULT 0,

        -- Last update
        last_updated ${d.timestamp()} DEFAULT ${d.currentTimestamp()},
        sample_size ${d.integer()} DEFAULT 0
      );

      -- Microstructure metrics
      CREATE TABLE IF NOT EXISTS microstructure_metrics (
        id ${d.serial()} PRIMARY KEY ${d.autoIncrement()},
        market_id ${d.varchar(100)} NOT NULL,
        timestamp ${d.timestamp()} NOT NULL,
        depth_1_bid ${d.decimal()},
        depth_1_ask ${d.decimal()},
        depth_1_total ${d.decimal()},
        micro_price ${d.decimal()},
        micro_price_slope ${d.decimal()},
        micro_price_drift ${d.decimal()},
        orderbook_imbalance ${d.decimal()},
        spread_bps ${d.decimal()},
        liquidity_vacuum ${d.boolean()},
        volume_z_score ${d.decimal()},
        depth_z_score ${d.decimal()},
        spread_z_score ${d.decimal()},
        imbalance_z_score ${d.decimal()},
        FOREIGN KEY (market_id) REFERENCES markets(id)
      );

      -- Front-running scores
      CREATE TABLE IF NOT EXISTS front_running_scores (
        id ${d.serial()} PRIMARY KEY ${d.autoIncrement()},
        market_id ${d.varchar(100)} NOT NULL,
        timestamp ${d.timestamp()} NOT NULL,
        score ${d.decimal()} NOT NULL,
        confidence ${d.decimal()} NOT NULL,
        leak_probability ${d.decimal()} NOT NULL,
        time_to_news ${d.decimal()},
        components ${d.jsonType()},
        metadata ${d.jsonType()},
        FOREIGN KEY (market_id) REFERENCES markets(id)
      );

      -- Backtest results table
      CREATE TABLE IF NOT EXISTS backtest_results (
        id ${d.serial()} PRIMARY KEY ${d.autoIncrement()},
        start_date ${d.timestamp()} NOT NULL,
        end_date ${d.timestamp()} NOT NULL,
        initial_capital ${d.decimal()} NOT NULL,
        total_returns ${d.decimal()} NOT NULL,
        sharpe_ratio ${d.decimal()} NOT NULL,
        max_drawdown ${d.decimal()} NOT NULL,
        win_rate ${d.decimal()} NOT NULL,
        total_trades ${d.integer()} NOT NULL,
        signal_accuracy ${d.decimal()} NOT NULL,
        config ${d.jsonType()} NOT NULL,
        results ${d.jsonType()} NOT NULL,
        created_at ${d.timestamp()} DEFAULT ${d.currentTimestamp()}
      );

      -- Anomaly scores table for advanced statistical analysis
      CREATE TABLE IF NOT EXISTS anomaly_scores (
        id ${d.serial()} PRIMARY KEY ${d.autoIncrement()},
        market_id ${d.varchar(100)} NOT NULL,
        timestamp ${d.timestamp()} NOT NULL,
        volume_anomaly ${d.decimal()} NOT NULL,
        depth_anomaly ${d.decimal()} NOT NULL,
        spread_anomaly ${d.decimal()} NOT NULL,
        imbalance_anomaly ${d.decimal()} NOT NULL,
        price_anomaly ${d.decimal()} NOT NULL,
        mahalanobis_distance ${d.decimal()} NOT NULL,
        isolation_forest_score ${d.decimal()} NOT NULL,
        combined_score ${d.decimal()} NOT NULL,
        is_anomalous ${d.boolean()} NOT NULL,
        anomaly_type ${d.jsonType()} NOT NULL,
        confidence ${d.decimal()} NOT NULL,
        FOREIGN KEY (market_id) REFERENCES markets(id)
      );

      -- Indexes for performance
      -- Market lookup indexes
      CREATE INDEX IF NOT EXISTS idx_markets_active ON markets(active, volume ${this.descKeyword()});
      CREATE INDEX IF NOT EXISTS idx_markets_volume ON markets(volume ${this.descKeyword()});
      CREATE INDEX IF NOT EXISTS idx_markets_closed ON markets(closed);
      CREATE INDEX IF NOT EXISTS idx_markets_category ON markets(category, volume ${this.descKeyword()});
      CREATE INDEX IF NOT EXISTS idx_markets_blacklisted ON markets(is_blacklisted);
      CREATE INDEX IF NOT EXISTS idx_markets_tier ON markets(tier, tier_priority ${this.descKeyword()});
      CREATE INDEX IF NOT EXISTS idx_markets_tier_updated ON markets(tier, tier_updated_at ${this.descKeyword()});
      CREATE INDEX IF NOT EXISTS idx_markets_opportunity_score ON markets(opportunity_score ${this.descKeyword()}, tier);
      CREATE INDEX IF NOT EXISTS idx_markets_score_updated ON markets(score_updated_at ${this.descKeyword()});

      -- Time-series data indexes
      CREATE INDEX IF NOT EXISTS idx_market_prices_market_time ON market_prices(market_id, timestamp ${this.descKeyword()});
      CREATE INDEX IF NOT EXISTS idx_market_prices_time ON market_prices(timestamp ${this.descKeyword()});
      CREATE INDEX IF NOT EXISTS idx_orderbook_market_time ON orderbook_snapshots(market_id, timestamp ${this.descKeyword()});
      CREATE INDEX IF NOT EXISTS idx_orderbook_time ON orderbook_snapshots(timestamp ${this.descKeyword()});
      CREATE INDEX IF NOT EXISTS idx_trade_ticks_market_time ON trade_ticks(market_id, timestamp ${this.descKeyword()});
      CREATE INDEX IF NOT EXISTS idx_trade_ticks_time ON trade_ticks(timestamp ${this.descKeyword()});

      -- Signal indexes
      CREATE INDEX IF NOT EXISTS idx_signals_market_time ON signals(market_id, timestamp ${this.descKeyword()});
      CREATE INDEX IF NOT EXISTS idx_signals_type ON signals(signal_type);
      CREATE INDEX IF NOT EXISTS idx_signals_validated ON signals(validated, timestamp ${this.descKeyword()});
      CREATE INDEX IF NOT EXISTS idx_signals_time ON signals(timestamp ${this.descKeyword()});

      -- Signal performance indexes
      CREATE INDEX IF NOT EXISTS idx_signal_perf_signal_id ON signal_performance(signal_id);
      CREATE INDEX IF NOT EXISTS idx_signal_perf_market_time ON signal_performance(market_id, entry_time ${this.descKeyword()});
      CREATE INDEX IF NOT EXISTS idx_signal_perf_type_time ON signal_performance(signal_type, entry_time ${this.descKeyword()});
      CREATE INDEX IF NOT EXISTS idx_signal_perf_resolved ON signal_performance(market_resolved, entry_time ${this.descKeyword()});
      CREATE INDEX IF NOT EXISTS idx_signal_perf_correct ON signal_performance(was_correct, signal_type);
      CREATE INDEX IF NOT EXISTS idx_signal_perf_entry_time ON signal_performance(entry_time ${this.descKeyword()});

      -- Microstructure and analysis indexes
      CREATE INDEX IF NOT EXISTS idx_microstructure_market_time ON microstructure_metrics(market_id, timestamp ${this.descKeyword()});
      CREATE INDEX IF NOT EXISTS idx_front_running_market_time ON front_running_scores(market_id, timestamp ${this.descKeyword()});
      CREATE INDEX IF NOT EXISTS idx_front_running_score ON front_running_scores(score ${this.descKeyword()}, timestamp ${this.descKeyword()});
      CREATE INDEX IF NOT EXISTS idx_backtest_results_date ON backtest_results(created_at ${this.descKeyword()});
      CREATE INDEX IF NOT EXISTS idx_anomaly_scores_market_time ON anomaly_scores(market_id, timestamp ${this.descKeyword()});
      CREATE INDEX IF NOT EXISTS idx_anomaly_scores_anomalous ON anomaly_scores(is_anomalous, timestamp ${this.descKeyword()});
    `.trim();
  }

  private boolValue(value: boolean): string {
    if (this.dialect.provider === 'sqlite' || this.dialect.provider === 'memory') {
      return value ? '1' : '0';
    }
    return value ? 'true' : 'false';
  }

  private descKeyword(): string {
    return 'DESC';
  }
}
