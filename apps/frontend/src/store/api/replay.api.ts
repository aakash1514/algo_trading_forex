import { baseApi } from './base.api';
import { API_BASE } from '../../lib/constants';
import type {
  CreateSessionRequest, EndedSession, OrderResult, PlaceOrderRequest, ReplaySession,
} from '../../types/replay.types';

const SESSIONS = `${API_BASE.REPLAY}/replay/sessions`;

// replay-service's REST side: the session and its orders. Everything that changes over
// time (clock, bars, account, positions) also arrives over the /replay socket, which
// the page treats as the source of truth; these responses only fill the gap until the
// matching socket event lands. All mutations: nothing here is cached or retried
// (an order must never be sent twice).
export const replayApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    // 201 PAUSED; 409 { activeSessionId } while one is active
    createReplaySession: build.mutation<ReplaySession, CreateSessionRequest>({
      query: (body) => ({ url: SESSIONS, method: 'POST', body }),
    }),
    // Closes open positions at the clock price and cancels pending orders
    endReplaySession: build.mutation<EndedSession, void>({
      query: () => ({ url: `${SESSIONS}/active/end`, method: 'POST' }),
    }),
    // A market order: PENDING until the next minute's open
    placeReplayOrder: build.mutation<OrderResult, PlaceOrderRequest>({
      query: (body) => ({ url: `${SESSIONS}/active/orders`, method: 'POST', body }),
    }),
    cancelReplayOrder: build.mutation<OrderResult, string>({
      query: (id) => ({ url: `${SESSIONS}/active/orders/${encodeURIComponent(id)}/cancel`, method: 'POST' }),
    }),
    // The close is pending until the next minute's open
    closeReplayPosition: build.mutation<OrderResult, string>({
      query: (id) => ({ url: `${SESSIONS}/active/positions/${encodeURIComponent(id)}/close`, method: 'POST' }),
    }),
  }),
});

export const {
  useCreateReplaySessionMutation,
  useEndReplaySessionMutation,
  usePlaceReplayOrderMutation,
  useCancelReplayOrderMutation,
  useCloseReplayPositionMutation,
} = replayApi;
