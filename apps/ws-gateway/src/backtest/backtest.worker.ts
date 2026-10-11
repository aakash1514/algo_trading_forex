import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Worker, Job } from 'bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Client as MinioClient } from 'minio';
import {
  BacktestRunEntity, HISTORICAL_SOURCES, HistoricalTimeframe, pointsToPrice, readHistoricalBars, requireHistoricalCoverage,
} from '@forexedge/database';
import { AppGateway } from '../gateway/app.gateway';
import { StrategyRegistry } from './strategies/strategy.registry';
import { TradeSimulator } from './trade.simulator';
import { MetricsCalculator } from './metrics.calculator';
import { Candle, StrategyContext } from './strategies/strategy.interface';
import { backtestWindow } from './backtest-window';

export interface BacktestJobData {
  runId: string;
  userId: string;
  instrument: string;
  timeframe: string;
  fromDate: string; // YYYY-MM-DD, inclusive
  toDate: string;   // YYYY-MM-DD, inclusive
  strategyName: string;
  parameters: Record<string, number>; // strategy parameters (lots included for the strategies)
  lots: number;
  initialCapital: number; // USD
}

const MINIO_BUCKET = 'backtests';

@Injectable()
export class BacktestWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BacktestWorker.name);
  private worker!: Worker;
  private readonly minioClient: MinioClient;

  constructor(
    @InjectRepository(BacktestRunEntity)
    private readonly repo: Repository<BacktestRunEntity>,
    private readonly dataSource: DataSource,
    private readonly gateway: AppGateway,
    private readonly strategyRegistry: StrategyRegistry,
  ) {
    this.minioClient = new MinioClient({
      endPoint: process.env.MINIO_ENDPOINT ?? 'localhost',
      port: Number(process.env.MINIO_PORT ?? 9000),
      useSSL: process.env.MINIO_USE_SSL === 'true', // was hardcoded false
      accessKey: process.env.MINIO_USER ?? 'minio_admin',
      secretKey: process.env.MINIO_PASS ?? 'minio_secret123',
    });
  }

  async onModuleInit() {
    // ── Verify TimescaleDB views exist before accepting jobs ──
    await this.verifyViews();

    // ── Ensure MinIO bucket exists ──
    await this.ensureBucket();

    // ── Start BullMQ worker ──
    this.worker = new Worker(
      'backtest',
      async (job: Job<BacktestJobData>) => {
        await this.processBacktest(job);
      },
      {
        connection: {
          host: process.env.REDIS_HOST ?? 'localhost',
          port: Number(process.env.REDIS_PORT ?? 6379),
          password: process.env.REDIS_PASS ?? undefined,
          tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
          username: process.env.REDIS_USERNAME ?? 'default',
        },
        concurrency: 1, // conservative for dev — increase to 2 in production
      },
    );

    this.worker.on('completed', (job) => {
      this.logger.log(`Backtest job ${job.id} completed`);
    });

    this.worker.on('failed', (job, err) => {
      this.logger.error(`Backtest job ${job?.id} failed: ${err.message}`);
    });

    this.logger.log('BacktestWorker started');
  }

  async onModuleDestroy() {
    await this.worker?.close();
  }

  // ── Core job processor ──
  private async processBacktest(job: Job<BacktestJobData>): Promise<void> {
    const { runId, userId, instrument, timeframe, fromDate, toDate, strategyName, parameters } =
      job.data;

    try {
      // 1. Mark RUNNING
      await this.repo.update(runId, { status: 'RUNNING', startedAt: new Date(), progress: 5 });
      this.emitProgress(userId, runId, 5, 'Fetching candle data...');

      // 2. Load the bars: always the imported history (never the live candles), bid
      //    and ask in integer points; contract specs from the DB. The live
      //    market-hours clock is not applied: the history is the truth.
      const pair = instrument.replace('_', '/');
      //    The window holds whole bars only, From and To days inclusive (UTC).
      const window = backtestWindow(fromDate, toDate, timeframe as HistoricalTimeframe);
      const coverage = await requireHistoricalCoverage(this.dataSource, pair, window.from, window.lastBucket);
      const context: StrategyContext = { pipSize: await this.pipSize(pair), priceDecimals: coverage.priceDecimals };
      const bars = await readHistoricalBars(this.dataSource, {
        pair, timeframe: timeframe as HistoricalTimeframe, from: window.from, to: window.lastBucket,
      });

      if (bars.length === 0) {
        await this.repo.update(runId, {
          status: 'FAILED',
          errorMessage: `No candle data found for ${instrument} ${timeframe} between ${fromDate} and ${toDate}`,
          completedAt: new Date(),
        });
        this.emitProgress(userId, runId, 0, 'Failed — no candle data found');
        return;
      }

      const price = (points: number) => pointsToPrice(points, coverage.priceDecimals);
      const candles: Candle[] = bars.map((b) => ({
        bucket: b.bucket,
        open: price((b.bidOpen + b.askOpen) / 2),
        high: price((b.bidHigh + b.askHigh) / 2),
        low: price((b.bidLow + b.askLow) / 2),
        close: price((b.bidClose + b.askClose) / 2),
        bid: { open: b.bidOpen, high: b.bidHigh, low: b.bidLow, close: b.bidClose },
        ask: { open: b.askOpen, high: b.askHigh, low: b.askLow, close: b.askClose },
        minutes: b.minutes,
      }));

      this.logger.log(`Fetched ${candles.length} candles for ${instrument} ${timeframe}`);
      await this.repo.update(runId, { progress: 20 });
      this.emitProgress(userId, runId, 20, `Loaded ${candles.length} candles — running strategy...`);

      // 3. Run strategy — no lookahead bias enforced by TradeSimulator
      const strategy = this.strategyRegistry.get(strategyName);
      const signals = strategy.generate(candles, parameters, context);
      this.logger.log(`Strategy generated ${signals.length} signals`);

      await this.repo.update(runId, { progress: 50 });
      this.emitProgress(userId, runId, 50, `${signals.length} signals generated — simulating trades...`);

      // 4. Simulate trades
      const simulator = new TradeSimulator(context);
      const trades = simulator.simulate(candles, signals);
      this.logger.log(`Simulated ${trades.length} trades`);

      await this.repo.update(runId, { progress: 70 });
      this.emitProgress(userId, runId, 70, `${trades.length} trades simulated — calculating metrics...`);

      // 5. Calculate metrics
      const equityCurve = MetricsCalculator.buildEquityCurve(trades);
      const metrics = {
        totalTrades: trades.length,
        winRate: MetricsCalculator.calculateWinRate(trades),
        profitFactor: MetricsCalculator.calculateProfitFactor(trades),
        sharpeRatio: MetricsCalculator.calculateSharpeRatio(trades),
        maxDrawdownPct: MetricsCalculator.calculateMaxDrawdown(equityCurve),
        totalPnl: parseFloat(trades.reduce((sum, t) => sum + t.netPnl, 0).toFixed(2)),
      };

      await this.repo.update(runId, { progress: 85 });
      this.emitProgress(userId, runId, 85, 'Saving results...');

      // 6. Save full results to MinIO
      const objectKey = `${runId}/results.json`;
      const resultsJson = JSON.stringify({ trades, equityCurve, metrics }, null, 2);
      await this.minioClient.putObject(
        MINIO_BUCKET,
        objectKey,
        resultsJson,
        resultsJson.length,
        { 'Content-Type': 'application/json' },
      );

      // 7. Mark COMPLETED
      await this.repo.update(runId, {
        status: 'COMPLETED',
        completedAt: new Date(),
        progress: 100,
        minioObjectKey: objectKey,
        ...metrics,
      });

      this.emitProgress(userId, runId, 100, 'Backtest complete');
      this.logger.log(`Backtest ${runId} completed — ${trades.length} trades, PnL: ${metrics.totalPnl} pips`);

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Backtest ${runId} failed: ${message}`);
      await this.repo.update(runId, {
        status: 'FAILED',
        errorMessage: message,
        completedAt: new Date(),
      });
      this.emitProgress(userId, runId, 0, `Failed: ${message}`);
      throw err; // rethrow so BullMQ marks job as failed and triggers retry
    }
  }

  private emitProgress(userId: string, runId: string, progress: number, message: string) {
    this.gateway.emitToUser(userId, 'backtest:progress', { runId, progress, message });
  }

  // instruments.pip_size is the source of truth (0.01 for JPY pairs and gold)
  private async pipSize(pair: string): Promise<number> {
    const rows = await this.dataSource.query('SELECT pip_size FROM instruments WHERE pair = $1', [pair]);
    if (rows.length === 0) throw new Error(`No instruments row for ${pair}`);
    return Number(rows[0].pip_size);
  }

  // ── Startup check — fail fast if the historical tables are missing ──
  private async verifyViews(): Promise<void> {
    const rows = await this.dataSource.query(
      `SELECT view_name AS name FROM timescaledb_information.continuous_aggregates WHERE view_name LIKE 'historical\\_candles\\_%'
       UNION ALL
       SELECT hypertable_name FROM timescaledb_information.hypertables WHERE hypertable_name = 'historical_candles'`,
    );
    const found = rows.map((r: Record<string, string>) => r['name']);
    for (const { table } of Object.values(HISTORICAL_SOURCES)) {
      if (!found.includes(table)) {
        throw new Error(`Required historical table '${table}' not found. Run the migrations and npm run data:import.`);
      }
    }
    this.logger.log('Historical candle tables verified');
  }

  // ── Ensure MinIO bucket exists ──
  private async ensureBucket(): Promise<void> {
    const exists = await this.minioClient.bucketExists(MINIO_BUCKET);
    if (!exists) {
      await this.minioClient.makeBucket(MINIO_BUCKET);
      this.logger.log(`MinIO bucket '${MINIO_BUCKET}' created`);
    } else {
      this.logger.log(`MinIO bucket '${MINIO_BUCKET}' ready`);
    }
  }
}