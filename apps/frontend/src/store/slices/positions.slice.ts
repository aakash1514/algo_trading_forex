import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { PositionsState } from '../../types/store.types';
import type { Position, PositionUpdateEvent } from '../../types/api.types';

const initialState: PositionsState = {
  items: {},
};

export const positionsSlice = createSlice({
  name: 'positions',
  initialState,
  reducers: {
    setPositions(state, action: PayloadAction<Position[]>) {
      state.items = {};
      action.payload.forEach((p) => {
        state.items[p.id] = p;
      });
    },
    positionUpdated(state, action: PayloadAction<PositionUpdateEvent>) {
      const { positionId, currentPrice, pipPnl, unrealizedPnl } = action.payload;
      const position = state.items[positionId];
      if (position) {
        position.currentPrice = currentPrice;
        position.pipPnl = pipPnl;
        position.unrealizedPnl = unrealizedPnl;
      }
    },
    removePosition(state, action: PayloadAction<string>) {
      delete state.items[action.payload];
    },
  },
});

export const { setPositions, positionUpdated, removePosition } = positionsSlice.actions;
export default positionsSlice.reducer;