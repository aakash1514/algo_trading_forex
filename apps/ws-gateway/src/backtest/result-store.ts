import { Client, ClientOptions } from 'minio';
import { requiredInProduction } from '@forexedge/common';
import { Ec2RoleCredentialProvider } from './ec2-role-credentials';

// Where a backtest's full results (results.json: trades, daily equity, metrics) are kept. One
// interface, two backends, both through the minio client (S3-compatible):
//
//   STORAGE=minio  local MinIO (development): MINIO_ENDPOINT, MINIO_PORT, MINIO_USE_SSL, MINIO_USER,
//                  MINIO_PASS; the bucket is created if missing.
//   STORAGE=s3     AWS S3 (production): AWS_REGION and S3_BUCKET only. No keys in the environment:
//                  credentials come from the EC2 instance's IAM role (instance metadata, IMDSv2,
//                  ec2-role-credentials.ts), refreshed before they expire. The bucket must exist (the
//                  role isn't allowed to create one); startup fails if it doesn't.
//
// STORAGE is required when NODE_ENV=production (an unset value would silently pick MinIO); in
// development it defaults to minio. BACKTEST_BUCKET names the MinIO bucket (default backtests).
// The browser never talks to the bucket: ws-gateway reads the object and returns it after the
// owner check, so the bucket stays private and needs no CORS.

export type StorageKind = 'minio' | 's3';

export interface ResultStoreConfig {
  kind: StorageKind;
  bucket: string;
  client: ClientOptions;
}

type Env = Readonly<Record<string, string | undefined>>;

function required(env: Env, name: string, why: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} must be set (${why})`);
  return value;
}

export function resultStoreConfig(env: Env = process.env): ResultStoreConfig {
  const raw = requiredInProduction('STORAGE', env) ?? 'minio';
  if (raw === 's3') {
    const region = required(env, 'AWS_REGION', 'STORAGE=s3');
    return {
      kind: 's3',
      bucket: required(env, 'S3_BUCKET', 'STORAGE=s3'),
      client: {
        endPoint: `s3.${region}.amazonaws.com`,
        useSSL: true,
        region,
        credentialsProvider: new Ec2RoleCredentialProvider(),
      },
    };
  }
  if (raw !== 'minio') throw new Error(`STORAGE must be "minio" or "s3", got "${raw}"`);
  return {
    kind: 'minio',
    bucket: env['BACKTEST_BUCKET']?.trim() || 'backtests',
    client: {
      endPoint: env['MINIO_ENDPOINT']?.trim() || 'localhost',
      port: Number(env['MINIO_PORT'] ?? 9000),
      useSSL: env['MINIO_USE_SSL'] === 'true',
      accessKey: required(env, 'MINIO_USER', 'STORAGE=minio'),
      secretKey: required(env, 'MINIO_PASS', 'STORAGE=minio'),
    },
  };
}

// The client calls this store makes (the minio client's own signatures), so tests can pass a stub
export type StoreClient = Pick<Client, 'bucketExists' | 'makeBucket' | 'putObject' | 'getObject'>;

export class BacktestResultStore {
  constructor(
    private readonly client: StoreClient,
    readonly bucket: string,
    readonly kind: StorageKind,
  ) {}

  static fromConfig(config: ResultStoreConfig): BacktestResultStore {
    return new BacktestResultStore(new Client(config.client), config.bucket, config.kind);
  }

  // At startup: MinIO gets its bucket created; S3's must already exist
  async ensureBucket(): Promise<'ready' | 'created'> {
    if (await this.client.bucketExists(this.bucket)) return 'ready';
    if (this.kind === 's3') throw new Error(`S3 bucket ${this.bucket} does not exist or the role can't see it`);
    await this.client.makeBucket(this.bucket);
    return 'created';
  }

  // Readiness (/health/ready): the bucket answers
  async check(): Promise<void> {
    if (!(await this.client.bucketExists(this.bucket))) throw new Error('bucket missing');
  }

  async save(key: string, json: string): Promise<void> {
    await this.client.putObject(this.bucket, key, json, Buffer.byteLength(json), { 'Content-Type': 'application/json' });
  }

  async read(key: string): Promise<Buffer> {
    const stream = await this.client.getObject(this.bucket, key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
}

export const BACKTEST_RESULT_STORE = Symbol('BACKTEST_RESULT_STORE');
