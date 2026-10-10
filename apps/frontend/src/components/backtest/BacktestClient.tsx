'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useAppSelector } from '../../store';
import {
  useGetBacktestsQuery,
  useRunBacktestMutation,
  useDeleteBacktestMutation,
} from '../../store/api/backtest.api';
import { cn } from '../../lib/cn';
import { MAJOR_PAIRS, PAIR_DISPLAY } from '../../lib/constants';
import React from 'react';

// Strategy ids are the backend's (SubmitBacktestDto / StrategyRegistry); labels are display only
const STRATEGIES = [
  { id: 'ma_crossover', label: 'MA Crossover' },
  { id: 'london_breakout', label: 'London Breakout' },
] as const;

// Backtests run on the imported Dukascopy history (2010-2022)
const HISTORY_FIRST_DAY = '2010-01-01';
const HISTORY_LAST_DAY = '2022-12-30';

const schema = z.object({
  strategyName: z.enum(['ma_crossover', 'london_breakout']),
  instrument:   z.string().min(1),
  from:         z.string().min(1),
  to:           z.string().min(1),
  fastPeriod:   z.number().min(1).max(50).optional(),
  slowPeriod:   z.number().min(2).max(200).optional(),
});

type FormData = z.infer<typeof schema>;

const STATUS_COLORS: Record<string, string> = {
  COMPLETED: 'text-accent-green bg-accent-green/10',
  RUNNING:   'text-accent-blue bg-accent-blue/10',
  QUEUED:    'text-yellow-400 bg-yellow-400/10',
  FAILED:    'text-accent-red bg-accent-red/10',
};

function MetricCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-terminal-bg rounded p-3">
      <p className="text-[10px] text-terminal-muted uppercase tracking-wider mb-1">{label}</p>
      <p className={cn('text-[15px] font-medium tabular-nums', color ?? 'text-[#e2e4e9]')}>{value}</p>
    </div>
  );
}

export function BacktestClient() {
  const accessToken = useAppSelector((s) => s.auth.accessToken);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const { data: runs = [], isLoading } = useGetBacktestsQuery(undefined, {
    skip: !accessToken,
    pollingInterval: 5000,
  });
  const [runBacktest, { isLoading: isSubmitting }] = useRunBacktestMutation();
  const [deleteBacktest] = useDeleteBacktestMutation();

  const { register, handleSubmit, watch } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      strategyName: 'ma_crossover',
      instrument:   'EUR_USD',
      from:         '2022-01-01',
      to:           '2022-12-30',
      fastPeriod:   10,
      slowPeriod:   30,
    },
  });

  const strategy = watch('strategyName');

  async function onSubmit(data: FormData) {
    setSubmitError(null);
    try {
      await runBacktest({
        strategyName: data.strategyName,
        instrument:   data.instrument,
        fromDate:     data.from,
        toDate:       data.to,
        timeframe:    '1h',
        parameters: data.strategyName === 'ma_crossover' ? {
          ...(data.fastPeriod && { fastPeriod: data.fastPeriod }),
          ...(data.slowPeriod && { slowPeriod: data.slowPeriod }),
        } : {},
      }).unwrap();
    } catch (err: unknown) {
      // e.g. a range outside the history: the API names the covered range
      const message = (err as { data?: { message?: string | string[] } } | undefined)?.data?.message;
      setSubmitError(Array.isArray(message) ? message.join(', ') : message ?? 'Backtest could not be started');
    }
  }

  async function handleDelete(runId: string) {
    await deleteBacktest(runId).unwrap();
    if (selectedId === runId) setSelectedId(null);
  }

  const inputClass = 'w-full bg-terminal-elevated border border-terminal-border rounded px-2.5 py-1.5 text-[12px] text-[#e2e4e9] focus:outline-none focus:border-accent-blue transition-colors';

  return (
    <div className="h-full flex overflow-hidden">

      {/* Left: form */}
      <div className="w-72 shrink-0 border-r border-terminal-border flex flex-col bg-terminal-surface">
        <div className="p-4">
          <p className="text-[10px] font-medium text-terminal-muted uppercase tracking-wider mb-3">
            New backtest
          </p>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-2.5">
            <div>
              <label className="block text-[9px] text-terminal-muted uppercase tracking-wider mb-1">Strategy</label>
              <select {...register('strategyName')} className={inputClass}>
                {STRATEGIES.map((s) => (
                  <option key={s.id} value={s.id}>{s.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[9px] text-terminal-muted uppercase tracking-wider mb-1">Instrument</label>
              <select {...register('instrument')} className={inputClass}>
                {MAJOR_PAIRS.map((p) => (
                  <option key={p} value={p}>{PAIR_DISPLAY[p]}</option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[9px] text-terminal-muted uppercase tracking-wider mb-1">From</label>
                <input {...register('from')} type="date" min={HISTORY_FIRST_DAY} max={HISTORY_LAST_DAY} className={inputClass} />
              </div>
              <div>
                <label className="block text-[9px] text-terminal-muted uppercase tracking-wider mb-1">To</label>
                <input {...register('to')} type="date" min={HISTORY_FIRST_DAY} max={HISTORY_LAST_DAY} className={inputClass} />
              </div>
            </div>
            {strategy === 'ma_crossover' && (
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[9px] text-terminal-muted uppercase tracking-wider mb-1">Fast</label>
                  <input {...register('fastPeriod', { valueAsNumber: true })} type="number" className={inputClass} />
                </div>
                <div>
                  <label className="block text-[9px] text-terminal-muted uppercase tracking-wider mb-1">Slow</label>
                  <input {...register('slowPeriod', { valueAsNumber: true })} type="number" className={inputClass} />
                </div>
              </div>
            )}
            {submitError && (
              <p className="text-[11px] text-accent-red bg-accent-red/10 rounded px-2.5 py-1.5">{submitError}</p>
            )}
            <button type="submit" disabled={isSubmitting}
              className={cn(
                'w-full py-2 rounded text-[12px] font-medium transition-all',
                'bg-accent-blue/10 border border-accent-blue/30 text-accent-blue',
                'hover:bg-accent-blue/20 disabled:opacity-50 disabled:cursor-not-allowed'
              )}>
              {isSubmitting ? 'Queuing...' : 'Run backtest'}
            </button>
          </form>
        </div>
      </div>

      {/* Right: results */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="bg-terminal-surface border border-terminal-border rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-terminal-border">
            <p className="text-[10px] font-medium text-terminal-muted uppercase tracking-wider">
              Backtest runs ({runs.length})
            </p>
          </div>

          {isLoading ? (
            <div className="px-4 py-6 text-[12px] text-terminal-muted">Loading...</div>
          ) : runs.length === 0 ? (
            <div className="px-4 py-6 text-[12px] text-terminal-muted">No backtests yet.</div>
          ) : (
            <table className="w-full text-[11px]">
              <thead>
                <tr className="border-b border-terminal-border">
                  {['Strategy', 'Pair', 'Status', 'Date', 'Net profit', ''].map((h) => (
                    <th key={h} className="text-left px-4 py-2 text-[10px] text-terminal-muted uppercase tracking-wider font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                <React.Fragment key={run.id}>
                    <tr
                      key={run.id}
                      onClick={() => setSelectedId(selectedId === run.id ? null : run.id)}
                      className={cn(
                        'border-b border-terminal-border/50 cursor-pointer transition-colors select-none',
                        selectedId === run.id ? 'bg-accent-blue/5' : 'hover:bg-terminal-elevated/60'
                      )}
                    >
                      <td className="px-4 py-2.5 font-medium text-[#e2e4e9]">
                        {STRATEGIES.find((s) => s.id === run.strategyName)?.label ?? run.strategyName}
                      </td>
                      <td className="px-4 py-2.5 text-terminal-muted">
                        {run.instrument?.replace('_', '/')}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={cn('text-[9px] font-medium px-1.5 py-0.5 rounded uppercase', STATUS_COLORS[run.status] ?? '')}>
                          {run.status}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-terminal-muted tabular-nums">
                        {new Date(run.createdAt).toLocaleDateString()}
                      </td>
                      <td className={cn('px-4 py-2.5 font-medium tabular-nums',
                        (Number.parseFloat(run.totalPnl ?? '0') ?? 0) >= 0 ? 'text-accent-green' : 'text-accent-red'
                      )}>
                        ${Number.parseFloat(run.totalPnl ?? '0').toFixed(2)}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDelete(run.id); }}
                          className="text-[10px] text-terminal-muted hover:text-accent-red transition-colors"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>

                    {/* Expanded metrics row */}
                    {selectedId === run.id && (
                      <tr key={`${run.id}-detail`} className="border-b border-terminal-border bg-terminal-elevated/20">
                        <td colSpan={6} className="px-4 py-4">
                          {run.status === 'COMPLETED' && run.totalTrades !== null ? (
                            <>
                              <p className="text-[10px] font-medium text-terminal-muted uppercase tracking-wider mb-3">
                                Performance metrics
                              </p>
                              <div className="grid grid-cols-6 gap-2">
                                <MetricCard
                                  label="Net profit"
                                  value={`$${Number.parseFloat(run.totalPnl ?? '0').toFixed(2)}`}
                                  color={Number.parseFloat(run.totalPnl ?? '0') >= 0 ? 'text-accent-green' : 'text-accent-red'}
                                />
                                <MetricCard
                                  label="Win rate"
                                  value={`${(Number.parseFloat(run.winRate ?? '0') * 100).toFixed(1)}%`}
                                  color={Number.parseFloat(run.winRate ?? '0') >= 0.5 ? 'text-accent-green' : 'text-accent-red'}
                                />
                                <MetricCard label="Total trades" value={String(run.totalTrades ?? 0)} />
                                <MetricCard
                                  label="Profit factor"
                                  value={Number.parseFloat(run.profitFactor ?? '0').toFixed(2)}
                                  color={Number.parseFloat(run.profitFactor ?? '0') >= 1 ? 'text-accent-green' : 'text-accent-red'}
                                />
                                <MetricCard
                                  label="Sharpe ratio"
                                  value={Number.parseFloat(run.sharpeRatio ?? '0').toFixed(2)}
                                  color={Number.parseFloat(run.sharpeRatio ?? '0') >= 1 ? 'text-accent-green' : 'text-accent-red'}
                                />
                                <MetricCard
                                  label="Max drawdown"
                                  value={`${Number.parseFloat(run.maxDrawdownPct ?? '0').toFixed(1)}%`}
                                  color="text-accent-red"
                                />
                              </div>
                            </>
                          ) : run.status === 'FAILED' ? (
                            <p className="text-[12px] text-terminal-muted">
                              {run.errorMessage ?? 'Backtest failed'}
                            </p>
                          ) : (
                            <p className="text-[12px] text-terminal-muted">
                              Status: {run.status}
                            </p>
                          )}
                        </td>
                      </tr>
                    )}
                   </React.Fragment>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}