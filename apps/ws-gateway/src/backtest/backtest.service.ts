import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  Inject,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Queue, Job } from 'bullmq';
import { Client as MinioClient } from 'minio';
import { BacktestRunEntity } from '@forexedge/database';
import { BACKTEST_QUEUE } from './backtest-queue.module';
import { BacktestJobData } from './backtest.worker';
import { SubmitBacktestDto } from './dto/submit-backtest.dto';

@Injectable()
export class BacktestService {
  private readonly minioClient: MinioClient;

  constructor(
    @InjectRepository(BacktestRunEntity)
    private readonly repo: Repository<BacktestRunEntity>,
    @Inject(BACKTEST_QUEUE)
    private readonly queue: Queue,
  ) {
    this.minioClient = new MinioClient({
      endPoint: process.env.MINIO_ENDPOINT ?? 'localhost',
      port: Number(process.env.MINIO_PORT ?? 9000),
      useSSL: false,
      accessKey: process.env.MINIO_USER ?? 'minio_admin',
      secretKey: process.env.MINIO_PASS ?? 'minio_secret123',
    });
  }

  // ── Submit backtest job ──
  async submit(userId: string, dto: SubmitBacktestDto): Promise<{ runId: string }> {
    // Validate date range
    const from = new Date(dto.fromDate);
    const to = new Date(dto.toDate);
    if (from >= to) {
      throw new BadRequestException('fromDate must be before toDate');
    }

    // Create DB record
    const run = this.repo.create({
      userId,
      strategyName: dto.strategyName,
      instrument: dto.instrument,
      timeframe: dto.timeframe,
      fromDate: from,
      toDate: to,
      parameters: dto.parameters ?? {},
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
      parameters: { ...(dto.parameters ?? {}), lots: dto.lots ?? 0.1 },
    };

    await this.queue.add('run-backtest', jobData, { jobId: run.id });

    return { runId: run.id };
  }

  // ── List user's backtest runs ──
  async list(userId: string): Promise<BacktestRunEntity[]> {
    return this.repo.find({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: 50,
    });
  }

  // ── Get single run status + summary ──
  async findOne(runId: string, userId: string): Promise<BacktestRunEntity> {
    const run = await this.repo.findOne({ where: { id: runId } });
    if (!run) throw new NotFoundException('Backtest run not found');
    if (run.userId !== userId) throw new ForbiddenException();
    return run;
  }

  // ── Get presigned URL for full results — regenerated fresh every call ──
  async getResultsUrl(runId: string, userId: string): Promise<string> {
    const run = await this.findOne(runId, userId);

    if (run.status !== 'COMPLETED') {
      throw new BadRequestException(`Backtest is ${run.status} — results not available yet`);
    }

    if (!run.minioObjectKey) {
      throw new BadRequestException('Results object key missing');
    }

    // 7-day TTL — regenerated on every call so URL never goes stale
    return this.minioClient.presignedGetObject(
      'backtests',
      run.minioObjectKey,
      7 * 24 * 60 * 60,
    );
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