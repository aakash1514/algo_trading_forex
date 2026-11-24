import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { HistoricalTimeframe, ReplayPositionEntity, ReplaySessionEntity } from '@forexedge/database';
import { currentBar, historyBars } from '../history/replay-bars';
import { calendarView, CalendarView } from '../history/replay-calendar';
import { PairContextService } from '../history/pair-context.service';
import { minuteAt } from '../history/replay-history';
import { accountView, AccountView } from '../session/account.view';
import { barView, BarView } from '../session/bar.view';
import { positionView, PositionView } from '../session/position.view';
import { sessionView, SessionView } from '../session/session.view';

export const RECENT_CLOSED = 50;

// Everything a client needs to draw a session, as of its clock
export interface ReplayState {
  session: SessionView;
  account: AccountView;
  priceDecimals: number;
  bars: BarView[];          // completed bars before the current one (up to 500)
  currentBar: BarView;      // the bar holding the clock, from its minutes up to the clock
  positions: PositionView[]; // pending and open, then the latest closed/cancelled
  calendar: CalendarView;    // calendar events from the first bar to the clock (none after it)
}

@Injectable()
export class ReplayStateService {
  constructor(
    @InjectRepository(ReplayPositionEntity) private readonly positions: Repository<ReplayPositionEntity>,
    private readonly dataSource: DataSource,
    private readonly pairs: PairContextService,
  ) {}

  async state(session: ReplaySessionEntity): Promise<ReplayState> {
    const ctx = await this.pairs.get(session.pair);
    const timeframe = session.timeframe as HistoricalTimeframe;
    const current = await currentBar(this.dataSource, session.pair, timeframe, session.clockTime);
    const history = await historyBars(this.dataSource, session.pair, timeframe, current.time);
    const live = await this.livePositions(session.id);
    const done = await this.positions.find({
      where: { sessionId: session.id, status: In(['CLOSED', 'CANCELLED']) },
      order: { updatedAt: 'DESC', id: 'DESC' }, take: RECENT_CLOSED,
    });
    return {
      session: sessionView(session, ctx.lastTime),
      account: await this.account(session, live),
      priceDecimals: ctx.priceDecimals,
      bars: history.map((b) => barView(b, ctx.priceDecimals)),
      currentBar: barView(current, ctx.priceDecimals),
      positions: [...live, ...done].map((p) => positionView(p, ctx.priceDecimals)),
      calendar: await calendarView(this.dataSource, session.pair, timeframe, history[0]?.time ?? current.time, session.clockTime),
    };
  }

  // Pending orders and open positions, oldest first
  livePositions(sessionId: string): Promise<ReplayPositionEntity[]> {
    return this.positions.find({
      where: { sessionId, status: In(['PENDING', 'OPEN']) }, order: { createdAt: 'ASC', id: 'ASC' },
    });
  }

  async account(session: ReplaySessionEntity, live?: ReplayPositionEntity[]): Promise<AccountView> {
    const ctx = await this.pairs.get(session.pair);
    const clockMinute = await minuteAt(this.dataSource, session.pair, session.clockTime);
    return accountView(session.id, session.balance, live ?? await this.livePositions(session.id), clockMinute, ctx);
  }
}
