import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum ForexSession {
  TOKYO = 'TOKYO',
  LONDON = 'LONDON',
  NEW_YORK = 'NEW_YORK',
  SYDNEY = 'SYDNEY',
}

export enum InstrumentType {
  MAJOR = 'MAJOR',
  MINOR = 'MINOR',
  EXOTIC = 'EXOTIC',
}

@Entity('instruments')
export class InstrumentEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ unique: true, length: 7 })
  pair!: string;              

  @Column({ name: 'base_currency', length: 3 })
  baseCurrency!: string;      

  @Column({ name: 'quote_currency', length: 3 })
  quoteCurrency!: string;     

  @Column({
    type: 'enum',
    enum: InstrumentType,
    default: InstrumentType.MAJOR,
  })
  type!: InstrumentType;

  @Column({
    name: 'pip_size',
    type: 'decimal',
    precision: 10,
    scale: 6,
  })
  pipSize!: number;            // 0.0001 for most pairs, 0.01 for JPY pairs

  @Column({
    name: 'lot_size',
    type: 'integer',
    default: 100000,
  })
  lotSize!: number;            // standard lot = 100,000 units

  @Column({
    name: 'min_lot',
    type: 'decimal',
    precision: 6,
    scale: 2,
    default: 0.01,
  })
  minLot!: number;

  @Column({
    name: 'max_lot',
    type: 'decimal',
    precision: 6,
    scale: 2,
    default: 100,
  })
  maxLot!: number;

  @Column({
    name: 'avg_spread',
    type: 'decimal',
    precision: 8,
    scale: 5,
    nullable: true,
  })
  avgSpread!: number;

  // Which sessions this pair is most active in
  @Column({
    name: 'active_sessions',
    type: 'simple-array',
    nullable: true,
  })
  activeSessions!: ForexSession[];

  @Column({ name: 'is_active', default: true })
  isActive!: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}