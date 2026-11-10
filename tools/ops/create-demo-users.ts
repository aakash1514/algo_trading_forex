// Creates the demo accounts for a deployment with registration closed. The users, emails and passwords
// come from the environment only (DEMO_USERS, DEMO_<USERNAME>_EMAIL, DEMO_<USERNAME>_PASS; see
// apps/auth-service/src/users/demo-users.ts): no defaults in code, passwords of at least 12 characters
// and registration's own rules, hashed exactly as a sign-up (argon2id). Idempotent: a user that exists
// (same username or email) is left untouched. Prints usernames only, never a password.
//
// From the repo root (reads .env when there is one; a container passes the variables instead):
//   npx ts-node --transpile-only tools/ops/create-demo-users.ts
import { existsSync } from 'fs';
import * as path from 'path';
import { Client } from 'pg';
import { hashPassword } from '../../apps/auth-service/src/auth/password-hash';
import { createDemoUsers, demoUsersFromEnv } from '../../apps/auth-service/src/users/demo-users';

async function main(): Promise<void> {
  const envFile = path.resolve(__dirname, '../../.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const env = process.env;
  const users = await demoUsersFromEnv(env);
  const db = new Client({
    host: env['DB_HOST'], port: Number(env['DB_PORT']), database: env['DB_NAME'], user: env['DB_USER'], password: env['DB_PASS'],
    ssl: env['DB_SSL'] === 'true' ? { rejectUnauthorized: false } : false, // as the services (DB_SSL)
  });
  await db.connect();
  try {
    const { created, existing } = await createDemoUsers(db, users, hashPassword);
    console.log(`Demo users: created ${created.length ? created.join(', ') : 'none'}; already there ${existing.length ? existing.join(', ') : 'none'}`);
  } finally {
    await db.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
