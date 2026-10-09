import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { AccountState } from '../../types/store.types';
import type { AccountSummary } from '../../types/api.types';

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
  },
});

export const { setAccountSummary } = accountSlice.actions;
export default accountSlice.reducer;