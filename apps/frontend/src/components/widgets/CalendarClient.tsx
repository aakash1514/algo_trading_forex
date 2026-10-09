'use client';

import { useState } from 'react';
import { useGetCalendarEventsQuery } from '../../store/api/domain.api';
import { cn } from '../../lib/cn';

const IMPACT_COLORS: Record<string, string> = {
  HIGH:   'text-accent-red bg-accent-red/10 border-accent-red/20',
  MEDIUM: 'text-yellow-400 bg-yellow-400/10 border-yellow-400/20',
  LOW:    'text-terminal-muted bg-terminal-elevated border-terminal-border',
};

const IMPACT_DOT: Record<string, string> = {
  HIGH:   'bg-accent-red',
  MEDIUM: 'bg-yellow-400',
  LOW:    'bg-terminal-muted',
};

const CURRENCIES = ['ALL', 'USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD'];
const IMPACTS    = ['ALL', 'HIGH', 'MEDIUM', 'LOW'];

export function CalendarClient() {
  const [currency, setCurrency] = useState('ALL');
  const [impact, setImpact]     = useState('ALL');

  const { data: events = [], isLoading } = useGetCalendarEventsQuery({
    currency: currency === 'ALL' ? undefined : currency,
    impact:   impact   === 'ALL' ? undefined : impact,
  });

  const now = new Date();

  function isUpcoming(dateStr: string) {
    const diff = new Date(dateStr).getTime() - now.getTime();
    return diff > 0 && diff < 2 * 60 * 60 * 1000; // within next 2 hours
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">

      {/* Filters */}
      <div className="flex items-center gap-6 px-4 py-3 border-b border-terminal-border bg-terminal-surface shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-terminal-muted uppercase tracking-wider">Currency</span>
          <div className="flex gap-1">
            {CURRENCIES.map((c) => (
              <button
                key={c}
                onClick={() => setCurrency(c)}
                className={cn(
                  'px-2 py-0.5 text-[10px] rounded transition-colors',
                  currency === c
                    ? 'bg-accent-blue/10 text-accent-blue border border-accent-blue/30'
                    : 'text-terminal-muted hover:text-[#e2e4e9]'
                )}
              >
                {c}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[10px] text-terminal-muted uppercase tracking-wider">Impact</span>
          <div className="flex gap-1">
            {IMPACTS.map((i) => (
              <button
                key={i}
                onClick={() => setImpact(i)}
                className={cn(
                  'px-2 py-0.5 text-[10px] rounded transition-colors',
                  impact === i
                    ? 'bg-accent-blue/10 text-accent-blue border border-accent-blue/30'
                    : 'text-terminal-muted hover:text-[#e2e4e9]'
                )}
              >
                {i}
              </button>
            ))}
          </div>
        </div>

        <span className="ml-auto text-[10px] text-terminal-muted">
          {events.length} events
        </span>
      </div>

      {/* Events table */}
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex items-center justify-center h-32">
            <p className="text-[12px] text-terminal-muted">Loading events...</p>
          </div>
        ) : events.length === 0 ? (
          <div className="flex items-center justify-center h-32">
            <p className="text-[12px] text-terminal-muted">No events found</p>
          </div>
        ) : (
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 bg-terminal-surface z-10">
              <tr className="border-b border-terminal-border">
                {['Time', 'Currency', 'Event', 'Impact', 'Forecast', 'Previous', 'Actual'].map((h) => (
                  <th key={h} className="text-left px-4 py-2.5 text-[10px] text-terminal-muted uppercase tracking-wider font-medium whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {events.map((event: any) => {
                const upcoming = isUpcoming(event.scheduledAt);
                return (
                  <tr
                    key={event.id}
                    className={cn(
                      'border-b border-terminal-border/50 transition-colors',
                      upcoming ? 'bg-accent-blue/5' : 'hover:bg-terminal-elevated/40'
                    )}
                  >
                    <td className="px-4 py-2.5 tabular-nums text-terminal-muted whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        {upcoming && (
                          <div className="w-1.5 h-1.5 rounded-full bg-accent-blue animate-pulse shrink-0" />
                        )}
                        {new Date(event.scheduledAt).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                        <span className="text-[9px] text-terminal-muted/60">
                          {new Date(event.scheduledAt).toLocaleDateString([], {
                            month: 'short',
                            day: 'numeric',
                          })}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="text-[11px] font-medium text-[#e2e4e9]">{event.currency}</span>
                    </td>
                    <td className="px-4 py-2.5 text-[#e2e4e9] max-w-xs">
                      <span className="line-clamp-1">{event.title}</span>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={cn(
                        'inline-flex items-center gap-1 text-[9px] font-medium px-1.5 py-0.5 rounded border',
                        IMPACT_COLORS[event.impact] ?? IMPACT_COLORS.LOW
                      )}>
                        <span className={cn('w-1 h-1 rounded-full shrink-0', IMPACT_DOT[event.impact] ?? IMPACT_DOT.LOW)} />
                        {event.impact}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-terminal-muted">
                      {event.forecast ?? '—'}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-terminal-muted">
                      {event.previous ?? '—'}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums font-medium">
                      {event.actual ? (
                        <span className="text-accent-green">{event.actual}</span>
                      ) : (
                        <span className="text-terminal-muted">Pending</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}