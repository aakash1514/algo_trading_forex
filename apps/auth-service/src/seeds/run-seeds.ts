import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { seedInstruments } from './instruments.seed';

dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

const dataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '15432'),
  username: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  entities: [
    path.resolve(__dirname, '../../../../libs/database/src/**/*.entity.ts'),
  ],
  synchronize: false,
});

const runSeeds = async () => {
  try {
    await dataSource.initialize();
    console.log('📦 Database connected. Running seeds...');
    await seedInstruments(dataSource);
    await dataSource.destroy();
    console.log('✅ All seeds completed.');
  } catch (err) {
    console.error('❌ Seed failed:', err);
    process.exit(1);
  }
};

runSeeds();