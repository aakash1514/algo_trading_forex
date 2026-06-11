import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Worker, Job } from 'bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Client as MinioClient } from 'minio';
import { BacktestRunEntity } from '@forexedge/database';
import { AppGateway } from '../gateway/app.gateway';
import { StrategyRegistry } from './strategies/strategy.registry';
import { TradeSimulator } from './trade.simulator';
import { MetricsCalculator } from './metrics.calculator';
import { Candle } from './strategies/strategy.interface';

export interface BacktestJobData {
  runId: string;
  userId: string;
  instrument: string;
  timeframe: string;
  fromDate: string;
  toDate: string;
  strategyName: string;
  parameters: Record<string, number>;
}

const TIMEFRAME_VIEW_MAP: Record<string, string> = {
  '1m':  'candles_1m',
  '5m':  'candles_5m',
  '15m': 'candles_15m',
  '1h':  'candles_1h',
  '4h':  'candles_4h',
  '1d':  'candles_1d',
};

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

      // 2. Fetch candles from TimescaleDB
      const viewName = TIMEFRAME_VIEW_MAP[timeframe];
      const rows = await this.dataSource.query(
        `SELECT bucket, open, high, low, close, tick_count
         FROM ${viewName}
         WHERE instrument = $1 AND bucket BETWEEN $2 AND $3
         ORDER BY bucket ASC`,
        [instrument, fromDate, toDate],
      );

      if (rows.length === 0) {
        await this.repo.update(runId, {
          status: 'FAILED',
          errorMessage: `No candle data found for ${instrument} ${timeframe} between ${fromDate} and ${toDate}`,
          completedAt: new Date(),
        });
        this.emitProgress(userId, runId, 0, 'Failed — no candle data found');
        return;
      }

      const candles: Candle[] = rows.map((r: Record<string, unknown>) => ({
        bucket: new Date(r['bucket'] as string),
        open: parseFloat(r['open'] as string),
        high: parseFloat(r['high'] as string),
        low: parseFloat(r['low'] as string),
        close: parseFloat(r['close'] as string),
        tick_count: Number(r['tick_count']),
      }));

      this.logger.log(`Fetched ${candles.length} candles for ${instrument} ${timeframe}`);
      await this.repo.update(runId, { progress: 20 });
      this.emitProgress(userId, runId, 20, `Loaded ${candles.length} candles — running strategy...`);

      // 3. Run strategy — no lookahead bias enforced by TradeSimulator
      const strategy = this.strategyRegistry.get(strategyName);
      const signals = strategy.generate(candles, parameters);
      this.logger.log(`Strategy generated ${signals.length} signals`);

      await this.repo.update(runId, { progress: 50 });
      this.emitProgress(userId, runId, 50, `${signals.length} signals generated — simulating trades...`);

      // 4. Simulate trades
      const simulator = new TradeSimulator();
      const trades = simulator.simulate(candles, signals, instrument);
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

  // ── Startup check — fail fast if views are missing ──
  private async verifyViews(): Promise<void> {
    const rows = await this.dataSource.query(
      `SELECT view_name FROM timescaledb_information.continuous_aggregates
       WHERE view_name LIKE 'candles_%'`,
    );
    const found = rows.map((r: Record<string, string>) => r['view_name']);
    const expected = Object.values(TIMEFRAME_VIEW_MAP);
    for (const view of expected) {
      if (!found.includes(view)) {
        throw new Error(
          `Required TimescaleDB view '${view}' not found. Run Phase 2 migrations.`,
        );
      }
    }
    this.logger.log('TimescaleDB candle views verified');
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