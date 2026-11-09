// replay-service connects as its own login (REPLAY_DB_USER, created by
// tools/ops/create-replay-db-user.ts): it reads the history and instruments and
// writes only the replay_* tables. Never the main DB user, whose rights would let a
// bug write anywhere, including historical_*.
export interface ReplayDbCredentials {
  username: string;
  password: string;
}

export function replayDbCredentials(env: Record<string, string | undefined>): ReplayDbCredentials {
  const username = env['REPLAY_DB_USER'];
  const password = env['REPLAY_DB_PASS'];
  if (!username || !password) throw new Error('set REPLAY_DB_USER and REPLAY_DB_PASS (tools/ops/create-replay-db-user.ts)');
  if (username === env['DB_USER']) throw new Error('REPLAY_DB_USER must differ from DB_USER');
  return { username, password };
}
