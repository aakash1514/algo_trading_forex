import { Logger } from '@nestjs/common';
import { marketStatus, priceDecimals } from '@forexedge/common';
import { IForexStreamProvider } from '../interfaces/stream-provider.interface';
import { NormalizedTick as KafkaNormalizedTick } from '@forexedge/kafka';
import type { InstrumentQuoteSpec } from '../../market/instrument.repository';

// Synthetic live feed, used only until a real feed is integrated (roadmap
// step 6). Precision and typical spread come from the instruments table, so the
// mock quotes every instrument the way the rest of the system expects
// (spread monitor, order gate, P&L). Prices are a random walk from these
// starting points.
//
// Starting mid prices: FX values are approximate 2024 levels. XAU_USD starts at
// the last real Dukascopy close in our history (2022-12-30 21:58 UTC, bid
// 1823.463 / ask 1824.252).
const BASE_PRICES: Record<string, number> = {
  // Majors
  EUR_USD: 1.0850, GBP_USD: 1.2650, USD_JPY: 149.50,
  USD_CHF: 0.8950, USD_CAD: 1.3580, AUD_USD: 0.6520,
  NZD_USD: 0.5980,
  // Minors - EUR crosses
  EUR_GBP: 0.8580, EUR_JPY: 162.20, EUR_CHF: 0.9710,
  EUR_CAD: 1.4740, EUR_AUD: 1.6640, EUR_NZD: 1.8150,
  // Minors - GBP crosses
  GBP_JPY: 189.10, GBP_CHF: 1.1320, GBP_CAD: 1.7170,
  GBP_AUD: 1.9400, GBP_NZD: 2.1160,
  // Minors - other crosses
  AUD_JPY: 97.50,  AUD_CHF: 0.5840, AUD_CAD: 0.8850,
  AUD_NZD: 1.0870, NZD_JPY: 89.60,  NZD_CHF: 0.5360,
  NZD_CAD: 0.8120, CAD_JPY: 110.10, CAD_CHF: 0.6600,
  // Exotic
  USD_SGD: 1.3450,
  // Metals
  XAU_USD: 1823.86,
};

// Per-tick volatility (fraction of price). XAU_USD: EUR_USD's 0.0004 scaled by
// gold's measured 2022 per-minute volatility relative to EUR/USD (1.47x).
const VOLATILITY: Record<string, number> = {
  EUR_USD: 0.0004, GBP_USD: 0.0006, USD_JPY: 0.0005,
  USD_CHF: 0.0005, USD_CAD: 0.0004, AUD_USD: 0.0005,
  NZD_USD: 0.0005, EUR_GBP: 0.0003, EUR_JPY: 0.0006,
  EUR_CHF: 0.0004, EUR_CAD: 0.0005, EUR_AUD: 0.0005,
  EUR_NZD: 0.0006, GBP_JPY: 0.0008, GBP_CHF: 0.0006,
  GBP_CAD: 0.0007, GBP_AUD: 0.0007, GBP_NZD: 0.0008,
  AUD_JPY: 0.0006, AUD_CHF: 0.0005, AUD_CAD: 0.0005,
  AUD_NZD: 0.0004, NZD_JPY: 0.0006, NZD_CHF: 0.0005,
  NZD_CAD: 0.0005, CAD_JPY: 0.0006, CAD_CHF: 0.0004,
  USD_SGD: 0.0003, XAU_USD: 0.0006,
};

// ----------------------------------------------------------------
// Session-aware spread multiplier (applied to the instrument's avg_spread)
// ----------------------------------------------------------------
// Forex spreads widen when major sessions are closed.
// Tokyo:  00:00-09:00 UTC
// London: 08:00-17:00 UTC  ← tightest spreads
// New York: 13:00-22:00 UTC
// London+NY overlap (13:00-17:00 UTC) = highest liquidity = tightest spreads
// The Sydney-only hours double the spread, which is exactly the WIDE limit
// (strictly > 2x), so the mock never trips the spread gate on its own.
// ----------------------------------------------------------------
export function mockSpreadMultiplier(utcHour: number): number {
  // London + NY overlap — maximum liquidity
  if (utcHour >= 13 && utcHour < 17) return 1.0;

  // London session
  if (utcHour >= 8 && utcHour < 17) return 1.2;

  // NY session
  if (utcHour >= 13 && utcHour < 22) return 1.2;

  // Tokyo session
  if (utcHour >= 0 && utcHour < 9) return 1.5;

  // Dead zone (Sydney only, 22:00-00:00 UTC) — widest spreads
  return 2.0;
}

export type QuoteSpecLoader = () => Promise<Map<string, InstrumentQuoteSpec>>;

// MOCK_STREAM_WHEN_CLOSED: unset or "false" = no ticks for an instrument while
// its market is closed, like a real feed; "true" = tick around the clock, for
// development on weekends only (pair it with MARKET_HOURS_GATE=false on
// order-service). Any other value fails startup.
export function parseMockStreamWhenClosed(raw: string | undefined): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '' || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error(`MOCK_STREAM_WHEN_CLOSED must be "true" or "false", got "${raw}"`);
}

export class MockStreamProvider implements IForexStreamProvider {
  readonly providerName = 'MOCK';
  private readonly logger = new Logger(MockStreamProvider.name);

  // Current prices — start at BASE_PRICES, drift over time
  private readonly currentPrices: Record<string, number> = { ...BASE_PRICES };
  private specs = new Map<string, InstrumentQuoteSpec>();
  private intervalHandle: NodeJS.Timeout | null = null;
  private connected = false;

  constructor(
    private readonly loadSpecs: QuoteSpecLoader,
    private readonly now: () => Date = () => new Date(),
    private readonly random: () => number = Math.random,
    private readonly streamWhenClosed = false,
  ) {}

  async connect(
    instruments: string[],
    onTick: (tick: KafkaNormalizedTick) => void,
    onError: (err: Error) => void,
  ): Promise<void> {
    this.specs = await this.loadSpecs();
    const streamable = instruments.filter((instrument) => {
      const spec = this.specs.get(instrument);
      const ok = BASE_PRICES[instrument] !== undefined && spec !== undefined && (spec.avgSpread ?? 0) > 0;
      if (!ok) this.logger.warn(`Mock stream skips ${instrument}: no base price or avg_spread`);
      return ok;
    });

    this.connected = true;
    this.logger.log(`Mock stream connecting for ${streamable.length} instruments`);

    // Emit one tick per instrument every 500ms
    // Real OANDA sends ticks as prices change — roughly 1-4/sec per pair
    this.intervalHandle = setInterval(() => {
      try {
        for (const instrument of streamable) {
          const tick = this.generateTick(instrument);
          if (tick) onTick(tick);
        }
      } catch (err) {
        onError(err as Error);
      }
    }, 500);

    this.logger.log(`Mock stream started — emitting ticks every 500ms`);
  }

  async disconnect(): Promise<void> {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.connected = false;
    this.logger.log('Mock stream disconnected');
  }

  isConnected(): boolean {
    return this.connected;
  }

  generateTick(instrument: string): KafkaNormalizedTick | null {
    const basePrice = this.currentPrices[instrument];
    const spec = this.specs.get(instrument);
    if (!basePrice || !spec || !spec.avgSpread) return null;

    // Like a real feed: silent while the instrument's market is closed
    const now = this.now();
    if (!this.streamWhenClosed && !marketStatus(spec.kind, now).open) return null;

    // ----------------------------------------------------------------
    // Geometric Brownian Motion (GBM)
    // ----------------------------------------------------------------
    // This is the same model used in Black-Scholes options pricing.
    // Price change = current_price × volatility × random_normal_value
    //
    // Why geometric (multiplicative) not arithmetic (additive)?
    // Arithmetic: price += 0.0001 (same absolute change regardless of price)
    // Geometric:  price *= (1 + 0.0001) (proportional change)
    //
    // Geometric is correct because:
    // - A 10 pip move on EUR/USD (1.0850) = 0.092% move
    // - A 10 pip move on USD/JPY (149.50) = 0.0067% move
    // - They should have DIFFERENT absolute changes for the SAME % volatility
    // ----------------------------------------------------------------
    const vol = VOLATILITY[instrument] ?? 0.0004;
    const newMid = basePrice + basePrice * vol * this.gaussianRandom();

    // Update stored price for next tick (this creates the random walk)
    this.currentPrices[instrument] = newMid;

    // Quote at the instrument's precision (one digit past the pip). The spread is
    // rounded to whole points first and ask = bid + spread, so the quoted spread
    // is exactly avg_spread x the session multiplier (to the point).
    const decimals = priceDecimals({ pipSize: spec.pipSize });
    const spread = this.round(spec.avgSpread * mockSpreadMultiplier(now.getUTCHours()), decimals);
    const bid = this.round(newMid - spread / 2, decimals);
    const ask = this.round(bid + spread, decimals);

    return {
      pair: instrument.replace('_', '/'), // EUR_USD → EUR/USD
      instrument,
      bid,
      ask,
      mid: this.round((bid + ask) / 2, decimals + 1),
      spread: this.round(ask - bid, decimals),
      timestamp: now,
      source: 'MOCK',
    };
  }

  // ----------------------------------------------------------------
  // Box-Muller transform — generates normally distributed random numbers
  // ----------------------------------------------------------------
  // Math.random() gives uniform distribution (every value equally likely)
  // Real price moves follow normal distribution (small moves much more
  // likely than large moves — the famous bell curve)
  // Box-Muller converts two uniform randoms into one normal random.
  // ----------------------------------------------------------------
  private gaussianRandom(): number {
    let u = 0, v = 0;
    while (u === 0) u = this.random();
    while (v === 0) v = this.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }

  private round(value: number, decimals: number): number {
    return parseFloat(value.toFixed(decimals));
  }
}
