import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { AccountState } from '../../types/store.types';
import type { AccountSummary, AccountUpdateEvent } from '../../types/api.types';

const initialState: AccountState = {
  summary: null,
};

export const accountSlice = createSlice({
  name: 'account',
  initialState,
  reducers: {
    setAccountSummary(state, action: PayloadAction<AccountSummary>) {
      state.summary = action.payload;
    },
    accountUpdated(state, action: PayloadAction<AccountUpdateEvent>) {
      if (state.summary) {
        state.summary.equity = action.payload.equity;
        state.summary.freeMargin = action.payload.freeMargin;
        state.summary.marginLevel = action.payload.marginLevel;
      }
    },
  },
});

export const { setAccountSummary, accountUpdated } = accountSlice.actions;
export default accountSlice.reducer;