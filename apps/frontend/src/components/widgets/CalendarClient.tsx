'use client';

import { useState } from 'react';
import { useGetCalendarEventsQuery } from '../../store/api/domain.api';
import { cn } from '../../lib/cn';
import { CALENDAR_CURRENCIES, CALENDAR_SOURCES, COVERAGE_NOTE, IMPACT_NOTE, eventWhen } from '../../lib/calendar';

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

const CURRENCIES = ['ALL', ...CALENDAR_CURRENCIES];
const IMPACTS    = ['ALL', 'HIGH', 'MEDIUM', 'LOW'];
const COLUMNS = ['Date', 'Currency', 'Event', 'Impact*', 'Source', 'Forecast', 'Previous', 'Actual'];

export function CalendarClient() {
  const [currency, setCurrency] = useState('ALL');
  const [impact, setImpact]     = useState('ALL');

  const { data: events = [], isLoading } = useGetCalendarEventsQuery({
    currency: currency === 'ALL' ? undefined : currency,
    impact:   impact   === 'ALL' ? undefined : impact,
  });

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

      <p className="px-4 py-2 border-b border-terminal-border text-[11px] text-terminal-muted shrink-0" data-testid="calendar-coverage">
        {COVERAGE_NOTE}
      </p>

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
                {COLUMNS.map((h) => (
                  <th key={h} className="text-left px-4 py-2.5 text-[10px] text-terminal-muted uppercase tracking-wider font-medium whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {events.map((event) => {
                const when = eventWhen(event);
                const source = event.source ? CALENDAR_SOURCES[event.source] : undefined;
                return (
                  <tr key={event.id} data-testid="calendar-event" className="border-b border-terminal-border/50 hover:bg-terminal-elevated/40 transition-colors">
                    <td className="px-4 py-2.5 tabular-nums text-terminal-muted whitespace-nowrap">
                      {when.date}
                      <span className="ml-2 text-[9px] text-terminal-muted/60">{when.time}</span>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="text-[11px] font-medium text-[#e2e4e9]">{event.currency}</span>
                    </td>
                    <td className="px-4 py-2.5 text-[#e2e4e9] max-w-md">
                      <span className="line-clamp-2">{event.title}</span>
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        title="ForexEdge classification, not source data"
                        className={cn(
                          'inline-flex items-center gap-1 text-[9px] font-medium px-1.5 py-0.5 rounded border',
                          IMPACT_COLORS[event.impact] ?? IMPACT_COLORS.LOW
                        )}
                      >
                        <span className={cn('w-1 h-1 rounded-full shrink-0', IMPACT_DOT[event.impact] ?? IMPACT_DOT.LOW)} />
                        {event.impact}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-terminal-muted whitespace-nowrap">
                      {source ? (
                        <a href={source.url} target="_blank" rel="noreferrer" className="hover:text-[#e2e4e9] underline-offset-2 hover:underline">
                          {source.attribution}
                        </a>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-terminal-muted">{event.forecast ?? '—'}</td>
                    <td className="px-4 py-2.5 tabular-nums text-terminal-muted">{event.previous ?? '—'}</td>
                    <td className="px-4 py-2.5 tabular-nums text-terminal-muted">{event.actual ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <footer className="px-4 py-2 border-t border-terminal-border text-[10px] text-terminal-muted shrink-0" data-testid="calendar-footer">
        Sources: the Board of Governors of the Federal Reserve System (federalreserve.gov) and the European Central Bank
        (ecb.europa.eu); dates as they publish them. * {IMPACT_NOTE}
      </footer>
    </div>
  );
}
