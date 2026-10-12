import type { MlBaseline, MlPooledTest, MlPrediction, MlScores } from '../types/api.types';

export const ML_DISCLAIMER = 'Historical walk-forward test, not live signals';

export const BASELINE_LABELS: Record<MlBaseline, string> = {
  logistic: 'Logistic regression',
  majority: 'Majority direction',
  persistence: 'Persistence',
  anti_persistence: 'Anti-persistence',
};

// 51.23% [49.99, 52.47]
export function formatAccuracy(s: Pick<MlScores, 'accuracy' | 'accuracy_ci95'>): string {
  const [lo, hi] = s.accuracy_ci95;
  return `${(s.accuracy * 100).toFixed(2)}% [${(lo * 100).toFixed(2)}, ${(hi * 100).toFixed(2)}]`;
}

export function formatP(p: number): string {
  return p < 0.001 ? p.toExponential(1) : p.toFixed(3);
}

export type Verdict = 'beats' | 'worse' | 'none';

// The verdict under the fixed rule, as computed by the service (Holm-adjusted)
export function verdict(t: Pick<MlPooledTest, 'beats' | 'significantly_worse'>): Verdict {
  return t.beats ? 'beats' : t.significantly_worse ? 'worse' : 'none';
}

export const VERDICT_LABELS: Record<Verdict, string> = {
  beats: 'LSTM better',
  worse: 'LSTM worse',
  none: 'No evidence of a difference',
};

// A <input type="month"> value ('2022-03') -> the inclusive calendar-day range of that month
export function monthRange(month: string): { from: string; to: string } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return null;
  const year = Number(m[1]);
  const mon = Number(m[2]);
  if (mon < 1 || mon > 12) return null;
  const last = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return { from: `${m[1]}-${m[2]}-01`, to: `${m[1]}-${m[2]}-${String(last).padStart(2, '0')}` };
}

// Hit rate over the scored bars of a month (flat or short target bars are not scored)
export function hitRate(predictions: MlPrediction[]): { scored: number; correct: number } | null {
  const scored = predictions.filter((p) => p.scored);
  if (scored.length === 0) return null;
  return { scored: scored.length, correct: scored.filter((p) => p.predicted === p.actual).length };
}
