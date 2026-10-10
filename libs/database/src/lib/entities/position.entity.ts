import {
  Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn
} from 'typeorm';
import { OrderEntity } from './order.entity';
import { UserEntity } from './user.entity';
import { decimalTransformer } from '../transformers/decimal.transformer';

// MARGIN_CALL is legacy (history only); stop-outs close with STOP_OUT.
export type CloseReason = 'MANUAL' | 'STOP_LOSS' | 'TAKE_PROFIT' | 'MARGIN_CALL' | 'STOP_OUT';
export type ExitTrigger = 'STOP_LOSS' | 'TAKE_PROFIT';

@Entity('positions')
export class PositionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'order_id' })
  orderId!: string;

  @ManyToOne(() => OrderEntity)
  @JoinColumn({ name: 'order_id' })
  order!: OrderEntity;

  @Column({ name: 'user_id' })
  userId!: string;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'user_id' })
  user!: UserEntity;

  @Column()
  instrument!: string;

  @Column()
  pair!: string;

  @Column({ type: 'varchar' })
  direction!: 'LONG' | 'SHORT';

  @Column({ type: 'decimal', transformer: decimalTransformer, precision: 8, scale: 2 })
  lots!: number;

  @Column({ name: 'open_price', type: 'decimal', transformer: decimalTransformer, precision: 18, scale: 6 })
  openPrice!: number;

  @Column({ name: 'current_price', type: 'decimal', transformer: decimalTransformer, precision: 18, scale: 6, nullable: true })
  currentPrice!: number | null;

  @Column({ name: 'pip_pnl', type: 'decimal', transformer: decimalTransformer, precision: 10, scale: 2, default: 0 })
  pipPnl!: number;

  @Column({ name: 'unrealized_pnl', type: 'decimal', transformer: decimalTransformer, precision: 12, scale: 2, default: 0 })
  unrealizedPnl!: number;

  @Column({ name: 'realized_pnl', type: 'decimal', transformer: decimalTransformer, precision: 12, scale: 2, nullable: true })
  realizedPnl!: number | null;

  @Column({ name: 'swap_accrued', type: 'decimal', transformer: decimalTransformer, precision: 10, scale: 4, default: 0 })
  swapAccrued!: number;

  @Column({ name: 'pip_value', type: 'decimal', transformer: decimalTransformer, precision: 10, scale: 4 })
  pipValue!: number;

  @Column({ name: 'margin_used', type: 'decimal', transformer: decimalTransformer, precision: 12, scale: 2 })
  marginUsed!: number;

  @Column({ name: 'stop_loss', type: 'decimal', transformer: decimalTransformer, precision: 18, scale: 6, nullable: true })
  stopLoss!: number | null;

  @Column({ name: 'take_profit', type: 'decimal', transformer: decimalTransformer, precision: 18, scale: 6, nullable: true })
  takeProfit!: number | null;

  @Column({ name: 'is_open', default: true })
  isOpen!: boolean;

  @Column({ name: 'opened_at', type: 'timestamptz', default: () => 'now()' })
  openedAt!: Date;

  @Column({ name: 'closed_at', type: 'timestamptz', nullable: true })
  closedAt!: Date | null;

  @Column({ name: 'close_reason', type: 'varchar', nullable: true })
  closeReason!: CloseReason | null;

  // A triggered stop-loss/take-profit not booked yet (e.g. no USD conversion
  // rate for a cross pair). Committed when the trigger is detected and retried
  // from here, so a restart can't lose it. Books at pending_exit_price, the
  // triggering tick's price (not the SL/TP level).
  @Column({ name: 'pending_exit_price', type: 'decimal', transformer: decimalTransformer, precision: 18, scale: 6, nullable: true })
  pendingExitPrice!: number | null;

  @Column({ name: 'pending_exit_reason', type: 'varchar', nullable: true })
  pendingExitReason!: ExitTrigger | null;

  @Column({ name: 'exit_triggered_at', type: 'timestamptz', nullable: true })
  exitTriggeredAt!: Date | null;
}