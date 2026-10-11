import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { UserEntity } from './user.entity';

@Entity('backtest_runs')
export class BacktestRunEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id' })
  userId!: string;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'user_id' })
  user!: UserEntity;

  @Column({ name: 'strategy_name', length: 100 })
  strategyName!: string;

  @Column({ length: 10 })
  instrument!: string;

  @Column({ length: 5 })
  timeframe!: string;

  @Column({ name: 'from_date', type: 'timestamptz' })
  fromDate!: Date;

  @Column({ name: 'to_date', type: 'timestamptz' })
  toDate!: Date;

  @Column({ type: 'jsonb', default: '{}' })
  parameters!: Record<string, number>;

  // Starting equity in USD
  @Column({ name: 'initial_capital', type: 'decimal', precision: 14, scale: 2 })
  initialCapital!: string;

  // Position size per trade; units = lots x instruments.lot_size
  @Column({ type: 'decimal', precision: 8, scale: 2 })
  lots!: string;

  @Column({ length: 20, default: 'QUEUED' })
  status!: string;

  @Column({ type: 'integer', default: 0 })
  progress!: number;

  @Column({ name: 'total_trades', type: 'integer', nullable: true })
  totalTrades!: number | null;

  @Column({ name: 'win_rate', type: 'decimal', precision: 5, scale: 2, nullable: true })
  winRate!: number | null;

  @Column({ name: 'profit_factor', type: 'decimal', precision: 8, scale: 4, nullable: true })
  profitFactor!: number | null;

  // From the daily USD equity series (null when it can't be computed)
  @Column({ name: 'sharpe_ratio', type: 'decimal', precision: 8, scale: 4, nullable: true })
  sharpeRatio!: number | null;

  // % of peak USD equity, marked to market at every bar close
  @Column({ name: 'max_drawdown_pct', type: 'decimal', precision: 8, scale: 4, nullable: true })
  maxDrawdownPct!: number | null;

  // Net P&L in pips
  @Column({ name: 'total_pnl', type: 'decimal', precision: 12, scale: 2, nullable: true })
  totalPnl!: number | null;

  // Net P&L in USD; final equity = initialCapital + totalPnlUsd (derived, not stored)
  @Column({ name: 'total_pnl_usd', type: 'decimal', precision: 14, scale: 2, nullable: true })
  totalPnlUsd!: string | null;

  @Column({ name: 'minio_object_key', type: 'text', nullable: true })
  minioObjectKey!: string | null;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage!: string | null;

  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt!: Date | null;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}