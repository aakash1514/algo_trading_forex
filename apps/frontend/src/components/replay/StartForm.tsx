'use client';

import { useState, type FormEvent } from 'react';
import { useCreateReplaySessionMutation } from '../../store/api/replay.api';
import { PAIR_DISPLAY } from '../../lib/constants';
import {
  DEFAULT_REPLAY_TIMEFRAME, DEFAULT_STARTING_BALANCE, REPLAY_PAIRS, REPLAY_TIMEFRAMES, replayErrorMessage,
  startingBalanceFromInput, startTimeFromInputs, TITLE_MAX_CHARS,
} from '../../lib/replay';

const FIELD = 'w-full rounded border border-terminal-border bg-terminal-bg px-2.5 py-1.5 text-[12px] text-[#e2e4e9] '
  + 'tabular-nums focus:outline-none focus:border-accent-blue';
const LABEL = 'block text-[10px] font-medium text-terminal-muted uppercase tracking-wider mb-1';

interface StartFormProps {
  onCreated: () => void;   // the session exists (PAUSED, the user's current one): open it
}

// A new replay: pair, a start in UTC inside the imported history, balance and the
// chart's timeframe. Inputs are checked here first (the server checks them again).
export function StartForm({ onCreated }: StartFormProps) {
  const [instrument, setInstrument] = useState<string>(REPLAY_PAIRS[0]);
  const [date, setDate] = useState('');
  const [time, setTime] = useState('00:00');
  const [balance, setBalance] = useState(String(DEFAULT_STARTING_BALANCE));
  const [timeframe, setTimeframe] = useState<string>(DEFAULT_REPLAY_TIMEFRAME);
  const [title, setTitle] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [create, { isLoading }] = useCreateReplaySessionMutation();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const start = startTimeFromInputs(date, time);
    if (!start.ok) return setProblem(start.error);
    const amount = startingBalanceFromInput(balance);
    if (!amount.ok) return setProblem(amount.error);
    setProblem(null);
    const result = await create({
      instrument, startTime: start.value, timeframe, startingBalance: amount.value, ...(title.trim() ? { title } : {}),
    });
    if ('data' in result) return onCreated();
    setProblem(replayErrorMessage(result.error));
  }

  return (
    <form onSubmit={submit} noValidate data-testid="replay-start-form"
      className="bg-terminal-surface border border-terminal-border rounded-lg p-4 space-y-3 max-w-md">
      <div>
        <h2 className="text-[13px] font-medium text-[#e2e4e9]">Start a replay</h2>
        <p className="text-[11px] text-terminal-muted mt-0.5">
          Replays the Dukascopy history (2010-01-01 to 2022-12-30) bar by bar, with paper trading. It opens paused.
        </p>
      </div>
      <div>
        <label htmlFor="replay-pair" className={LABEL}>Pair</label>
        <select id="replay-pair" value={instrument} onChange={(e) => setInstrument(e.target.value)} className={FIELD}>
          {REPLAY_PAIRS.map((p) => <option key={p} value={p}>{PAIR_DISPLAY[p]}</option>)}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor="replay-date" className={LABEL}>Start date (UTC)</label>
          <input id="replay-date" type="date" min="2010-01-01" max="2022-12-30" value={date}
            onChange={(e) => setDate(e.target.value)} className={FIELD} />
        </div>
        <div>
          <label htmlFor="replay-time" className={LABEL}>Start time (UTC)</label>
          <input id="replay-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} className={FIELD} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor="replay-balance" className={LABEL}>Starting balance (USD)</label>
          <input id="replay-balance" inputMode="decimal" value={balance} onChange={(e) => setBalance(e.target.value)}
            className={FIELD} />
        </div>
        <div>
          <label htmlFor="replay-timeframe" className={LABEL}>Chart timeframe</label>
          <select id="replay-timeframe" value={timeframe} onChange={(e) => setTimeframe(e.target.value)} className={FIELD}>
            {REPLAY_TIMEFRAMES.map((tf) => <option key={tf} value={tf}>{tf}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label htmlFor="replay-title" className={LABEL}>Title (optional, up to {TITLE_MAX_CHARS} characters)</label>
        <input id="replay-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Pair · timeframe · start date"
          className={FIELD} />
      </div>
      {problem && <p role="alert" data-testid="replay-start-error" className="text-[12px] text-accent-red">{problem}</p>}
      <button type="submit" disabled={isLoading}
        className="px-4 py-1.5 rounded bg-accent-blue text-white text-[12px] font-medium disabled:opacity-40 disabled:cursor-not-allowed">
        {isLoading ? 'Starting…' : 'Start replay'}
      </button>
    </form>
  );
}
