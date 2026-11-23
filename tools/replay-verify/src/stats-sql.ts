// The replay statistics of one session, computed independently in SQL from
// replay_positions: no code shared with replay-service's replay-stats.ts. Window
// functions give the closed-trade balance and its running peak (in exit_time, id
// order, the peak starting at the starting balance); every ratio is Postgres
// round(numeric, 2) (half away from zero); money comes back with 2 decimals.
// Used by npm run replay:verify (each replayed session's /stats must equal it to the
// cent) and by replay-service's DB test.

export const STATS_SQL = `
  WITH s AS (SELECT starting_balance FROM replay_sessions WHERE id = $1),
  t AS (
    SELECT p.realized_pnl_usd AS pnl, p.exit_time, p.id
      FROM replay_positions p WHERE p.session_id = $1 AND p.status = 'CLOSED'),
  b AS (
    SELECT pnl, exit_time, id,
           (SELECT starting_balance FROM s) + sum(pnl) OVER (ORDER BY exit_time, id ROWS UNBOUNDED PRECEDING) AS bal
      FROM t),
  d AS (
    SELECT pnl, bal,
           greatest((SELECT starting_balance FROM s),
                    max(bal) OVER (ORDER BY exit_time, id ROWS UNBOUNDED PRECEDING)) AS peak
      FROM b)
  SELECT
    count(*)::int                                                         AS trades,
    (count(*) FILTER (WHERE pnl > 0))::int                                AS wins,
    (count(*) FILTER (WHERE pnl < 0))::int                                AS losses,
    (count(*) FILTER (WHERE pnl = 0))::int                                AS breakeven,
    CASE WHEN count(*) = 0 THEN NULL
         ELSE round((count(*) FILTER (WHERE pnl > 0))::numeric * 100 / count(*), 2) END::numeric(10, 2)::text
                                                                          AS win_rate_pct,
    COALESCE(sum(pnl), 0)::numeric(16, 2)::text                           AS net_pnl_usd,
    COALESCE(sum(pnl) FILTER (WHERE pnl > 0), 0)::numeric(16, 2)::text    AS gross_profit_usd,
    COALESCE(sum(pnl) FILTER (WHERE pnl < 0), 0)::numeric(16, 2)::text    AS gross_loss_usd,
    CASE WHEN sum(pnl) FILTER (WHERE pnl < 0) IS NULL THEN NULL
         ELSE round(COALESCE(sum(pnl) FILTER (WHERE pnl > 0), 0) / -(sum(pnl) FILTER (WHERE pnl < 0)), 2)
    END::numeric(20, 2)::text                                             AS profit_factor,
    round(avg(pnl) FILTER (WHERE pnl > 0), 2)::numeric(16, 2)::text       AS average_win_usd,
    round(avg(pnl) FILTER (WHERE pnl < 0), 2)::numeric(16, 2)::text       AS average_loss_usd,
    (max(pnl) FILTER (WHERE pnl > 0))::numeric(16, 2)::text               AS largest_win_usd,
    (min(pnl) FILTER (WHERE pnl < 0))::numeric(16, 2)::text               AS largest_loss_usd,
    COALESCE(max(peak - bal), 0)::numeric(16, 2)::text                    AS max_drawdown_usd,
    COALESCE(max(round((peak - bal) * 100 / peak, 2)), 0)::numeric(10, 2)::text AS max_drawdown_pct
  FROM d`;

// The API's field names, in the API's order
export const STATS_FIELDS = [
  'trades', 'wins', 'losses', 'breakeven', 'winRatePct', 'netPnlUsd', 'grossProfitUsd', 'grossLossUsd',
  'profitFactor', 'averageWinUsd', 'averageLossUsd', 'largestWinUsd', 'largestLossUsd', 'maxDrawdownUsd',
  'maxDrawdownPct',
] as const;
export type StatsField = (typeof STATS_FIELDS)[number];
export type StatsRecord = Record<StatsField, string | number | null>;

const COLUMN: Record<StatsField, string> = {
  trades: 'trades', wins: 'wins', losses: 'losses', breakeven: 'breakeven', winRatePct: 'win_rate_pct',
  netPnlUsd: 'net_pnl_usd', grossProfitUsd: 'gross_profit_usd', grossLossUsd: 'gross_loss_usd',
  profitFactor: 'profit_factor', averageWinUsd: 'average_win_usd', averageLossUsd: 'average_loss_usd',
  largestWinUsd: 'largest_win_usd', largestLossUsd: 'largest_loss_usd', maxDrawdownUsd: 'max_drawdown_usd',
  maxDrawdownPct: 'max_drawdown_pct',
};

export function statsFromRow(row: Record<string, unknown>): StatsRecord {
  const out = {} as StatsRecord;
  for (const f of STATS_FIELDS) out[f] = (row[COLUMN[f]] ?? null) as string | number | null;
  return out;
}

export interface StatsDifference { field: StatsField; api: unknown; sql: unknown }

// Every field equal as text (numbers as numbers); an empty field list never passes
export function compareStats(api: Record<string, unknown>, sql: StatsRecord): StatsDifference[] {
  const diffs: StatsDifference[] = [];
  for (const f of STATS_FIELDS) {
    if (!(f in api)) diffs.push({ field: f, api: undefined, sql: sql[f] });
    else if (api[f] !== sql[f]) diffs.push({ field: f, api: api[f], sql: sql[f] });
  }
  return diffs;
}
