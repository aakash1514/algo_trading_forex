import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export const REPLAY_STATUSES = ['PLAYING', 'PAUSED', 'ENDED'] as const;
export type ReplayStatus = (typeof REPLAY_STATUSES)[number];

// One bar replay over the imported history (migration ReplayTables). At most one
// session per user is not ENDED.
@Entity('replay_sessions')
export class ReplaySessionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  // DB format, 'EUR/USD'
  @Column({ type: 'varchar', length: 7 })
  pair!: string;

  @Column({ name: 'start_time', type: 'timestamptz' })
  startTime!: Date;

  // The last processed M1 minute: nothing after it is ever sent
  @Column({ name: 'clock_time', type: 'timestamptz' })
  clockTime!: Date;

  @Column({ type: 'varchar', length: 7, default: 'PAUSED' })
  status!: ReplayStatus;

  @Column({ name: 'speed_ms', type: 'integer', default: 1000 })
  speedMs!: number;

  @Column({ type: 'varchar', length: 3 })
  timeframe!: string;

  // USD
  @Column({ name: 'starting_balance', type: 'decimal', precision: 14, scale: 2 })
  startingBalance!: string;

  // USD: starting balance + realized P&L; equity is derived on read
  @Column({ type: 'decimal', precision: 14, scale: 2 })
  balance!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'ended_at', type: 'timestamptz', nullable: true })
  endedAt!: Date | null;
}
