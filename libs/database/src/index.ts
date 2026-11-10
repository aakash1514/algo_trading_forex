// TypeORM loads the Postgres driver with a dynamic require that a service's build can't see, so the
// generated package.json of its production image would leave pg out (the container then fails at
// startup). Importing it here makes every service that uses this library declare it.
import 'pg';

export * from './lib/database';
export * from './lib/entities/user.entity';
export * from './lib/entities/instrument.entity';
export * from './lib/entities/swap-rate.entity';
export * from './lib/entities/economic-event.entity';
export * from './lib/entities/order.entity';
export * from './lib/entities/position.entity';
export * from './lib/entities/account-summary.entity';
export * from './lib/entities/backtest-run.entity';
export * from './lib/entities/replay-session.entity';
export * from './lib/entities/replay-position.entity';
export * from './lib/historical-candles';
export * from './lib/historical-buckets';
export * from './lib/live-ticks';
