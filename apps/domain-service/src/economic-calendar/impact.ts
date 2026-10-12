import type { CalendarSource, Impact } from './official-sources';

// ForexEdge classification of an event's expected market impact. The official calendars publish no
// impact level; this fixed mapping is ours, shown in the UI as "ForexEdge classification", not source data.
//   HIGH    a policy-rate decision: an FOMC meeting (decision on its final day, scheduled or unscheduled);
//           an ECB monetary policy meeting's Day 2 (decision, followed by the press conference)
//   MEDIUM  the ECB press conference listed as its own entry
//   LOW     everything else: an FOMC notation vote, an ECB monetary policy meeting's Day 1, ECB
//           non-monetary-policy and General Council meetings
export const IMPACT_RULES = [
  'HIGH: FOMC meetings (decision on the final day); ECB monetary policy meetings, Day 2 (decision and press conference)',
  'MEDIUM: ECB press conferences listed separately',
  'LOW: FOMC notation votes; ECB monetary policy meetings, Day 1; other ECB Governing/General Council meetings',
] as const;

export function classifyImpact(source: CalendarSource, title: string): Impact {
  const t = title.toLowerCase();
  if (source === 'FOMC') return t.includes('notation vote') ? 'LOW' : 'HIGH';
  if (t.includes('non-monetary policy')) return 'LOW';
  if (t.includes('monetary policy meeting') && t.includes('day 2')) return 'HIGH';
  if (t.startsWith('press conference')) return 'MEDIUM';
  return 'LOW';
}
