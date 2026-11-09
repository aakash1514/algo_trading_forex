import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { endSummary, RECENT_CLOSED_CAP, type EndSummary } from '../../lib/replay';
import type {
  BarEvent, EndedSession, EndOfDataEvent, ReplayAccount, ReplayBar, ReplayPosition, ReplaySession, ReplayState,
} from '../../types/replay.types';

export type ReplayConnection = 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'closed';

// The latest copy of what replay-service sent. The server owns the clock, fills and
// money; nothing here is computed except where to put each update:
//   state      replaces everything (connect, reconnect, timeframe change)
//   bar        the current bar: same start time -> replaced in place; a later one ->
//              the previous current bar is complete and joins the history
//   positions  upserted by id (the same update twice changes nothing)
//   account, status   replaced
export interface ReplaySliceState {
  connection: ReplayConnection;
  loaded: boolean;               // a 'state' (with or without a session) has arrived
  session: ReplaySession | null;
  account: ReplayAccount | null;
  priceDecimals: number;
  bars: ReplayBar[];             // completed bars, oldest first
  currentBar: ReplayBar | null;
  stateVersion: number;          // bumps on every full state: the chart reloads
  positions: Record<string, ReplayPosition>;
  stateWasCapped: boolean;       // the last state held the maximum of closed entries
  pendingCommand: string | null; // a socket command waiting for its acknowledgement
  error: string | null;
  summary: EndSummary | null;    // set when the session ends
}

// The history kept in memory while playing; a reload gets the server's 500 again
const MAX_BARS = 5_000;

const initialState: ReplaySliceState = {
  connection: 'connecting',
  loaded: false,
  session: null,
  account: null,
  priceDecimals: 5,
  bars: [],
  currentBar: null,
  stateVersion: 0,
  positions: {},
  stateWasCapped: false,
  pendingCommand: null,
  error: null,
  summary: null,
};

const replaySlice = createSlice({
  name: 'replay',
  initialState,
  reducers: {
    connectionChanged(state, action: PayloadAction<ReplayConnection>) {
      state.connection = action.payload;
      // a command can't be acknowledged by a socket that is gone
      if (action.payload !== 'connected') state.pendingCommand = null;
    },
    stateReceived(state, action: PayloadAction<ReplayState | null>) {
      const s = action.payload;
      state.loaded = true;
      state.stateVersion += 1;
      state.error = null;
      if (!s) {
        Object.assign(state, {
          session: null, account: null, bars: [], currentBar: null, positions: {}, stateWasCapped: false,
        });
        return;
      }
      state.session = s.session;
      state.account = s.account;
      state.priceDecimals = s.priceDecimals;
      state.bars = s.bars;
      state.currentBar = s.currentBar;
      state.positions = Object.fromEntries(s.positions.map((p) => [p.id, p]));
      state.stateWasCapped = s.positions.filter((p) => p.status === 'CLOSED' || p.status === 'CANCELLED').length
        >= RECENT_CLOSED_CAP;
    },
    barReceived(state, action: PayloadAction<BarEvent>) {
      const { sessionId, timeframe, clockTime, bar } = action.payload;
      // a bar already on its way while the timeframe changed is for the old chart
      if (!state.session || state.session.id !== sessionId || state.session.timeframe !== timeframe) return;
      const current = state.currentBar;
      if (current && bar.time > current.time) {
        state.bars.push(current);
        if (state.bars.length > MAX_BARS) state.bars.splice(0, state.bars.length - MAX_BARS);
      }
      if (!current || bar.time >= current.time) state.currentBar = bar;
      state.session.clockTime = clockTime;
    },
    accountReceived(state, action: PayloadAction<ReplayAccount>) {
      if (state.session) state.account = action.payload;
    },
    positionsReceived(state, action: PayloadAction<ReplayPosition[]>) {
      if (!state.session) return;
      for (const p of action.payload) state.positions[p.id] = p;
    },
    statusReceived(state, action: PayloadAction<ReplaySession>) {
      if (state.session && state.session.id === action.payload.id) state.session = action.payload;
    },
    endOfDataReceived(state, action: PayloadAction<EndOfDataEvent>) {
      if (state.session && state.session.id === action.payload.sessionId) state.session.endOfData = true;
    },
    sessionEnded(state, action: PayloadAction<EndedSession>) {
      const { session, closed } = action.payload;
      if (state.summary) return; // the REST answer and the socket's 'ended' both land here
      const knownClosed = Object.values(state.positions).filter((p) => p.status === 'CLOSED').map((p) => p.id);
      state.summary = endSummary(session, knownClosed, closed, state.stateWasCapped);
      Object.assign(state, {
        session: null, account: null, bars: [], currentBar: null, positions: {}, stateWasCapped: false, pendingCommand: null,
      });
    },
    summaryDismissed(state) {
      state.summary = null;
    },
    commandStarted(state, action: PayloadAction<string>) {
      state.pendingCommand = action.payload;
      state.error = null;
    },
    commandFinished(state, action: PayloadAction<string | null>) {
      state.pendingCommand = null;
      state.error = action.payload;
    },
    errorReceived(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    replayReset() {
      return initialState;
    },
  },
});

export const {
  connectionChanged, stateReceived, barReceived, accountReceived, positionsReceived, statusReceived,
  endOfDataReceived, sessionEnded, summaryDismissed, commandStarted, commandFinished, errorReceived, replayReset,
} = replaySlice.actions;
export default replaySlice.reducer;
