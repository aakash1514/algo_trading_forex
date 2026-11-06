// The economic-calendar warning window around an order (gate 5): an event warns when its UTC time is from
// 30 minutes before to 30 minutes after the order, both ends inclusive. Event times are UTC instants
// ('official' or 'expected', treated the same), so the window never depends on a time zone or DST.
export const CALENDAR_WARNING_WINDOW_MS = 30 * 60 * 1000;

export function calendarWarningWindow(orderAt: Date): { windowStart: Date; windowEnd: Date } {
  const t = orderAt.getTime();
  if (Number.isNaN(t)) throw new Error('Invalid order time');
  return { windowStart: new Date(t - CALENDAR_WARNING_WINDOW_MS), windowEnd: new Date(t + CALENDAR_WARNING_WINDOW_MS) };
}
