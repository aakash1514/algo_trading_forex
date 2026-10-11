import { IStrategy, Candle, Signal } from './strategy.interface';

export class MovingAverageCrossoverStrategy implements IStrategy {
  name = 'ma_crossover';

  generate(candles: Candle[], parameters: Record<string, number>): Signal[] {
    const fastPeriod = parameters['fastPeriod'] ?? 10;
    const slowPeriod = parameters['slowPeriod'] ?? 20;
    const lots = parameters['lots'] ?? 0.1;

    if (!Number.isInteger(fastPeriod) || !Number.isInteger(slowPeriod) || fastPeriod < 1 || slowPeriod < 1) {
      throw new Error(`MA periods must be positive integers (fast ${fastPeriod}, slow ${slowPeriod})`);
    }
    if (candles.length < slowPeriod + 1) return [];

    // Exact SMAs: the mid close doubled, bid.close + ask.close, is a whole number
    // of points, so prefix sums are exact integers and
    //   SMA_fast > SMA_slow  <=>  sum_fast x slowPeriod > sum_slow x fastPeriod
    // compares without any rounding (no float near-ties).
    const prefix = [0];
    for (const c of candles) prefix.push(prefix[prefix.length - 1] + c.bid.close + c.ask.close);
    if (!Number.isSafeInteger(prefix[prefix.length - 1])) throw new Error('mid sums exceed the exact integer range');
    const sum = (end: number, period: number) => prefix[end + 1] - prefix[end + 1 - period];
    // sign of SMA_fast - SMA_slow at bar i
    const side = (i: number) => Math.sign(sum(i, fastPeriod) * slowPeriod - sum(i, slowPeriod) * fastPeriod);

    const signals: Signal[] = [];
    let position: 'LONG' | 'SHORT' | null = null;

    for (let i = slowPeriod; i < candles.length; i++) {
      const prev = side(i - 1);
      const now = side(i);
      const crossedAbove = prev <= 0 && now > 0;
      const crossedBelow = prev >= 0 && now < 0;

      if (crossedAbove && position !== 'LONG') {
        if (position === 'SHORT') {
          signals.push({
            timestamp: candles[i].bucket,
            action: 'CLOSE_SHORT',
            lots,
            reason: 'Fast MA crossed above slow MA — close short',
          });
        }
        signals.push({
          timestamp: candles[i].bucket,
          action: 'BUY',
          lots,
          reason: `Fast MA(${fastPeriod}) crossed above Slow MA(${slowPeriod})`,
        });
        position = 'LONG';
      }

      if (crossedBelow && position !== 'SHORT') {
        if (position === 'LONG') {
          signals.push({
            timestamp: candles[i].bucket,
            action: 'CLOSE_LONG',
            lots,
            reason: 'Fast MA crossed below slow MA — close long',
          });
        }
        signals.push({
          timestamp: candles[i].bucket,
          action: 'SELL',
          lots,
          reason: `Fast MA(${fastPeriod}) crossed below Slow MA(${slowPeriod})`,
        });
        position = 'SHORT';
      }
    }

    return signals;
  }
}