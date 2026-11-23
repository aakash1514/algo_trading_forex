'use client';

import type { SeriesMarker, UTCTimestamp } from 'lightweight-charts';
import { eventWhen, THIRD_PARTY_LABEL, THIRD_PARTY_SOURCE } from '../../lib/calendar';
import type { CalendarEvent } from '../../types/replay.types';

const IMPACT_COLOR: Record<CalendarEvent['impact'], string> = { HIGH: '#ef4444', MEDIUM: '#f59e0b' };
const IMPACT_LABEL: Record<CalendarEvent['impact'], string> = { HIGH: 'High impact', MEDIUM: 'Medium impact' };

// HIGH always; MEDIUM only when the toggle is on
export function shownCalendarEvents(events: CalendarEvent[], showMedium: boolean): CalendarEvent[] {
  return events.filter((e) => e.impact === 'HIGH' || showMedium);
}

// One arrow above the bar that holds each event (the server's barTime), oldest first as
// the chart library requires
export function calendarMarkers(events: CalendarEvent[]): SeriesMarker<UTCTimestamp>[] {
  return events.map((e) => ({
    time: (Date.parse(e.barTime) / 1000) as UTCTimestamp,
    position: 'aboveBar',
    shape: 'arrowDown',
    color: IMPACT_COLOR[e.impact],
    text: e.currency,
  }));
}

// The line above the chart: what the markers are, the Medium toggle, or why there are none
export function ReplayCalendarBar({ covered, shown, showMedium, onToggleMedium }: {
  covered: boolean;
  shown: number;
  showMedium: boolean;
  onToggleMedium: () => void;
}) {
  return (
    <div data-testid="replay-calendar-bar"
      className="flex items-center gap-3 px-3 py-1 border-b border-terminal-border text-[11px] text-terminal-muted shrink-0">
      <span className="uppercase tracking-wider text-[10px]">Calendar</span>
      {covered
        ? <span data-testid="replay-calendar-count">{shown} event{shown === 1 ? '' : 's'} on the chart</span>
        : <span data-testid="replay-calendar-empty" className="text-amber-300">No calendar data for this period</span>}
      <label className="ml-auto flex items-center gap-1.5 cursor-pointer select-none">
        <input type="checkbox" checked={showMedium} onChange={onToggleMedium} data-testid="replay-calendar-medium" />
        Medium impact
      </label>
    </div>
  );
}

// The card next to the mouse for the events of the hovered bar. Actual/forecast/previous
// show only when the calendar stores them.
export function CalendarHoverCard({ events, x, y }: { events: CalendarEvent[]; x: number; y: number }) {
  return (
    <div role="tooltip" data-testid="replay-calendar-card" style={{ left: x + 12, top: y + 12 }}
      className="pointer-events-none absolute z-10 w-64 space-y-2 rounded border border-terminal-border bg-terminal-surface p-2.5 shadow-lg text-[11px]">
      {events.map((e) => {
        const when = eventWhen({ scheduledAt: e.time, timeSource: e.timeSource });
        const values = ([['Actual', e.actual], ['Forecast', e.forecast], ['Previous', e.previous]] as const)
          .filter(([, v]) => v !== null);
        return (
          <div key={e.id} data-testid="replay-calendar-event">
            <p className="font-medium text-[#e2e4e9]">{e.title}</p>
            <p className="text-terminal-muted">
              {e.currency} · <span style={{ color: IMPACT_COLOR[e.impact] }}>{IMPACT_LABEL[e.impact]}</span>
              {e.source === THIRD_PARTY_SOURCE ? ` · ${THIRD_PARTY_LABEL}` : ` · ${e.source}`}
            </p>
            <p className="text-terminal-muted">{when.date} {when.time}</p>
            {values.map(([label, v]) => <p key={label} className="text-[#e2e4e9]">{label}: {v}</p>)}
          </div>
        );
      })}
    </div>
  );
}
