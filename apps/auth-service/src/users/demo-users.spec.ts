import * as argon2 from 'argon2';
import { createTestDatabase, type TestDatabase } from '@forexedge/database/testing';
import { hashPassword } from '../auth/password-hash';
import { createDemoUsers, demoUsersFromEnv } from './demo-users';

const STRONG = 'Demo!Passw0rd-Long';

describe('demoUsersFromEnv', () => {
  it('reads each user from DEMO_<USERNAME>_* with registration\'s rules', async () => {
    const users = await demoUsersFromEnv({
      DEMO_USERS: 'demo, demo_two',
      DEMO_DEMO_EMAIL: 'demo@example.com', DEMO_DEMO_PASS: STRONG,
      DEMO_DEMO_TWO_EMAIL: 'demo2@example.com', DEMO_DEMO_TWO_PASS: STRONG, DEMO_DEMO_TWO_FIRST_NAME: 'Second',
    });
    expect(users.map((u) => [u.username, u.email, u.firstName, u.lastName])).toEqual([
      ['demo', 'demo@example.com', 'Demo', 'demo'],
      ['demo_two', 'demo2@example.com', 'Second', 'demo_two'],
    ]);
  });

  it('has no defaults: without DEMO_USERS, an email or a password it refuses', async () => {
    await expect(demoUsersFromEnv({})).rejects.toThrow('DEMO_USERS is not set');
    await expect(demoUsersFromEnv({ DEMO_USERS: 'demo', DEMO_DEMO_PASS: STRONG })).rejects.toThrow('DEMO_DEMO_EMAIL is not set');
    await expect(demoUsersFromEnv({ DEMO_USERS: 'demo', DEMO_DEMO_EMAIL: 'd@example.com' })).rejects.toThrow('DEMO_DEMO_PASS is not set');
  });

  it('refuses a password under 12 characters, and never shows it', async () => {
    const short = 'Ab1!short'; // 9 characters, otherwise valid for sign-up
    const error = await demoUsersFromEnv({ DEMO_USERS: 'demo', DEMO_DEMO_EMAIL: 'd@example.com', DEMO_DEMO_PASS: short })
      .then(() => null, (e: Error) => e);
    expect(error?.message).toContain('DEMO_DEMO_PASS must be at least 12 characters');
    expect(error?.message).not.toContain(short);
  });

  it('applies the sign-up rules (complexity, username characters), naming the variable only', async () => {
    const weak = 'alllowercaseletters';
    const error = await demoUsersFromEnv({ DEMO_USERS: 'demo-user', 'DEMO_DEMO-USER_EMAIL': 'x', 'DEMO_DEMO-USER_PASS': weak })
      .then(() => null, (e: Error) => e);
    expect(error?.message).toMatch(/DEMO_DEMO-USER_PASS: Password must contain uppercase/);
    expect(error?.message).toMatch(/DEMO_DEMO-USER_EMAIL: Please provide a valid email address/);
    expect(error?.message).toMatch(/DEMO_USERS \(demo-user\): Username can only contain/);
    expect(error?.message).not.toContain(weak);
  });
});

const run = process.env['RUN_DB_TESTS'] === 'true' ? describe : describe.skip;

run('createDemoUsers (real DB: <DB_NAME>_test)', () => {
  jest.setTimeout(120_000);
  let testDb: TestDatabase;
  beforeAll(async () => { testDb = await createTestDatabase(); });
  afterAll(async () => { await testDb?.drop(); });

  it('creates the users with a password that verifies, and a second run changes nothing', async () => {
    const db = { query: async <R>(sql: string, params?: unknown[]) => ({ rows: (await testDb.dataSource.query(sql, params)) as R[] }) };
    const users = await demoUsersFromEnv({ DEMO_USERS: 'demo', DEMO_DEMO_EMAIL: 'demo@example.com', DEMO_DEMO_PASS: STRONG });
    expect(await createDemoUsers(db, users, hashPassword)).toEqual({ created: ['demo'], existing: [] });
    const [row] = await testDb.dataSource.query(`SELECT password_hash, role FROM users WHERE username = 'demo'`);
    expect(await argon2.verify(row.password_hash, STRONG)).toBe(true);
    expect(row.password_hash).toMatch(/^\$argon2id\$/);

    const again = await createDemoUsers(db, [{ ...users[0], password: 'Another!Passw0rd' }], hashPassword);
    expect(again).toEqual({ created: [], existing: ['demo'] });
    const [after] = await testDb.dataSource.query(`SELECT password_hash FROM users WHERE username = 'demo'`);
    expect(after.password_hash).toBe(row.password_hash); // never re-passworded
    expect(await testDb.dataSource.query(`SELECT count(*)::int AS n FROM users`)).toEqual([{ n: 1 }]);
  });
});
