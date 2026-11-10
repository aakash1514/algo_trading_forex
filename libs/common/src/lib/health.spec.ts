import { Controller, Get, INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHealthRunner, HEALTH_ROUTES, HealthModule, redisCheck, sqlCheck } from './health';

describe('createHealthRunner', () => {
  afterEach(() => jest.useRealTimers());

  it('is ready only when every check answers', async () => {
    const run = createHealthRunner({ db: async () => 1, redis: async () => 'PONG' });
    expect(await run()).toEqual({ ready: true, checks: { db: 'ok', redis: 'ok' } });
    const failing = createHealthRunner({ db: async () => 1, kafka: async () => { throw new Error('ECONNREFUSED 10.0.0.5:9092'); } });
    expect(await failing()).toEqual({ ready: false, checks: { db: 'ok', kafka: 'down' } });
  });

  it('a check that never answers is down after the timeout, and is not started again while it hangs', async () => {
    jest.useFakeTimers();
    let started = 0;
    const run = createHealthRunner({ db: () => { started++; return new Promise(() => undefined); } }, 2_000);
    const first = run();
    await jest.advanceTimersByTimeAsync(2_000);
    expect(await first).toEqual({ ready: false, checks: { db: 'down' } });
    const second = run();
    await jest.advanceTimersByTimeAsync(2_000);
    expect(await second).toEqual({ ready: false, checks: { db: 'down' } });
    expect(started).toBe(1);
  });

  it('refuses a readiness probe with nothing to check (an empty probe would always pass)', () => {
    expect(() => createHealthRunner({})).toThrow('at least one check');
  });

  it('sqlCheck and redisCheck call the real client methods', async () => {
    const db = { query: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    const redis = { ping: jest.fn().mockResolvedValue('PONG') };
    await sqlCheck(db)();
    await redisCheck(redis)();
    expect(db.query).toHaveBeenCalledWith('SELECT 1');
    expect(redis.ping).toHaveBeenCalled();
  });
});

describe('HealthModule over HTTP', () => {
  let healthy = true;
  let app: INestApplication;
  let base: string;

  @Controller('things')
  class ThingsController {
    @Get()
    list() {
      return [];
    }
  }

  @Module({ controllers: [ThingsController] })
  class ThingsModule {}

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ThingsModule,
        HealthModule.forRoot({
          useFactory: () => ({
            db: async () => {
              if (!healthy) throw new Error('password authentication failed for user "forexedge" at db.internal:5432');
            },
          }),
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api', { exclude: HEALTH_ROUTES }); // as every main.ts does
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });

  afterAll(() => app.close());

  it('serves /health/live and /health/ready outside the /api prefix, without auth', async () => {
    healthy = true;
    const live = await fetch(`${base}/health/live`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: 'ok' });
    const ready = await fetch(`${base}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ok', checks: { db: 'ok' } });
    expect((await fetch(`${base}/api/health/live`)).status).toBe(404);
    expect((await fetch(`${base}/api/things`)).status).toBe(200); // the prefix still applies elsewhere
  });

  it('a down dependency is 503 with its name only: no error text, host or version', async () => {
    healthy = false;
    const ready = await fetch(`${base}/health/ready`);
    expect(ready.status).toBe(503);
    const text = await ready.text();
    expect(JSON.parse(text)).toEqual({ status: 'down', checks: { db: 'down' } });
    expect(text).not.toMatch(/password|db\.internal|5432|version/i);
    expect((await fetch(`${base}/health/live`)).status).toBe(200); // live doesn't depend on the DB
  });
});
