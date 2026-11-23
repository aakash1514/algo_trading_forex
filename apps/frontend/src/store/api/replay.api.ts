import { baseApi } from './base.api';
import { API_BASE } from '../../lib/constants';
import type {
  CreateSessionRequest, EndedSession, OrderResult, PlaceOrderRequest, ReplaySession, ReplayStats, TradesPage,
} from '../../types/replay.types';

const SESSIONS = `${API_BASE.REPLAY}/replay/sessions`;

// replay-service's REST side: the session and its orders. Every write names its session
// (the server refuses one for a session that isn't the user's current one). Everything that changes over
// time (clock, bars, account, positions) also arrives over the /replay socket, which
// the page treats as the source of truth; these responses only fill the gap until the
// matching socket event lands. The mutations are never cached or retried (an order
// must never be sent twice); the two reads (trades, statistics) are history only.
export const replayApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    // 201 PAUSED, the user's current session (a playing one pauses first)
    createReplaySession: build.mutation<ReplaySession, CreateSessionRequest>({
      query: (body) => ({ url: SESSIONS, method: 'POST', body }),
    }),
    // Closes open positions at the clock price and cancels pending orders
    endReplaySession: build.mutation<EndedSession, string>({
      query: (sessionId) => ({ url: `${SESSIONS}/${encodeURIComponent(sessionId)}/end`, method: 'POST' }),
    }),
    // A market order: PENDING until the next minute's open
    placeReplayOrder: build.mutation<OrderResult, { sessionId: string; order: PlaceOrderRequest }>({
      query: ({ sessionId, order }) => ({ url: `${SESSIONS}/${encodeURIComponent(sessionId)}/orders`, method: 'POST', body: order }),
    }),
    cancelReplayOrder: build.mutation<OrderResult, { sessionId: string; id: string }>({
      query: ({ sessionId, id }) => ({
        url: `${SESSIONS}/${encodeURIComponent(sessionId)}/orders/${encodeURIComponent(id)}/cancel`, method: 'POST',
      }),
    }),
    // The close is pending until the next minute's open
    closeReplayPosition: build.mutation<OrderResult, { sessionId: string; id: string }>({
      query: ({ sessionId, id }) => ({
        url: `${SESSIONS}/${encodeURIComponent(sessionId)}/positions/${encodeURIComponent(id)}/close`, method: 'POST',
      }),
    }),
    // A page of closed trades, newest first; the next page from its nextCursor
    getReplayTrades: build.query<TradesPage, { sessionId: string; cursor?: string }>({
      query: ({ sessionId, cursor }) => ({
        url: `${SESSIONS}/${encodeURIComponent(sessionId)}/trades`, params: cursor ? { cursor } : undefined,
      }),
    }),
    // closedKey only changes the cache key: a new close asks again
    getReplayStats: build.query<ReplayStats, { sessionId: string; closedKey: string }>({
      query: ({ sessionId }) => `${SESSIONS}/${encodeURIComponent(sessionId)}/stats`,
    }),
  }),
});

export const {
  useCreateReplaySessionMutation,
  useEndReplaySessionMutation,
  usePlaceReplayOrderMutation,
  useCancelReplayOrderMutation,
  useCloseReplayPositionMutation,
  useLazyGetReplayTradesQuery,
  useGetReplayStatsQuery,
} = replayApi;
