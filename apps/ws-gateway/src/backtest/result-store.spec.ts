import { Readable } from 'stream';
import { randomUUID } from 'crypto';
import { rootEnv } from '@forexedge/database/testing';
import { Ec2RoleCredentialProvider } from './ec2-role-credentials';
import { BacktestResultStore, resultStoreConfig, StoreClient } from './result-store';

const MINIO_ENV = { MINIO_USER: 'dev-user', MINIO_PASS: 'dev-password' };

describe('resultStoreConfig', () => {
  it('NODE_ENV=production without STORAGE fails startup (it would otherwise pick MinIO)', () => {
    expect(() => resultStoreConfig({ NODE_ENV: 'production', ...MINIO_ENV })).toThrow('STORAGE must be set when NODE_ENV=production');
  });

  it('development defaults to MinIO with the bucket "backtests"', () => {
    const config = resultStoreConfig({ ...MINIO_ENV, MINIO_ENDPOINT: '127.0.0.1', MINIO_PORT: '9000' });
    expect(config).toMatchObject({ kind: 'minio', bucket: 'backtests' });
    expect(config.client).toMatchObject({ endPoint: '127.0.0.1', port: 9000, useSSL: false, accessKey: 'dev-user', secretKey: 'dev-password' });
  });

  it('STORAGE=minio has no credential defaults in code', () => {
    expect(() => resultStoreConfig({ STORAGE: 'minio' })).toThrow('MINIO_USER must be set');
  });

  it('STORAGE=s3: the regional endpoint over TLS, credentials from the instance role, no keys from the env', () => {
    const config = resultStoreConfig({
      NODE_ENV: 'production', STORAGE: 's3', AWS_REGION: 'ap-south-1', S3_BUCKET: 'results-bucket',
      // even if present, keys in the environment are never used for S3
      MINIO_USER: 'x', MINIO_PASS: 'y', AWS_ACCESS_KEY_ID: 'AKIA', AWS_SECRET_ACCESS_KEY: 'secret',
    });
    expect(config.kind).toBe('s3');
    expect(config.bucket).toBe('results-bucket');
    expect(config.client).toMatchObject({ endPoint: 's3.ap-south-1.amazonaws.com', useSSL: true, region: 'ap-south-1' });
    expect(config.client.accessKey).toBeUndefined();
    expect(config.client.secretKey).toBeUndefined();
    expect(config.client.credentialsProvider).toBeInstanceOf(Ec2RoleCredentialProvider);
  });

  it.each([
    [{ STORAGE: 's3', S3_BUCKET: 'b' }, 'AWS_REGION must be set'],
    [{ STORAGE: 's3', AWS_REGION: 'ap-south-1' }, 'S3_BUCKET must be set'],
    [{ STORAGE: 'gcs' }, 'STORAGE must be "minio" or "s3"'],
  ])('refuses %j', (env, message) => {
    expect(() => resultStoreConfig(env)).toThrow(message);
  });
});

function stubClient(bucketExists: boolean) {
  const objects = new Map<string, string>();
  const client = {
    bucketExists: jest.fn().mockResolvedValue(bucketExists),
    makeBucket: jest.fn().mockResolvedValue(undefined),
    putObject: jest.fn(async (_b: string, key: string, body: string) => { objects.set(key, body); return { etag: '0', versionId: null }; }),
    getObject: jest.fn(async (_b: string, key: string) => Readable.from([Buffer.from(objects.get(key) ?? '')])),
  };
  return { client, objects, store: (kind: 'minio' | 's3') => new BacktestResultStore(client as unknown as StoreClient, 'results', kind) };
}

describe('BacktestResultStore', () => {
  it('MinIO: a missing bucket is created', async () => {
    const { client, store } = stubClient(false);
    await expect(store('minio').ensureBucket()).resolves.toBe('created');
    expect(client.makeBucket).toHaveBeenCalledWith('results');
  });

  it('S3: a missing bucket fails startup and is never created (the role may not create buckets)', async () => {
    const { client, store } = stubClient(false);
    await expect(store('s3').ensureBucket()).rejects.toThrow('S3 bucket results does not exist');
    expect(client.makeBucket).not.toHaveBeenCalled();
    await expect(store('s3').check()).rejects.toThrow('bucket missing');
  });

  it.each(['minio', 's3'] as const)('%s: saves JSON with its content type and reads it back', async (kind) => {
    const { client, store } = stubClient(true);
    const json = JSON.stringify({ trades: [{ entryPoints: 112035, exitPoints: 111932 }] });
    await store(kind).save('run-1/results.json', json);
    expect(client.putObject).toHaveBeenCalledWith('results', 'run-1/results.json', json, Buffer.byteLength(json), { 'Content-Type': 'application/json' });
    expect((await store(kind).read('run-1/results.json')).toString()).toBe(json);
    await expect(store(kind).check()).resolves.toBeUndefined();
  });
});

// The real MinIO path against the dev MinIO (docker compose), like the DB suites
const run = process.env['RUN_DB_TESTS'] === 'true' ? describe : describe.skip;
run('BacktestResultStore on the dev MinIO', () => {
  it('saves and reads an object through the real client', async () => {
    const env = { ...rootEnv(), STORAGE: 'minio', BACKTEST_BUCKET: 'backtests' };
    const config = resultStoreConfig(env);
    const store = BacktestResultStore.fromConfig(config);
    await store.ensureBucket();
    const key = `store-test/${randomUUID()}.json`;
    const json = JSON.stringify({ check: key });
    const { Client } = await import('minio');
    const raw = new Client(config.client);
    try {
      await store.save(key, json);
      expect((await store.read(key)).toString()).toBe(json);
      await store.check();
    } finally {
      await raw.removeObject(config.bucket, key);
    }
  });
});
