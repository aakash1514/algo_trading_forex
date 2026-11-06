// ForexFactory's own weekly calendar export: the "Weekly Export" panel on https://www.forexfactory.com/calendar
// links ICS, CSV, JSON and XML files on nfs.faireconomy.media; this is the JSON one (the page adds a changing
// "version" cache-buster, which isn't needed and would mean reading their HTML). Checked 2026-11-06:
// forexfactory.com/robots.txt has no Disallow rule; nfs.faireconomy.media/robots.txt is "User-agent: *" with an
// empty Disallow.
//
// Licensing: approved by the owner on 2026-11-06 for portfolio use; terms not confirmed for commercial use; must
// be re-checked or replaced before any client/commercial use. Never work around their bot protection: one plain
// request with the ForexEdge User-Agent, at most twice per UTC day, and a block (403, 429, a challenge page, any
// non-JSON answer) is logged and skipped, never retried or bypassed.

export const FOREXFACTORY = {
  source: 'FOREXFACTORY',
  url: 'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
  attribution: 'Forex Factory',
} as const;

// ForexFactory's impact level, stored as the calendar's HIGH/MEDIUM/LOW (labelled "ForexFactory impact" in the
// UI). Holiday and Non-Economic entries carry no impact level and are skipped.
export const FF_IMPACT: Readonly<Record<string, 'HIGH' | 'MEDIUM' | 'LOW'>> = {
  High: 'HIGH',
  Medium: 'MEDIUM',
  Low: 'LOW',
};
export const FF_SKIPPED_IMPACTS = ['Holiday', 'Non-Economic'] as const;

// ForexFactory's rows for the FOMC and ECB policy decisions, which the calendar already has from the official
// sources: dropped by exact currency and title.
export const FF_DUPLICATE_TITLES: Readonly<Record<string, readonly string[]>> = {
  USD: ['Federal Funds Rate', 'FOMC Statement', 'FOMC Press Conference', 'FOMC Economic Projections'],
  EUR: ['Main Refinancing Rate', 'Monetary Policy Statement', 'ECB Press Conference'],
};
