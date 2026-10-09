import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { MarketState } from '../../types/store.types';
import type { TickEvent } from '../../types/api.types';

const initialState: MarketState = {
  prices: {},
  activePair: 'EUR_USD',
};

export const marketSlice = createSlice({
  name: 'market',
  initialState,
  reducers: {
    tickReceived(state, action: PayloadAction<{ instrument: string; tick: TickEvent }>) {
      state.prices[action.payload.instrument] = {
        bid: action.payload.tick.bid,
        ask: action.payload.tick.ask,
        spread: action.payload.tick.spread,
        timestamp: action.payload.tick.timestamp,
      };
    },
    setActivePair(state, action: PayloadAction<string>) {
      state.activePair = action.payload;
    },
  },
});

export const { tickReceived, setActivePair } = marketSlice.actions;
export default marketSlice.reducer;