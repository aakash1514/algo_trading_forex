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

  // Calendar the event comes from (FOMC, ECB, or the third-party export)
  @Column({ type: 'varchar', length: 20 })
  source!: string;

  // Where scheduledAt's time comes from: 'official' (published by the source), 'expected' (FOMC: the
  // source publishes no release time; the time its recent statements used) or 'third_party' (a third-party
  // calendar export publishes it with its UTC offset)
  @Column({ name: 'time_source', type: 'varchar', length: 11 })
  timeSource!: 'official' | 'expected' | 'third_party';

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}