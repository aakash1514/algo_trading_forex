import { Candle, MoneyTrade } from './strategies/strategy.interface';
import { centsToUsd, commissionPoints, MoneySpec, pointsToUsdCents, roundHalfAwayFromZero } from './trade-money';

// Backtest metrics in money (USD).
//
// Equity is marked to market at every bar close: initial capital + the net USD of
// the trades closed so far + what the open trade would net if closed at that
// close (a long at the bid close, a short at the ask close, round-trip commission
// deducted, a USD-based pair converted at that same close). On a trade's exit bar
// the curve equals realized equity. All amounts are whole cents.
//
//   Max drawdown  max over bar closes of (peak - equity) / peak x 100, peak = the
//                 running maximum, starting at the initial capital. No margin or
//                 stop-out is modelled: equity can fall below zero and the
//                 drawdown can then exceed 100%.
//   Sharpe        daily simple returns r_d = E_d / E_(d-1) - 1, where E_d is the
//                 equity at the last bar closing at or before each Monday-Friday
//                 New York 17:00 close in the window (calendar days, so holidays
//                 count as 0-return days; E_0 = initial capital), then
//                 mean(r) / sample stdev(r) x sqrt(260), risk-free rate 0.
//                 Null with fewer than 2 returns or zero deviation.
//   Profit factor gross profit / gross loss of net USD (null without a loss).
//   Win rate      % of trades with net > 0 (null without trades).

export const TRADING_DAYS_PER_YEAR = 260; // 52 weeks x 5 New York closes

export interface DailyEquity {
  time: string;   // the New York 17:00 close, ISO UTC
  equity: number; // USD
}

export interface BacktestMetrics {
  totalTrades: number;
  winRate: number | null;
  profitFactor: number | null;
  sharpeRatio: number | null;
  maxDrawdownPct: number;
  totalPnl: number;        // pips
  totalPnlUsd: string;     // USD, 2 dp
}

export interface MetricsInput {
  candles: Pick<Candle, 'bucket' | 'bid' | 'ask'>[];
  trades: MoneyTrade[];
  money: MoneySpec;
  initialCapital: number;  // USD
  barMs: number;
  window: { from: Date; end: Date };
}

export interface MetricsResult {
  metrics: BacktestMetrics;
  dailyEquity: DailyEquity[];
  finalEquity: number;
}

const toCents = (usd: number) => BigInt(Math.round(usd * 100));

// Equity in cents at every bar close (one value per candle)
export function equityAtBarCloses(input: Pick<MetricsInput, 'candles' | 'trades' | 'money' | 'initialCapital'>): bigint[] {
  const { candles, trades, money } = input;
  const commission = commissionPoints(money.pipPoints);
  let realized = toCents(input.initialCapital);
  let next = 0; // next trade to close, in time order
  const curve: bigint[] = [];
  for (const bar of candles) {
    const t = bar.bucket.getTime();
    while (next < trades.length && trades[next].exitTime.getTime() <= t) realized += toCents(trades[next++].netUsd);
    let equity = realized;
    const open = trades[next];
    if (open && open.entryTime.getTime() <= t) {
      const close = open.action === 'BUY' ? bar.bid.close : bar.ask.close;
      const points = (open.action === 'BUY' ? close - open.entryPoints : open.entryPoints - close) - commission;
      equity += pointsToUsdCents(points, money, close);
    }
    curve.push(equity);
  }
  return curve;
}

// 17:00 America/New_York on a calendar day, as a UTC instant (21:00 or 22:00 UTC)
export function newYorkClose(year: number, month: number, day: number): Date {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' });
  for (const utcHour of [21, 22]) {
    const candidate = new Date(Date.UTC(year, month - 1, day, utcHour));
    if (fmt.format(candidate) === '17') return candidate;
  }
  throw new Error(`no 17:00 New York instant on ${year}-${month}-${day}`);
}

// The Monday-Friday New York 17:00 closes inside [from, end)
export function newYorkCloses(from: Date, end: Date): Date[] {
  const closes: Date[] = [];
  for (let d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())); d < end;
    d = new Date(d.getTime() + 86_400_000)) {
    const weekday = d.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const close = newYorkClose(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    if (close >= from && close < end) closes.push(close);
  }
  return closes;
}

// Equity at the last bar closing at or before each close (the initial capital
// before the first bar)
export function dailyEquityCents(
  candles: Pick<Candle, 'bucket'>[], curve: bigint[], closes: Date[], barMs: number, initialCents: bigint,
): bigint[] {
  const out: bigint[] = [];
  let k = -1;
  for (const close of closes) {
    while (k + 1 < candles.length && candles[k + 1].bucket.getTime() + barMs <= close.getTime()) k++;
    out.push(k >= 0 ? curve[k] : initialCents);
  }
  return out;
}

// Largest (peak - equity) / peak in percent, exact to 4 dp
export function maxDrawdownPct(initialCents: bigint, curve: bigint[]): number {
  let peak = initialCents;
  let worst = 0n; // in 1e-4 percent
  for (const equity of curve) {
    if (equity > peak) peak = equity;
    if (peak <= 0n) continue;
    const dd = roundHalfAwayFromZero((peak - equity) * 100n * 10_000n, peak);
    if (dd > worst) worst = dd;
  }
  return Number(worst) / 10_000;
}

export function sharpeRatio(dailyCents: bigint[], initialCents: bigint): number | null {
  const series = [initialCents, ...dailyCents].map(Number);
  const returns: number[] = [];
  for (let i = 1; i < series.length; i++) {
    if (series[i - 1] <= 0) return null; // returns are undefined once equity is gone
    returns.push(series[i] / series[i - 1] - 1);
  }
  if (returns.length < 2) return null;
  const mean = returns.reduce((a, r) => a + r, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1);
  if (variance === 0) return null;
  return round4((mean / Math.sqrt(variance)) * Math.sqrt(TRADING_DAYS_PER_YEAR));
}

export function calculateMetrics(input: MetricsInput): MetricsResult {
  const { trades } = input;
  const initialCents = toCents(input.initialCapital);
  const curve = equityAtBarCloses(input);
  const closes = newYorkCloses(input.window.from, input.window.end);
  const daily = dailyEquityCents(input.candles, curve, closes, input.barMs, initialCents);

  const netCents = trades.map((t) => toCents(t.netUsd));
  const totalCents = netCents.reduce((a, c) => a + c, 0n);
  const profit = netCents.filter((c) => c > 0n).reduce((a, c) => a + c, 0n);
  const loss = -netCents.filter((c) => c < 0n).reduce((a, c) => a + c, 0n);
  const winners = netCents.filter((c) => c > 0n).length;

  return {
    metrics: {
      totalTrades: trades.length,
      winRate: trades.length === 0 ? null : Number(roundHalfAwayFromZero(BigInt(winners) * 10_000n, BigInt(trades.length))) / 100,
      profitFactor: loss === 0n ? null : Number(roundHalfAwayFromZero(profit * 10_000n, loss)) / 10_000,
      sharpeRatio: sharpeRatio(daily, initialCents),
      maxDrawdownPct: maxDrawdownPct(initialCents, curve),
      totalPnl: round2(trades.reduce((sum, t) => sum + t.netPnl, 0)),
      totalPnlUsd: centsToUsd(totalCents).toFixed(2),
    },
    dailyEquity: daily.map((c, i) => ({ time: closes[i].toISOString(), equity: centsToUsd(c) })),
    finalEquity: centsToUsd(initialCents + totalCents),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Half away from zero, like the other metrics and Postgres round(numeric)
function round4(n: number): number {
  return (Math.sign(n) * Math.round(Math.abs(n) * 10_000)) / 10_000;
}
