import {
  Entity, PrimaryGeneratedColumn, Column,
  UpdateDateColumn, OneToOne, JoinColumn
} from 'typeorm';
import { UserEntity } from './user.entity';
import { decimalTransformer } from '../transformers/decimal.transformer';

@Entity('account_summary')
export class AccountSummaryEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', unique: true })
  userId!: string;

  @OneToOne(() => UserEntity)
  @JoinColumn({ name: 'user_id' })
  user!: UserEntity;

  // Only these three are persisted.
  // equity, free_margin, margin_level are computed in AccountService — never stored.
  @Column({ type: 'decimal', transformer: decimalTransformer, precision: 15, scale: 2, default: 10000.00 })
  balance!: number;

  @Column({ name: 'margin_used', type: 'decimal', transformer: decimalTransformer, precision: 15, scale: 2, default: 0 })
  marginUsed!: number;

  // Open (unrealized) P&L is not stored: it is the sum of the user's open
  // positions' unrealized_pnl, computed on read (AccountService), so it can't drift.

  @Column({ type: 'integer', default: 100 })
  leverage!: number;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}