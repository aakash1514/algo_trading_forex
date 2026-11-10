import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { FeedStatusEvent } from '../../types/api.types';

// The ws-gateway connection and the feed status it reports, for the Topbar's status dot
export type LiveSocketState = 'connecting' | 'connected' | 'disconnected';

export interface LiveState {
  socket: LiveSocketState;
  feed: FeedStatusEvent | null;
  feedAt: number | null; // when the latest feed:status arrived (this browser's clock)
}

const initialState: LiveState = { socket: 'disconnected', feed: null, feedAt: null };

export const liveSlice = createSlice({
  name: 'live',
  initialState,
  reducers: {
    liveSocketChanged(state, action: PayloadAction<LiveSocketState>) {
      state.socket = action.payload;
      if (action.payload !== 'connected') {
        state.feed = null;
        state.feedAt = null;
      }
    },
    feedStatusReceived(state, action: PayloadAction<{ status: FeedStatusEvent; at: number }>) {
      state.feed = action.payload.status;
      state.feedAt = action.payload.at;
    },
  },
});

export const { liveSocketChanged, feedStatusReceived } = liveSlice.actions;
export default liveSlice.reducer;
