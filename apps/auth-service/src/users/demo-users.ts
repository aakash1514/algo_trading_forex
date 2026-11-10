import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RegisterDto } from '../auth/dto/register.dto';

// Demo accounts for a deployment with registration closed (REGISTRATION_ENABLED unset), created by
// tools/ops/create-demo-users.ts. Every value comes from the environment; there are no defaults in code:
//
//   DEMO_USERS=demo,demo_two           usernames, comma-separated
//   DEMO_<USERNAME>_EMAIL              e.g. DEMO_DEMO_TWO_EMAIL for demo_two
//   DEMO_<USERNAME>_PASS               at least 12 characters, and registration's own rules
//   DEMO_<USERNAME>_FIRST_NAME / _LAST_NAME   optional (default "Demo" / the username)
//
// A user is checked with the same RegisterDto rules as a sign-up. No message here ever contains a
// password: errors name the variable, never its value.

export const DEMO_MIN_PASSWORD_LENGTH = 12;

export interface DemoUser {
  username: string;
  email: string;
  password: string;
  firstName: string;
  lastName: string;
}

type Env = Readonly<Record<string, string | undefined>>;

const envKey = (username: string) => `DEMO_${username.toUpperCase()}`;

export async function demoUsersFromEnv(env: Env): Promise<DemoUser[]> {
  const names = (env['DEMO_USERS'] ?? '').split(',').map((n) => n.trim()).filter(Boolean);
  if (names.length === 0) throw new Error('DEMO_USERS is not set (comma-separated usernames)');
  const problems: string[] = [];
  if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) problems.push('DEMO_USERS lists a username twice');

  const users: DemoUser[] = [];
  for (const username of names) {
    const key = envKey(username);
    const email = env[`${key}_EMAIL`]?.trim();
    const password = env[`${key}_PASS`];
    if (!email) problems.push(`${key}_EMAIL is not set`);
    if (!password) {
      problems.push(`${key}_PASS is not set`);
      continue;
    }
    if (password.length < DEMO_MIN_PASSWORD_LENGTH) {
      problems.push(`${key}_PASS must be at least ${DEMO_MIN_PASSWORD_LENGTH} characters`);
    }
    const user: DemoUser = {
      username,
      email: email ?? '',
      password,
      firstName: env[`${key}_FIRST_NAME`]?.trim() || 'Demo',
      lastName: env[`${key}_LAST_NAME`]?.trim() || username,
    };
    // registration's own rules (email, username, password strength and length)
    const errors = await validate(plainToInstance(RegisterDto, { ...user }));
    for (const error of errors) {
      const variable = error.property === 'password' ? `${key}_PASS` : error.property === 'email' ? `${key}_EMAIL` : `DEMO_USERS (${username})`;
      for (const message of Object.values(error.constraints ?? {})) problems.push(`${variable}: ${message}`);
    }
    users.push(user);
  }
  if (problems.length > 0) throw new Error(`Demo users not created:\n  ${problems.join('\n  ')}`);
  return users;
}

// The DB side, idempotent: a user whose username or email exists is left as it is (never re-passworded).
export interface SqlClient {
  query<R>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export async function createDemoUsers(
  db: SqlClient, users: DemoUser[], hash: (password: string) => Promise<string>,
): Promise<{ created: string[]; existing: string[] }> {
  const created: string[] = [];
  const existing: string[] = [];
  for (const u of users) {
    const { rows } = await db.query<{ id: string }>(
      'SELECT id FROM users WHERE lower(username) = lower($1) OR lower(email) = lower($2)', [u.username, u.email],
    );
    if (rows.length > 0) {
      existing.push(u.username);
      continue;
    }
    await db.query(
      `INSERT INTO users (email, username, password_hash, first_name, last_name) VALUES ($1, $2, $3, $4, $5)`,
      [u.email, u.username, await hash(u.password), u.firstName, u.lastName],
    );
    created.push(u.username);
  }
  return { created, existing };
}
