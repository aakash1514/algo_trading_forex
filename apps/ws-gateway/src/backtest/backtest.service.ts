import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Inject,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Queue, Job } from 'bullmq';
import { assertUserId } from '@forexedge/common';
import {
  BacktestRunEntity, HistoricalDataError, HistoricalTimeframe, requireHistoricalCoverage,
} from '@forexedge/database';
import { BacktestWindow, backtestWindow, parseDay } from './backtest-window';
import { BACKTEST_QUEUE } from './backtest-queue.module';
import { BacktestJobData } from './backtest.worker';
import { SubmitBacktestDto } from './dto/submit-backtest.dto';
import { BACKTEST_RESULT_STORE, BacktestResultStore } from './result-store';

const MAX_M1_DAYS = 366;
export const DEFAULT_LOTS = 0.1;
export const DEFAULT_INITIAL_CAPITAL = 10_000;

@Injectable()
export class BacktestService {
  constructor(
    @InjectRepository(BacktestRunEntity)
    private readonly repo: Repository<BacktestRunEntity>,
    @Inject(BACKTEST_QUEUE)
    private readonly queue: Queue,
    private readonly dataSource: DataSource,
    @Inject(BACKTEST_RESULT_STORE)
    private readonly results: BacktestResultStore,
  ) {}

  // ── Submit backtest job ──
  async submit(userId: string, dto: SubmitBacktestDto): Promise<{ runId: string }> {
    assertUserId(userId);
    // Whole days, both inclusive (UTC): [From 00:00, the day after To 00:00)
    let window: BacktestWindow;
    try {
      window = backtestWindow(dto.fromDate, dto.toDate, dto.timeframe as HistoricalTimeframe);
    } catch (err) {
      if (err instanceof RangeError) throw new BadRequestException(err.message);
      throw err;
    }
    // M1 runs load every minute into memory: at most a year (~375k bars)
    if (dto.timeframe === '1m' && window.days > MAX_M1_DAYS) {
      throw new BadRequestException(`A 1m backtest can cover at most ${MAX_M1_DAYS} days`);
    }
    // Backtests always read the imported history: reject a range it doesn't cover
    try {
      await requireHistoricalCoverage(this.dataSource, dto.instrument.replace('_', '/'), window.from, window.lastBucket);
    } catch (err) {
      if (err instanceof HistoricalDataError) throw new BadRequestException(err.message);
      throw err;
    }

    const lots = dto.lots ?? DEFAULT_LOTS;
    const initialCapital = dto.initialCapital ?? DEFAULT_INITIAL_CAPITAL;

    // Create DB record
    const run = this.repo.create({
      userId,
      strategyName: dto.strategyName,
      instrument: dto.instrument,
      timeframe: dto.timeframe,
      fromDate: window.from,           // the From day, 00:00 UTC
      toDate: parseDay(dto.toDate),    // the To day, 00:00 UTC (inclusive day)
      parameters: dto.parameters ?? {},
      initialCapital: initialCapital.toFixed(2),
      lots: lots.toFixed(2),
      status: 'QUEUED',
      progress: 0,
    });
    await this.repo.save(run);

    // Enqueue BullMQ job
    const jobData: BacktestJobData = {
      runId: run.id,
      userId,
      instrument: dto.instrument,
      timeframe: dto.timeframe,
      fromDate: dto.fromDate,
      toDate: dto.toDate,
      strategyName: dto.strategyName,
      parameters: { ...(dto.parameters ?? {}), lots },
      lots,
      initialCapital,
    };

    await this.queue.add('run-backtest', jobData, { jobId: run.id });

    return { runId: run.id };
  }

  // ── List user's backtest runs ──
  async list(userId: string): Promise<BacktestRunEntity[]> {
    assertUserId(userId);
    return this.repo.find({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: 50,
    });
  }

  // ── Get single run status + summary ──
  // Scoped by owner in the query: another user's run is indistinguishable from
  // a missing one (404, not 403, so run ids can't be probed).
  async findOne(runId: string, userId: string): Promise<BacktestRunEntity> {
    assertUserId(userId);
    const run = await this.repo.findOne({ where: { id: runId, userId } });
    if (!run) throw new NotFoundException('Backtest run not found');
    return run;
  }

  // ── Full results (results.json), read from the store for the run's owner only ──
  async getResults(runId: string, userId: string): Promise<Buffer> {
    const run = await this.findOne(runId, userId);

    if (run.status !== 'COMPLETED') {
      throw new BadRequestException(`Backtest is ${run.status} — results not available yet`);
    }

    if (!run.minioObjectKey) {
      throw new BadRequestException('Results object key missing');
    }

    return this.results.read(run.minioObjectKey);
  }

  // ── Cancel a queued job — three-case handling ──
  async cancel(runId: string, userId: string): Promise<void> {
    const run = await this.findOne(runId, userId);

    if (run.status === 'COMPLETED' || run.status === 'FAILED') {
      throw new BadRequestException(`Cannot cancel — job already ${run.status}`);
    }

    if (run.status === 'RUNNING') {
      throw new ConflictException('Cannot cancel a running job — wait for it to complete');
    }

    // Status is QUEUED — remove from BullMQ
    const job: Job | undefined = await this.queue.getJob(runId);
    if (job) {
      await job.remove();
    }

    await this.repo.update(runId, { status: 'CANCELLED' });
  }
}