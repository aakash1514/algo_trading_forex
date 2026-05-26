import { Entity, PrimaryGeneratedColumn, Column, UpdateDateColumn } from 'typeorm';

@Entity('swap_rates')
export class SwapRateEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 7 })
  pair!: string;

  @Column({ type: 'varchar', length: 10, unique: true })
  instrument!: string;

  @Column({ type: 'decimal', precision: 10, scale: 5 })
  longRate!: number;

  @Column({ type: 'decimal', precision: 10, scale: 5 })
  shortRate!: number;

  @Column({ type: 'varchar', length: 10, default: 'WEDNESDAY' })
  tripleDay!: string;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}