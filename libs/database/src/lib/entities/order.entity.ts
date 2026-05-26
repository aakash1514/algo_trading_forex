import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn
} from 'typeorm';
import { UserEntity } from './user.entity';

export type OrderStatus =
  | 'DRAFT' | 'PENDING' | 'SUBMITTED' | 'OPEN'
  | 'CLOSED' | 'REJECTED' | 'CANCELLED';

export type OrderDirection = 'LONG' | 'SHORT';
export type OrderType = 'MARKET' | 'LIMIT' | 'STOP' | 'TRAILING_STOP' | 'OCO';

@Entity('orders')
export class OrderEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'idempotency_key', unique: true })
  idempotencyKey!: string;

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
  direction!: OrderDirection;

  @Column({ name: 'order_type', type: 'varchar' })
  orderType!: OrderType;

  @Column({ type: 'decimal', precision: 8, scale: 2 })
  lots!: number;

  @Column({ name: 'requested_price', type: 'decimal', precision: 18, scale: 6, nullable: true })
  requestedPrice!: number | null;

  @Column({ name: 'executed_price', type: 'decimal', precision: 18, scale: 6, nullable: true })
  executedPrice!: number | null;

  @Column({ name: 'stop_loss', type: 'decimal', precision: 18, scale: 6, nullable: true })
  stopLoss!: number | null;

  @Column({ name: 'take_profit', type: 'decimal', precision: 18, scale: 6, nullable: true })
  takeProfit!: number | null;

  @Column({ type: 'varchar', default: 'DRAFT' })
  status!: OrderStatus;

  @Column({ name: 'session_opened',type: 'varchar', nullable: true })
  sessionOpened!: string | null;

  @Column({ name: 'pip_value', type: 'decimal', precision: 10, scale: 4, nullable: true })
  pipValue!: number | null;

  @Column({ name: 'margin_used', type: 'decimal', precision: 12, scale: 2, nullable: true })
  marginUsed!: number | null;

  @Column({ name: 'rejection_reason', type: 'text', nullable: true })
  rejectionReason!: string | null;

  @Column({ name: 'submitted_at', type: 'timestamptz', nullable: true })
  submittedAt!: Date | null;

  @Column({ name: 'opened_at', type: 'timestamptz', nullable: true })
  openedAt!: Date | null;

  @Column({ name: 'closed_at', type: 'timestamptz', nullable: true })
  closedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}