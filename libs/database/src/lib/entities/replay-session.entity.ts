import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export const REPLAY_STATUSES = ['PLAYING', 'PAUSED', 'ENDED'] as const;
export type ReplayStatus = (typeof REPLAY_STATUSES)[number];

// Why a PAUSED session is paused (migration ReplayPauseReason); null while PLAYING
export const REPLAY_PAUSE_REASONS = ['USER', 'OTHER_TAB', 'DISCONNECT', 'SERVER_RESTART', 'END_OF_DATA'] as const;
export type ReplayPauseReason = (typeof REPLAY_PAUSE_REASONS)[number];

// One bar replay over the imported history (migration ReplayTables). A user may keep
// several sessions; at most one per user is PLAYING (migration ReplaySessionsList).
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

  @Column({ name: 'pause_reason', type: 'varchar', length: 14, nullable: true })
  pauseReason!: ReplayPauseReason | null;

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

  // 1-60 characters; the auto name when the user gave none (migration ReplaySessionsList).
  // Null only for a row the previous release created.
  @Column({ type: 'varchar', length: 60, nullable: true })
  title!: string | null;

  // When the user last opened it: the list's order, and the user's current session
  @Column({ name: 'last_opened_at', type: 'timestamptz', default: () => 'now()' })
  lastOpenedAt!: Date;
}
