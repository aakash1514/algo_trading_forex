// One-off data fix (roadmap step 2.7b): recomputes orders.session_opened from each
// order's own created_at with the shared market clock.
//
// Until 2.7b, order-service rebuilt the active sessions from forex.sessions events
// but read a `status` field the producer never sent, so every order was stamped
// OFF_HOURS. session_opened is now computed from the clock when an order is
// created; this script repairs the orders stamped before that.
//
// Dry run by default (prints the changes); pass --apply to write them in one
// transaction. Run from the repo root, with the services stopped:
//   npx ts-node -r tsconfig-paths/register tools/ops/recompute-order-sessions.ts [--apply]
import * as dotenv from 'dotenv';
import * as path from 'path';
import { Client } from 'pg';
import { sessionLabel } from '@forexedge/common';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const db = new Client({
    host: process.env['DB_HOST'] || 'localhost',
    port: Number(process.env['DB_PORT'] || 15432),
    user: process.env['DB_USER'],
    password: process.env['DB_PASS'],
    database: process.env['DB_NAME'],
  });
  await db.connect();
  try {
    const { rows } = await db.query<{ id: string; created_at: Date; session_opened: string | null }>(
      'SELECT id, created_at, session_opened FROM orders ORDER BY created_at',
    );
    const changes = rows
      .map((r) => ({ ...r, recomputed: sessionLabel(r.created_at) }))
      .filter((r) => r.recomputed !== r.session_opened);

    const tally = new Map<string, number>();
    for (const c of changes) {
      const key = `${c.session_opened} -> ${c.recomputed}`;
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    console.log(`${rows.length} orders, ${changes.length} to change`);
    for (const [key, n] of tally) console.log(`  ${key}: ${n}`);
    for (const c of changes) {
      console.log(`  ${c.id}  ${c.created_at.toISOString()}  ${c.session_opened} -> ${c.recomputed}`);
    }

    if (!apply) {
      console.log('Dry run: nothing written (pass --apply to write).');
      return;
    }
    await db.query('BEGIN');
    for (const c of changes) {
      await db.query('UPDATE orders SET session_opened = $1 WHERE id = $2', [c.recomputed, c.id]);
    }
    await db.query('COMMIT');
    console.log(`Updated ${changes.length} orders.`);
  } catch (err) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
