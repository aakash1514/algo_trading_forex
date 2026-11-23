import { createSelector, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { endSummary, RECENT_CLOSED_CAP, type EndSummary } from '../../lib/replay';
import type {
  BarEvent, CalendarEvent, CalendarMessage, EndedSession, EndOfDataEvent, ReplayAccount, ReplayBar, ReplayPosition, ReplaySession, ReplayState,
} from '../../types/replay.types';

export type ReplayConnection = 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'closed';

// The latest copy of what replay-service sent for the session this page shows. The server
// owns the clock, fills and money; nothing here is computed except where to put each
// update. Every event names its session, and one for another session is ignored (the
// user may have opened another session in another tab):
//   state      replaces everything (connect, reconnect); stateUpdated only for this session
//              (a timeframe change)
//   bar        the current bar: same start time -> replaced in place; a later one ->
//              the previous current bar is complete and joins the history
//   positions  upserted by id (the same update twice changes nothing)
//   account, status   replaced
// An ENDED session opened from "My replays" is shown read-only from the server's answer
// (readOnly: no socket state replaces it until the user leaves it). switchedAway: another
// tab opened a different session, so this one was paused and its commands are refused.
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
  calendar: { covered: boolean; events: Record<string, CalendarEvent> };
  readOnly: boolean;             // an ENDED session being viewed
  switchedAway: boolean;         // the user opened another session (in another tab)
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
  calendar: { covered: false, events: {} },
  readOnly: false,
  switchedAway: false,
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
    // A broadcast state (a timeframe change): only for the session shown
    stateUpdated(state, action: PayloadAction<ReplayState>) {
      if (!state.session || state.session.id !== action.payload.session.id) return;
      replaySlice.caseReducers.stateReceived(state, action);
    },
    stateReceived(state, action: PayloadAction<ReplayState | null>) {
      const s = action.payload;
      state.loaded = true;
      state.stateVersion += 1;
      state.error = null;
      state.readOnly = false;
      state.switchedAway = false;
      if (!s) {
        Object.assign(state, {
          session: null, account: null, bars: [], currentBar: null, positions: {}, stateWasCapped: false,
          calendar: initialState.calendar,
        });
        return;
      }
      state.session = s.session;
      state.account = s.account;
      state.priceDecimals = s.priceDecimals;
      state.bars = s.bars;
      state.currentBar = s.currentBar;
      state.positions = Object.fromEntries(s.positions.map((p) => [p.id, p]));
      state.calendar = {
        covered: s.calendar.covered, events: Object.fromEntries(s.calendar.events.map((e) => [e.id, e])),
      };
      state.stateWasCapped = s.positions.filter((p) => p.status === 'CLOSED' || p.status === 'CANCELLED').length
        >= RECENT_CLOSED_CAP;
    },
    // An ENDED session from "My replays", read-only
    endedViewOpened(state, action: PayloadAction<ReplayState>) {
      replaySlice.caseReducers.stateReceived(state, action);
      state.readOnly = true;
    },
    // Back from the ended view: the socket sends the current session's state next
    endedViewClosed(state) {
      state.readOnly = false;
      state.loaded = false;
    },
    // The user opened (or created) a session: a page showing another live session says so
    switchedReceived(state, action: PayloadAction<{ openedSessionId: string }>) {
      if (state.session && !state.readOnly && state.session.status !== 'ENDED'
        && state.session.id !== action.payload.openedSessionId) state.switchedAway = true;
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
    // Events a step passed; one for another session or the old timeframe is ignored
    calendarReceived(state, action: PayloadAction<CalendarMessage>) {
      const { sessionId, timeframe, events } = action.payload;
      if (!state.session || state.session.id !== sessionId || state.session.timeframe !== timeframe) return;
      for (const e of events) state.calendar.events[e.id] = e;
      if (events.length > 0) state.calendar.covered = true;
    },
    accountReceived(state, action: PayloadAction<ReplayAccount>) {
      if (state.session && state.session.id === action.payload.sessionId) state.account = action.payload;
    },
    positionsReceived(state, action: PayloadAction<ReplayPosition[]>) {
      if (!state.session) return;
      for (const p of action.payload) if (p.sessionId === state.session.id) state.positions[p.id] = p;
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
      if (!state.session || state.session.id !== session.id) return; // another session ended
      const knownClosed = Object.values(state.positions).filter((p) => p.status === 'CLOSED').map((p) => p.id);
      state.summary = endSummary(session, knownClosed, closed, state.stateWasCapped);
      Object.assign(state, {
        session: null, account: null, bars: [], currentBar: null, positions: {}, stateWasCapped: false, pendingCommand: null,
        calendar: initialState.calendar,
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
  connectionChanged, stateReceived, stateUpdated, endedViewOpened, endedViewClosed, switchedReceived, barReceived, calendarReceived, accountReceived, positionsReceived, statusReceived,
  endOfDataReceived, sessionEnded, summaryDismissed, commandStarted, commandFinished, errorReceived, replayReset,
} = replaySlice.actions;
export default replaySlice.reducer;

// ── Derived lists (memoized: a new array on every render would re-render the tables) ──

const selectPositionMap = (s: { replay: ReplaySliceState }) => s.replay.positions;

// Pending orders and open positions, oldest first
export const selectLiveReplayPositions = createSelector(selectPositionMap, (positions) =>
  Object.values(positions)
    .filter((p) => p.status === 'PENDING' || p.status === 'OPEN')
    .sort((a, b) => a.placedAt.localeCompare(b.placedAt) || a.id.localeCompare(b.id)));

// Calendar events the clock has reached, oldest first
export const selectReplayCalendarEvents = createSelector(
  (s: { replay: ReplaySliceState }) => s.replay.calendar.events,
  (events) => Object.values(events).sort((a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id)));

// Closed trades, newest first (cancelled orders never traded and aren't listed)
export const selectClosedReplayPositions = createSelector(selectPositionMap, (positions) =>
  Object.values(positions)
    .filter((p) => p.status === 'CLOSED')
    .sort((a, b) => (b.exitTime ?? '').localeCompare(a.exitTime ?? '') || b.id.localeCompare(a.id)));
