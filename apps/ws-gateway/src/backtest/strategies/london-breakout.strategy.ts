import { IStrategy, Candle, Signal } from './strategy.interface';

export class LondonBreakoutStrategy implements IStrategy {
  name = 'london_breakout';

  generate(candles: Candle[], parameters: Record<string, number>): Signal[] {
    const breakoutPips = parameters['breakoutPips'] ?? 20;
    const sessionStartHour = parameters['sessionStartHour'] ?? 8; // 08:00 UTC = London open
    const lots = parameters['lots'] ?? 0.1;
    const pipSize = parameters['pipSize'] ?? 0.0001; // EUR/USD standard

    const signals: Signal[] = [];

    // Group candles by UTC date
    const byDay = new Map<string, Candle[]>();
    for (const candle of candles) {
      const date = new Date(candle.bucket);
      const dayKey = `${date.getUTCFullYear()}-${date.getUTCMonth()}-${date.getUTCDate()}`;
      if (!byDay.has(dayKey)) byDay.set(dayKey, []);
      byDay.get(dayKey)!.push(candle);
    }

    for (const [, dayCandles] of byDay) {
      // Tokyo session: 00:00–08:00 UTC
      const tokyoCandles = dayCandles.filter((c) => {
        const hour = new Date(c.bucket).getUTCHours();
        return hour >= 0 && hour < sessionStartHour;
      });

      if (tokyoCandles.length < 3) continue; // not enough data for this day

      const tokyoHigh = Math.max(...tokyoCandles.map((c) => c.high));
      const tokyoLow = Math.min(...tokyoCandles.map((c) => c.low));

      // London session candles: 08:00 UTC onward
      const londonCandles = dayCandles.filter((c) => {
        const hour = new Date(c.bucket).getUTCHours();
        return hour >= sessionStartHour;
      });

      let tradedToday = false;

      for (const candle of londonCandles) {
        if (tradedToday) break;

        const breakoutUp = candle.high > tokyoHigh + breakoutPips * pipSize;
        const breakoutDown = candle.low < tokyoLow - breakoutPips * pipSize;

        if (breakoutUp) {
          signals.push({
            timestamp: candle.bucket,
            action: 'BUY',
            lots,
            stopLoss: tokyoLow,
            takeProfit: tokyoHigh + (tokyoHigh - tokyoLow) * 2,
            reason: `London breakout above Tokyo high (${tokyoHigh.toFixed(5)}) + ${breakoutPips} pips`,
          });
          tradedToday = true;
        } else if (breakoutDown) {
          signals.push({
            timestamp: candle.bucket,
            action: 'SELL',
            lots,
            stopLoss: tokyoHigh,
            takeProfit: tokyoLow - (tokyoHigh - tokyoLow) * 2,
            reason: `London breakout below Tokyo low (${tokyoLow.toFixed(5)}) - ${breakoutPips} pips`,
          });
          tradedToday = true;
        }
      }
    }

    return signals;
  }
}