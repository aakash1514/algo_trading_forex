import { formatAccuracy, formatP, hitRate, monthRange, verdict } from './ml';
import type { MlPrediction } from '../types/api.types';

const row = (predicted: 'UP' | 'DOWN', actual: 'UP' | 'DOWN' | 'FLAT', scored = true): MlPrediction => ({
  barTime: '2022-03-01T09:00:00Z', targetBarTime: '2022-03-01T10:00:00Z', pUp: 0.5, predicted, actual, scored,
  model: 'EUR_USD-1h-test2022', bar: { open: 1.1, high: 1.2, low: 1.0, close: 1.1 },
});

describe('ml display helpers', () => {
  it('formats accuracy with its interval', () => {
    expect(formatAccuracy({ accuracy: 0.51234, accuracy_ci95: [0.4999, 0.52471] })).toBe('51.23% [49.99, 52.47]');
  });

  it('formats p-values', () => {
    expect(formatP(0.04321)).toBe('0.043');
    expect(formatP(0.00001234)).toBe('1.2e-5');
  });

  it('maps the service verdict', () => {
    expect(verdict({ beats: true, significantly_worse: false })).toBe('beats');
    expect(verdict({ beats: false, significantly_worse: true })).toBe('worse');
    expect(verdict({ beats: false, significantly_worse: false })).toBe('none');
  });

  it('turns a month into its inclusive day range', () => {
    expect(monthRange('2022-03')).toEqual({ from: '2022-03-01', to: '2022-03-31' });
    expect(monthRange('2020-02')).toEqual({ from: '2020-02-01', to: '2020-02-29' });
    expect(monthRange('2022-13')).toBeNull();
    expect(monthRange('')).toBeNull();
  });

  it('counts hits over scored bars only, and has no rate without them', () => {
    expect(hitRate([row('UP', 'UP'), row('UP', 'DOWN'), row('DOWN', 'FLAT', false)])).toEqual({ scored: 2, correct: 1 });
    expect(hitRate([row('UP', 'FLAT', false)])).toBeNull();
    expect(hitRate([])).toBeNull();
  });
});
