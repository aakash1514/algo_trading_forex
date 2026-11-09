'use client';

import { useState, type FormEvent } from 'react';
import { useAppDispatch, useAppSelector } from '../../store';
import { usePlaceReplayOrderMutation } from '../../store/api/replay.api';
import { accountReceived, positionsReceived } from '../../store/slices/replay.slice';
import { PAIR_DISPLAY } from '../../lib/constants';
import { cn } from '../../lib/cn';
import { replayErrorMessage, validateOrder } from '../../lib/replay';

const FIELD = 'w-full bg-terminal-elevated border border-terminal-border rounded px-2.5 py-1.5 text-[12px] text-[#e2e4e9] '
  + 'tabular-nums placeholder:text-terminal-muted/40 focus:outline-none focus:border-accent-blue';
const LABEL = 'block text-[9px] text-terminal-muted uppercase tracking-wider mb-1';

// A market order at the replay clock. The prices shown are the clock minute's close
// (the current bar's close); the order fills at the next minute's open, so it is
// Pending until the clock moves on (play or step).
export function ReplayOrderPanel() {
  const dispatch = useAppDispatch();
  const session = useAppSelector((s) => s.replay.session);
  const bar = useAppSelector((s) => s.replay.currentBar);
  const decimals = useAppSelector((s) => s.replay.priceDecimals);
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [lots, setLots] = useState('0.10');
  const [stopLoss, setStopLoss] = useState('');
  const [takeProfit, setTakeProfit] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [placed, setPlaced] = useState(false);
  const [place, { isLoading }] = usePlaceReplayOrderMutation();
  if (!session || !bar) return null;

  const bid = bar.bid.close;
  const ask = bar.ask.close;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setPlaced(false);
    const order = validateOrder({ side, lots, stopLoss, takeProfit }, { bid, ask, decimals });
    if (!order.ok) return setProblem(order.error);
    setProblem(null);
    const result = await place(order.value);
    if ('data' in result && result.data) {
      dispatch(positionsReceived([result.data.position]));
      dispatch(accountReceived(result.data.account));
      setPlaced(true);
      setStopLoss('');
      setTakeProfit('');
    } else {
      setProblem(replayErrorMessage(result.error));
    }
  }

  const step = (10 ** -decimals).toFixed(decimals);
  return (
    <form onSubmit={submit} noValidate data-testid="replay-order-panel" className="p-3 border-b border-terminal-border space-y-2">
      <p className="text-[10px] font-medium text-terminal-muted uppercase tracking-wider">
        Market order · {PAIR_DISPLAY[session.instrument] ?? session.instrument}
      </p>
      <div className="grid grid-cols-2 gap-1.5 text-center">
        <div className="bg-terminal-elevated rounded p-1.5">
          <p className="text-[9px] text-terminal-muted uppercase tracking-wide">Bid</p>
          <p data-testid="replay-bid" className="text-[13px] tabular-nums text-accent-red">{bid}</p>
        </div>
        <div className="bg-terminal-elevated rounded p-1.5">
          <p className="text-[9px] text-terminal-muted uppercase tracking-wide">Ask</p>
          <p data-testid="replay-ask" className="text-[13px] tabular-nums text-accent-green">{ask}</p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1.5" role="group" aria-label="Side">
        {(['BUY', 'SELL'] as const).map((s) => (
          <button key={s} type="button" aria-pressed={side === s} onClick={() => setSide(s)}
            className={cn('py-1.5 rounded text-[12px] font-medium border transition-all',
              s === 'BUY'
                ? (side === s ? 'bg-accent-green text-[#0a1a0f] border-accent-green' : 'text-accent-green border-accent-green/20 hover:bg-accent-green/10')
                : (side === s ? 'bg-accent-red text-white border-accent-red' : 'text-accent-red border-accent-red/20 hover:bg-accent-red/10'))}>
            {s === 'BUY' ? 'Buy' : 'Sell'}
          </button>
        ))}
      </div>
      <div>
        <label htmlFor="replay-lots" className={LABEL}>Lots</label>
        <input id="replay-lots" inputMode="decimal" value={lots} onChange={(e) => setLots(e.target.value)} className={FIELD} />
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <div>
          <label htmlFor="replay-sl" className={LABEL}>Stop loss</label>
          <input id="replay-sl" inputMode="decimal" placeholder={`— (step ${step})`} value={stopLoss}
            onChange={(e) => setStopLoss(e.target.value)} className={FIELD} />
        </div>
        <div>
          <label htmlFor="replay-tp" className={LABEL}>Take profit</label>
          <input id="replay-tp" inputMode="decimal" placeholder="—" value={takeProfit}
            onChange={(e) => setTakeProfit(e.target.value)} className={FIELD} />
        </div>
      </div>
      <p className="text-[11px] text-terminal-muted">Orders fill at the next minute&apos;s open.</p>
      {session.endOfData && (
        <p data-testid="replay-order-disabled" className="text-[11px] text-terminal-muted bg-terminal-elevated rounded px-2.5 py-1.5">
          End of the historical data: no later minute to fill an order.
        </p>
      )}
      {problem && <p role="alert" data-testid="replay-order-error" className="text-[11px] text-accent-red">{problem}</p>}
      {placed && !problem && (
        <p role="status" className="text-[11px] text-accent-green">Order placed: pending until the next minute.</p>
      )}
      <button type="submit" disabled={isLoading || session.endOfData}
        className={cn('w-full py-2 rounded text-[12px] font-medium disabled:opacity-40 disabled:cursor-not-allowed',
          side === 'BUY' ? 'bg-accent-green text-[#0a1a0f]' : 'bg-accent-red text-white')}>
        {isLoading ? 'Placing…' : `${side === 'BUY' ? 'Buy' : 'Sell'} ${lots} lots`}
      </button>
    </form>
  );
}
