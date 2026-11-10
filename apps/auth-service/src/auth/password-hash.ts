import * as argon2 from 'argon2';

// How every password is stored: argon2id, used by registration and by the demo-user tool
// (tools/ops/create-demo-users.ts), so a demo user logs in exactly like a registered one.
export const PASSWORD_HASH_OPTIONS = {
  type: argon2.argon2id, // most secure variant
  memoryCost: 65536,     // 64MB memory — makes brute force expensive
  timeCost: 3,           // 3 iterations
  parallelism: 4,        // 4 parallel threads
} as const;

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, PASSWORD_HASH_OPTIONS);
}
