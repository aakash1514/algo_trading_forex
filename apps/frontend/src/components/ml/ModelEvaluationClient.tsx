'use client';

import { useMemo, useState } from 'react';
import { useAppSelector } from '../../store';
import { useGetMlEvaluationQuery, useGetMlPredictionsQuery } from '../../store/api/ml.api';
import { MAJOR_PAIRS, PAIR_DISPLAY } from '../../lib/constants';
import {
  BASELINE_LABELS,
  ML_DISCLAIMER,
  VERDICT_LABELS,
  formatAccuracy,
  formatP,
  hitRate,
  monthRange,
  verdict,
} from '../../lib/ml';
import { cn } from '../../lib/cn';
import type { MlModelKey } from '../../types/api.types';
import { PredictionChart } from './PredictionChart';

const MODEL_COLUMNS: { key: MlModelKey; label: string }[] = [
  { key: 'lstm', label: 'LSTM' },
  { key: 'logistic', label: 'Logistic' },
  { key: 'majority', label: 'Majority' },
  { key: 'persistence', label: 'Persistence' },
  { key: 'anti_persistence', label: 'Anti-persistence' },
];
const VERDICT_STYLES = {
  beats: 'text-accent-green bg-accent-green/10',
  worse: 'text-accent-red bg-accent-red/10',
  none: 'text-terminal-muted bg-terminal-elevated',
} as const;

const th = 'text-left px-3 py-2 text-[10px] text-terminal-muted uppercase tracking-wider font-medium';
const td = 'px-3 py-2 tabular-nums';
const panel = 'bg-terminal-surface border border-terminal-border rounded-lg overflow-hidden';
const panelTitle = 'px-4 py-3 border-b border-terminal-border text-[10px] font-medium text-terminal-muted uppercase tracking-wider';

export function ModelEvaluationClient() {
  const accessToken = useAppSelector((s) => s.auth.accessToken);
  const { data, isLoading, error } = useGetMlEvaluationQuery(undefined, { skip: !accessToken });
  const [pair, setPair] = useState<string>('EUR_USD');
  const [month, setMonth] = useState('2022-03');
  const range = monthRange(month);
  const { currentData: preds, isFetching } = useGetMlPredictionsQuery(
    { instrument: pair, from: range?.from ?? '', to: range?.to ?? '' },
    { skip: !accessToken || !range },
  );
  const hits = useMemo(() => (preds ? hitRate(preds.predictions) : null), [preds]);

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4">
      <div className="rounded-lg border border-yellow-400/30 bg-yellow-400/10 px-4 py-2.5 text-[12px] text-yellow-300" role="note">
        <span className="font-medium uppercase tracking-wider">{ML_DISCLAIMER}.</span>{' '}
        LSTM next-hour direction models evaluated walk-forward on the Dukascopy history (test years 2016-2022); each
        prediction comes from a model that never saw that year.
      </div>

      {isLoading && <p className="text-[12px] text-terminal-muted">Loading evaluation...</p>}
      {error && <p className="text-[12px] text-accent-red">The ML service is unavailable.</p>}

      {data && (
        <>
          <section className={panel}>
            <p className={panelTitle}>Pooled 2016-2022: LSTM vs each baseline</p>
            <p className="px-4 pt-3 text-[11px] text-terminal-muted">
              Target: {data.target}. Rule (fixed before training): {data.rule}. Accuracy with 95% interval.
            </p>
            <table className="w-full text-[11px] mt-2">
              <thead>
                <tr className="border-b border-terminal-border">
                  {['Pair', 'Baseline', 'Samples', 'LSTM accuracy', 'Baseline accuracy', 'p (raw)', 'p (Holm)', 'Verdict'].map((h) => (
                    <th key={h} className={th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.pooled.map((t) => {
                  const v = verdict(t);
                  return (
                    <tr key={`${t.pair}-${t.baseline}`} className="border-b border-terminal-border/50">
                      <td className={cn(td, 'text-[#e2e4e9] font-medium')}>{t.pair}</td>
                      <td className={td}>{BASELINE_LABELS[t.baseline]}</td>
                      <td className={td}>{t.n.toLocaleString()}</td>
                      <td className={td}>{formatAccuracy({ accuracy: t.lstm_accuracy, accuracy_ci95: t.lstm_ci95 })}</td>
                      <td className={td}>
                        {formatAccuracy({ accuracy: t.baseline_accuracy, accuracy_ci95: t.baseline_ci95 })}
                      </td>
                      <td className={td}>{formatP(t.p_raw)}</td>
                      <td className={td}>{formatP(t.p_holm)}</td>
                      <td className={td}>
                        <span className={cn('text-[10px] px-1.5 py-0.5 rounded', VERDICT_STYLES[v])}>{VERDICT_LABELS[v]}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="px-4 py-3 text-[11px] text-terminal-muted">
              Accuracy needed just to cover the spread:{' '}
              {data.breakEven
                .map((b) => `${b.pair} ${(b.break_even_accuracy * 100).toFixed(1)}%`)
                .join(' · ')}
              . Independent SQL check of samples and baselines: {data.sqlCheck.allMatch ? 'all' : 'NOT all'}{' '}
              {data.sqlCheck.pairYears} pair-years match.
            </p>
          </section>

          <section className={panel}>
            <p className={panelTitle}>Per pair and test year (accuracy, 95% interval)</p>
            <table className="w-full text-[11px]">
              <thead>
                <tr className="border-b border-terminal-border">
                  <th className={th}>Pair</th>
                  <th className={th}>Year</th>
                  <th className={th}>Samples</th>
                  {MODEL_COLUMNS.map((c) => (
                    <th key={c.key} className={th}>{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.perYear.map((r) => (
                  <tr key={`${r.instrument}-${r.testYear}`} className="border-b border-terminal-border/50">
                    <td className={cn(td, 'text-[#e2e4e9] font-medium')}>{PAIR_DISPLAY[r.instrument] ?? r.instrument}</td>
                    <td className={td}>{r.testYear}</td>
                    <td className={td}>{r.test.lstm.n.toLocaleString()}</td>
                    {MODEL_COLUMNS.map((c) => (
                      <td key={c.key} className={td}>{formatAccuracy(r.test[c.key])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}

      <section className={panel}>
        <p className={panelTitle}>One historical month: predicted vs actual direction per H1 bar</p>
        <div className="flex items-end gap-3 px-4 py-3">
          <label className="text-[10px] text-terminal-muted uppercase tracking-wider">
            Pair
            <select
              value={pair}
              onChange={(e) => setPair(e.target.value)}
              className="block mt-1 bg-terminal-elevated border border-terminal-border rounded px-2 py-1 text-[12px] text-[#e2e4e9]"
            >
              {MAJOR_PAIRS.map((p) => (
                <option key={p} value={p}>{PAIR_DISPLAY[p]}</option>
              ))}
            </select>
          </label>
          <label className="text-[10px] text-terminal-muted uppercase tracking-wider">
            Month (test years only)
            <input
              type="month"
              value={month}
              min="2016-01"
              max="2022-12"
              onChange={(e) => setMonth(e.target.value)}
              className="block mt-1 bg-terminal-elevated border border-terminal-border rounded px-2 py-1 text-[12px] text-[#e2e4e9]"
            />
          </label>
          <p className="text-[11px] text-terminal-muted pb-1" data-testid="month-hit-rate">
            {isFetching
              ? 'Loading...'
              : hits
                ? `${hits.correct} of ${hits.scored} scored bars right (${((hits.correct / hits.scored) * 100).toFixed(1)}%)`
                : 'No scored bars'}
          </p>
        </div>
        <p className="px-4 text-[11px] text-terminal-muted">
          Candles: each bar&apos;s mid OHLC. Arrows: the predicted direction, green when it matched the bar&apos;s open-to-close
          move, red when it didn&apos;t, grey when the bar isn&apos;t scored (flat or under 30 minutes). {ML_DISCLAIMER}.
        </p>
        <div className="p-4">
          {preds && preds.predictions.length > 0 ? (
            <PredictionChart pair={pair} predictions={preds.predictions} />
          ) : (
            !isFetching && <p className="text-[12px] text-terminal-muted">No bars in this month.</p>
          )}
        </div>
      </section>
    </div>
  );
}
