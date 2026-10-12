import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('economic_events')
export class EconomicEventEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 200 })
  title!: string;

  @Column({ type: 'char', length: 3 })
  currency!: string;

  @Column({ type: 'varchar', length: 10 })
  impact!: string;

  @Column({ name: 'scheduled_at', type: 'timestamptz' })
  scheduledAt!: Date;

  @Column({ type: 'varchar', length: 50, nullable: true })
  forecast!: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  previous!: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  actual!: string | null;

  // Official calendar the event comes from (FOMC, ECB); null only for rows from before step 6a
  @Column({ type: 'varchar', length: 20, nullable: true })
  source!: string | null;

  // The source gives a date without a time: scheduledAt is 00:00 UTC of that date
  @Column({ name: 'all_day', type: 'boolean', default: false })
  allDay!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}