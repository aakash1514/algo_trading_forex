import { IStrategy, Candle, Signal } from './strategy.interface';

export class MovingAverageCrossoverStrategy implements IStrategy {
  name = 'ma_crossover';

  generate(candles: Candle[], parameters: Record<string, number>): Signal[] {
    const fastPeriod = parameters['fastPeriod'] ?? 10;
    const slowPeriod = parameters['slowPeriod'] ?? 20;
    const lots = parameters['lots'] ?? 0.1;

    if (candles.length < slowPeriod + 1) return [];

    const signals: Signal[] = [];
    let position: 'LONG' | 'SHORT' | null = null;

    for (let i = slowPeriod; i < candles.length; i++) {
      const fastNow = this.sma(candles, i, fastPeriod);
      const slowNow = this.sma(candles, i, slowPeriod);
      const fastPrev = this.sma(candles, i - 1, fastPeriod);
      const slowPrev = this.sma(candles, i - 1, slowPeriod);

      const crossedAbove = fastPrev <= slowPrev && fastNow > slowNow;
      const crossedBelow = fastPrev >= slowPrev && fastNow < slowNow;

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

  private sma(candles: Candle[], endIndex: number, period: number): number {
    const slice = candles.slice(endIndex - period + 1, endIndex + 1);
    return slice.reduce((sum, c) => sum + c.close, 0) / period;
  }
}