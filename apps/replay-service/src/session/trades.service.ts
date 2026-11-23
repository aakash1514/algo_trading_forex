import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { assertUserId } from '@forexedge/common';
import { ReplayPositionEntity, ReplaySessionEntity } from '@forexedge/database';
import { PairContextService } from '../history/pair-context.service';
import { positionView, PositionView } from './position.view';

export const TRADES_PAGE_SIZE = 20;

export interface TradesPage {
  trades: PositionView[];       // newest first: exit_time DESC, id DESC
  nextCursor: string | null;    // null on the last page
}

interface Cursor { t: string; id: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

export function decodeCursor(raw: string): Cursor {
  let c: unknown;
  try {
    c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new BadRequestException('Invalid cursor');
  }
  const { t, id } = (c ?? {}) as Partial<Cursor>;
  if (typeof t !== 'string' || typeof id !== 'string' || !UUID.test(id) || Number.isNaN(Date.parse(t))
      || new Date(t).toISOString() !== t) {
    throw new BadRequestException('Invalid cursor');
  }
  return { t, id };
}

// The closed-trade history of one of the user's replay sessions (active
// or ended). Every query is scoped by the owner: another user's session is a 404.
@Injectable()
export class ReplayTradesService {
  constructor(
    @InjectRepository(ReplaySessionEntity) private readonly sessions: Repository<ReplaySessionEntity>,
    private readonly dataSource: DataSource,
    private readonly pairs: PairContextService,
  ) {}

  // Keyset paging on (exit_time DESC, id DESC): several trades can close in the same
  // minute, so the id breaks the tie, and a trade closing while the user pages has a
  // later exit_time than every loaded row (the clock only moves forward), so it never
  // shifts a later page.
  async closedTrades(userId: string, sessionId: string, cursor?: string): Promise<TradesPage> {
    const session = await this.owned(userId, sessionId);
    const after = cursor ? decodeCursor(cursor) : null;
    const ctx = await this.pairs.get(session.pair);
    const rows = await this.dataSource.getRepository(ReplayPositionEntity).createQueryBuilder('p')
      .innerJoin(ReplaySessionEntity, 's', 's.id = p.sessionId AND s.userId = :userId', { userId })
      .where('p.sessionId = :sessionId', { sessionId })
      .andWhere(`p.status = 'CLOSED'`)
      .andWhere(after ? '(p.exitTime, p.id) < (CAST(:t AS timestamptz), CAST(:id AS uuid))' : 'TRUE', after ?? {})
      .orderBy('p.exitTime', 'DESC')
      .addOrderBy('p.id', 'DESC')
      .limit(TRADES_PAGE_SIZE + 1)
      .getMany();
    const page = rows.slice(0, TRADES_PAGE_SIZE);
    const last = page.at(-1);
    return {
      trades: page.map((p) => positionView(p, ctx.priceDecimals)),
      nextCursor: rows.length > TRADES_PAGE_SIZE && last?.exitTime
        ? encodeCursor({ t: last.exitTime.toISOString(), id: last.id }) : null,
    };
  }

  private async owned(userId: string, sessionId: string): Promise<ReplaySessionEntity> {
    assertUserId(userId);
    const session = await this.sessions.findOne({ where: { id: sessionId, userId } });
    if (!session) throw new NotFoundException('Replay session not found');
    return session;
  }
}
