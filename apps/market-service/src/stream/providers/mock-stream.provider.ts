import { Logger } from '@nestjs/common';
import { IForexStreamProvider } from '../interfaces/stream-provider.interface';
import { NormalizedTick as KafkaNormalizedTick } from '@forexedge/kafka';

// Base prices for all 28 pairs — realistic mid prices as of 2024
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
};

const BASE_SPREADS: Record<string, number> = {
  EUR_USD: 0.0001, GBP_USD: 0.0002, USD_JPY: 0.020,
  USD_CHF: 0.0002, USD_CAD: 0.0002, AUD_USD: 0.0002,
  NZD_USD: 0.0003, EUR_GBP: 0.0002, EUR_JPY: 0.030,
  EUR_CHF: 0.0003, EUR_CAD: 0.0003, EUR_AUD: 0.0004,
  EUR_NZD: 0.0005, GBP_JPY: 0.040,  GBP_CHF: 0.0004,
  GBP_CAD: 0.0005, GBP_AUD: 0.0005, GBP_NZD: 0.0006,
  AUD_JPY: 0.030,  AUD_CHF: 0.0004, AUD_CAD: 0.0004,
  AUD_NZD: 0.0004, NZD_JPY: 0.030,  NZD_CHF: 0.0004,
  NZD_CAD: 0.0004, CAD_JPY: 0.030,  CAD_CHF: 0.0003,
  USD_SGD: 0.0005,
};

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
  USD_SGD: 0.0003,
};

export class MockStreamProvider implements IForexStreamProvider {
  readonly providerName = 'MOCK';
  private readonly logger = new Logger(MockStreamProvider.name);

  // Current prices — start at BASE_PRICES, drift over time
  private readonly currentPrices: Record<string, number> = { ...BASE_PRICES };
  private intervalHandle: NodeJS.Timeout | null = null;
  private connected = false;

  async connect(
    instruments: string[],
    onTick: (tick: KafkaNormalizedTick) => void,
    onError: (err: Error) => void,
  ): Promise<void> {
    this.connected = true;
    this.logger.log(`Mock stream connecting for ${instruments.length} instruments`);

    // Emit one tick per instrument every 500ms
    // Real OANDA sends ticks as prices change — roughly 1-4/sec per pair
    this.intervalHandle = setInterval(() => {
      try {
        for (const instrument of instruments) {
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

  private generateTick(instrument: string): KafkaNormalizedTick | null {
    const basePrice = this.currentPrices[instrument];
    if (!basePrice) return null;

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
    const randomNormal = this.gaussianRandom();
    const priceChange = basePrice * vol * randomNormal;
    const newMid = basePrice + priceChange;

    // Update stored price for next tick (this creates the random walk)
    this.currentPrices[instrument] = newMid;

    // Session multiplier — wider spreads outside main sessions
    const sessionMultiplier = this.getSessionMultiplier();
    const spread = (BASE_SPREADS[instrument] ?? 0.0002) * sessionMultiplier;

    const bid = newMid - spread / 2;
    const ask = newMid + spread / 2;

    // Convert instrument to pair format (EUR_USD → EUR/USD)
    const pair = instrument.replace('_', '/');

    return {
      pair,
      instrument,
      bid: this.round(bid, instrument),
      ask: this.round(ask, instrument),
      mid: this.round(newMid, instrument),
      spread: this.round(spread, instrument),
      timestamp: new Date(),
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
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }

  // ----------------------------------------------------------------
  // Session-aware spread multiplier
  // ----------------------------------------------------------------
  // Forex spreads widen when major sessions are closed.
  // Tokyo:  00:00-09:00 UTC
  // London: 08:00-17:00 UTC  ← tightest spreads
  // New York: 13:00-22:00 UTC
  // London+NY overlap (13:00-17:00 UTC) = highest liquidity = tightest spreads
  // ----------------------------------------------------------------
  private getSessionMultiplier(): number {
    const hour = new Date().getUTCHours();

    // London + NY overlap — maximum liquidity
    if (hour >= 13 && hour < 17) return 1.0;

    // London session
    if (hour >= 8 && hour < 17) return 1.2;

    // NY session
    if (hour >= 13 && hour < 22) return 1.2;

    // Tokyo session
    if (hour >= 0 && hour < 9) return 1.5;

    // Dead zone (Sydney only, 22:00-00:00 UTC) — widest spreads
    return 2.0;
  }

  // ----------------------------------------------------------------
  // Rounding to correct decimal places
  // ----------------------------------------------------------------
  // JPY pairs: 3 decimal places (price ~149.500)
  // All others: 5 decimal places (price ~1.08500)
  // This matches the pip_size in your instruments table
  // ----------------------------------------------------------------
  private round(value: number, instrument: string): number {
    const isJpy = instrument.endsWith('_JPY') || instrument.startsWith('JPY_');
    return parseFloat(value.toFixed(isJpy ? 3 : 5));
  }
}