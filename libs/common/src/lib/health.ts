import { Controller, DynamicModule, Get, Inject, Module, ModuleMetadata, ServiceUnavailableException } from '@nestjs/common';

// Health endpoints for the host's probes, outside the /api prefix (main.ts excludes HEALTH_ROUTES):
//   GET /health/live   the process is up and serving HTTP: 200 { status: 'ok' }
//   GET /health/ready  every dependency of this service answers: 200 { status: 'ok', checks },
//                      otherwise 503 { status: 'down', checks }, checks = { db: 'ok' | 'down', ... }
// No auth, and nothing else in the body: no versions, hosts or error messages (a failure is logged
// by the service that owns the dependency, not echoed to whoever asks).

export type HealthCheck = () => Promise<unknown>;
export type HealthChecks = Readonly<Record<string, HealthCheck>>;
export type CheckStatus = 'ok' | 'down';

export const HEALTH_ROUTES = ['health/live', 'health/ready'];
export const HEALTH_CHECK_TIMEOUT_MS = 2_000;

// Every check runs at once, each bounded by the timeout. A check still running from an earlier probe
// is awaited again rather than started twice, so a hung dependency can't pile up connections.
export function createHealthRunner(checks: HealthChecks, timeoutMs = HEALTH_CHECK_TIMEOUT_MS) {
  const names = Object.keys(checks);
  if (names.length === 0) throw new Error('A readiness probe needs at least one check');
  const inFlight = new Map<string, Promise<unknown>>();

  const start = (name: string): Promise<unknown> => {
    let running = inFlight.get(name);
    if (!running) {
      running = Promise.resolve()
        .then(checks[name])
        .finally(() => inFlight.delete(name));
      inFlight.set(name, running);
    }
    return running;
  };

  const bounded = async (name: string): Promise<CheckStatus> => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    });
    try {
      await Promise.race([start(name), timeout]);
      return 'ok';
    } catch {
      return 'down';
    } finally {
      clearTimeout(timer);
    }
  };

  return async (): Promise<{ ready: boolean; checks: Record<string, CheckStatus> }> => {
    const statuses = await Promise.all(names.map(bounded));
    const result: Record<string, CheckStatus> = {};
    names.forEach((name, i) => (result[name] = statuses[i]));
    return { ready: statuses.every((s) => s === 'ok'), checks: result };
  };
}

// Checks for the dependencies the services share, typed structurally so this lib needs no
// TypeORM or ioredis import.
export const sqlCheck = (db: { query(sql: string): Promise<unknown> }): HealthCheck => () => db.query('SELECT 1');
export const redisCheck = (redis: { ping(): Promise<unknown> }): HealthCheck => () => redis.ping();

type Runner = ReturnType<typeof createHealthRunner>;
const HEALTH_RUNNER = Symbol('HEALTH_RUNNER');

@Controller('health')
class HealthController {
  constructor(@Inject(HEALTH_RUNNER) private readonly run: Runner) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    const { ready, checks } = await this.run();
    if (!ready) throw new ServiceUnavailableException({ status: 'down', checks });
    return { status: 'ok', checks };
  }
}

export interface HealthModuleOptions {
  imports?: ModuleMetadata['imports'];
  inject?: unknown[];
  useFactory: (...deps: never[]) => HealthChecks;
}

@Module({})
export class HealthModule {
  static forRoot(options: HealthModuleOptions): DynamicModule {
    return {
      module: HealthModule,
      imports: options.imports ?? [],
      controllers: [HealthController],
      providers: [
        {
          provide: HEALTH_RUNNER,
          inject: (options.inject ?? []) as never[],
          useFactory: (...deps: never[]) => createHealthRunner(options.useFactory(...deps)),
        },
      ],
    };
  }
}
