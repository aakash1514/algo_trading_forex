import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { SignalsState } from '../../types/store.types';
import type { SignalUpdateEvent } from '../../types/api.types';

const initialState: SignalsState = {
  signals: {},
};

export const signalsSlice = createSlice({
  name: 'signals',
  initialState,
  reducers: {
    signalReceived(state, action: PayloadAction<SignalUpdateEvent>) {
      state.signals[action.payload.instrument] = action.payload;
    },
  },
});

export const { signalReceived } = signalsSlice.actions;
export default signalsSlice.reducer;
