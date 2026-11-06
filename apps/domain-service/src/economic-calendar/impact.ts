import type { CalendarSource, Impact } from './official-sources';

// ForexEdge classification of an event's expected market impact. The official calendars publish no
// impact level; this fixed mapping is ours, shown in the UI as "ForexEdge classification", not source data.
// Only events with a release time are stored, and each kind is a scheduled policy decision:
//   HIGH    an FOMC scheduled meeting's decision (statement on its final day);
//           an ECB monetary policy decision (Day 2 of the meeting, followed by the press conference)
export const IMPACT_RULES = [
  'HIGH: FOMC scheduled meeting decisions; ECB monetary policy decisions',
] as const;

const IMPACT_BY_SOURCE: Readonly<Record<CalendarSource, Impact>> = {
  FOMC: 'HIGH',
  ECB: 'HIGH',
};

export function classifyImpact(source: CalendarSource): Impact {
  return IMPACT_BY_SOURCE[source];
}
