import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PositionEntity } from '@forexedge/database';
import { AccountService } from './account.service';
import { PositionAlreadyClosedError, PositionService } from '../position/position.service';
import { PricingService, PriceUnavailableError } from '../pricing/pricing.service';
import { MarketHoursPolicy } from '../market/market-hours.policy';

// Margin level thresholds (equity / margin used, in %)
export const STOP_OUT_LEVEL = 50;
export const MARGIN_CALL_LEVEL = 100;
export const MARGIN_WARNING_LEVEL = 150;

// Margin-call handling, run by the tick consumer for each user whose positions a
// batch touched (once per user per batch).
// - Below 50%: stop-out. Open positions are closed at market, biggest loser
//   first, re-reading the margin level after each close, until the level is back
//   at or above 50% (or nothing closable is left). close_reason = STOP_OUT.
//   Positions whose market is closed are skipped; they are reconsidered on the
//   first tick after their market reopens.
// - 50-100%: margin call, 100-150%: warning. Logged only: nothing is written to
//   the positions (MARGIN_CALL used to be written to every open position and
//   closed nothing).
@Injectable()
export class StopOutService {
  private readonly logger = new Logger(StopOutService.name);
  static readonly ALERT_REPEAT_MS = 60_000;

  // Users whose stop-out is running, so an overlapping call can't double-close
  private readonly running = new Set<string>();
  // Last margin alert per user: logged again only when the band changes or after a minute
  private readonly lastAlert = new Map<string, { band: string; at: number }>();

  constructor(
    @InjectRepository(PositionEntity)
    private readonly positionRepo: Repository<PositionEntity>,
    private readonly accounts: AccountService,
    private readonly positions: PositionService,
    private readonly pricing: PricingService,
    private readonly marketHours: MarketHoursPolicy,
  ) {}

  async check(userId: string): Promise<void> {
    if (this.running.has(userId)) return;
    this.running.add(userId);
    try {
      const summary = await this.accounts.getAccountSummary(userId);
      const level = summary.marginLevel;
      if (level === null) return; // no open positions

      if (level < STOP_OUT_LEVEL) {
        await this.stopOut(userId, level);
      } else if (level < MARGIN_CALL_LEVEL) {
        this.alert(userId, 'MARGIN CALL', level);
      } else if (level < MARGIN_WARNING_LEVEL) {
        this.alert(userId, 'MARGIN WARNING', level);
      }
      // Healthy: the last alert is kept, so hovering around 150% can't re-log every batch
    } finally {
      this.running.delete(userId);
    }
  }

  // A worse band is logged at once; the same or a better band at most once a
  // minute, so a level hovering around a threshold doesn't flood the log.
  private alert(userId: string, band: 'MARGIN WARNING' | 'MARGIN CALL', level: number): void {
    const severity = { 'MARGIN WARNING': 1, 'MARGIN CALL': 2 };
    const last = this.lastAlert.get(userId);
    const now = Date.now();
    const worse = !last || severity[band] > severity[last.band as keyof typeof severity];
    if (!worse && last && now - last.at < StopOutService.ALERT_REPEAT_MS) return;
    this.lastAlert.set(userId, { band, at: now });
    this.logger.warn(`${band} — user ${userId} margin level ${level.toFixed(2)}%`);
  }

  private async stopOut(userId: string, startLevel: number): Promise<void> {
    // Biggest loser first (lowest unrealized P&L), by the marks at this moment
    const open = await this.positionRepo.find({ where: { userId, isOpen: true }, order: { unrealizedPnl: 'ASC' } });
    this.lastAlert.delete(userId);
    this.logger.error(
      `STOP OUT — user ${userId} margin level ${startLevel.toFixed(2)}%; close order (by open P&L): ` +
      open.map((p) => `${p.pair} ${p.direction} ${Number(p.unrealizedPnl).toFixed(2)}`).join(', '),
    );
    let level: number | null = startLevel;
    let closed = 0;

    for (const position of open) {
      const status = this.marketHours.status(await this.pricing.getInstrumentKind(position.pair));
      if (!status.open) continue;

      let closingPrice: number;
      try {
        const quote = await this.pricing.getQuote(position.pair);
        closingPrice = position.direction === 'LONG' ? quote.bid : quote.ask;
      } catch (err) {
        if (err instanceof PriceUnavailableError) continue;
        throw err;
      }

      try {
        const result = await this.positions.closePosition(position.id, 'STOP_OUT', closingPrice);
        closed++;
        this.logger.error(
          `STOP OUT closed ${position.pair} ${position.direction} ${position.lots} lots ` +
          `(position ${position.id}) at ${closingPrice}, P&L $${Number(result.realizedPnl).toFixed(2)}`,
        );
      } catch (err) {
        if (!(err instanceof PositionAlreadyClosedError)) throw err; // closed by another path: fine
      }

      level = (await this.accounts.getAccountSummary(userId)).marginLevel;
      if (level === null || level >= STOP_OUT_LEVEL) break;
    }

    this.logger.error(
      `STOP OUT done — user ${userId}: ${closed} position(s) closed, margin level now ` +
      `${level === null ? 'n/a (no open positions)' : `${level.toFixed(2)}%`}`,
    );
  }
}
