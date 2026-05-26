import {
  Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn
} from 'typeorm';
import { OrderEntity } from './order.entity';
import { UserEntity } from './user.entity';

export type CloseReason = 'MANUAL' | 'STOP_LOSS' | 'TAKE_PROFIT' | 'MARGIN_CALL';

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

  @Column({ type: 'decimal', precision: 8, scale: 2 })
  lots!: number;

  @Column({ name: 'open_price', type: 'decimal', precision: 18, scale: 6 })
  openPrice!: number;

  @Column({ name: 'current_price', type: 'decimal', precision: 18, scale: 6, nullable: true })
  currentPrice!: number | null;

  @Column({ name: 'pip_pnl', type: 'decimal', precision: 10, scale: 2, default: 0 })
  pipPnl!: number;

  @Column({ name: 'unrealized_pnl', type: 'decimal', precision: 12, scale: 2, default: 0 })
  unrealizedPnl!: number;

  @Column({ name: 'realized_pnl', type: 'decimal', precision: 12, scale: 2, nullable: true })
  realizedPnl!: number | null;

  @Column({ name: 'swap_accrued', type: 'decimal', precision: 10, scale: 4, default: 0 })
  swapAccrued!: number;

  @Column({ name: 'pip_value', type: 'decimal', precision: 10, scale: 4 })
  pipValue!: number;

  @Column({ name: 'margin_used', type: 'decimal', precision: 12, scale: 2 })
  marginUsed!: number;

  @Column({ name: 'stop_loss', type: 'decimal', precision: 18, scale: 6, nullable: true })
  stopLoss!: number | null;

  @Column({ name: 'take_profit', type: 'decimal', precision: 18, scale: 6, nullable: true })
  takeProfit!: number | null;

  @Column({ name: 'is_open', default: true })
  isOpen!: boolean;

  @Column({ name: 'opened_at', type: 'timestamptz', default: () => 'now()' })
  openedAt!: Date;

  @Column({ name: 'closed_at', type: 'timestamptz', nullable: true })
  closedAt!: Date | null;

  @Column({ name: 'close_reason', type: 'varchar', nullable: true })
  closeReason!: CloseReason | null;
}