import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export const REPLAY_POSITION_STATUSES = ['PENDING', 'OPEN', 'CLOSED', 'CANCELLED'] as const;
export type ReplayPositionStatus = (typeof REPLAY_POSITION_STATUSES)[number];
export type ReplayExitReason = 'SL' | 'TP' | 'MANUAL' | 'SESSION_END';

// A replay market order and the position it becomes (migration ReplayTables).
// Prices are integer points at the pair's historical_price_scale. PENDING until the
// next processed minute fills it at that minute's open; a manual close is pending the
// same way (exit_requested_at).
@Entity('replay_positions')
export class ReplayPositionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'session_id', type: 'uuid' })
  sessionId!: string;

  @Column({ type: 'varchar', length: 4 })
  side!: 'BUY' | 'SELL';

  @Column({ type: 'decimal', precision: 8, scale: 2 })
  lots!: string;

  // lots x instruments.lot_size
  @Column({ type: 'integer' })
  units!: number;

  @Column({ type: 'varchar', length: 9 })
  status!: ReplayPositionStatus;

  // The clock minute the order was placed at
  @Column({ name: 'placed_at', type: 'timestamptz' })
  placedAt!: Date;

  @Column({ name: 'stop_loss_points', type: 'integer', nullable: true })
  stopLossPoints!: number | null;

  @Column({ name: 'take_profit_points', type: 'integer', nullable: true })
  takeProfitPoints!: number | null;

  // USD, reserved at placement
  @Column({ name: 'margin_usd', type: 'decimal', precision: 14, scale: 2 })
  marginUsd!: string;

  @Column({ name: 'entry_time', type: 'timestamptz', nullable: true })
  entryTime!: Date | null;

  @Column({ name: 'entry_points', type: 'integer', nullable: true })
  entryPoints!: number | null;

  @Column({ name: 'exit_requested_at', type: 'timestamptz', nullable: true })
  exitRequestedAt!: Date | null;

  @Column({ name: 'exit_time', type: 'timestamptz', nullable: true })
  exitTime!: Date | null;

  @Column({ name: 'exit_points', type: 'integer', nullable: true })
  exitPoints!: number | null;

  @Column({ name: 'exit_reason', type: 'varchar', length: 11, nullable: true })
  exitReason!: ReplayExitReason | null;

  // Net USD (round-trip commission deducted)
  @Column({ name: 'realized_pnl_usd', type: 'decimal', precision: 14, scale: 2, nullable: true })
  realizedPnlUsd!: string | null;

  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true })
  cancelledAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
