import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { AuthState } from '../../types/store.types';
import type { AuthUser } from '../../types/api.types';

// The access token lives in memory only (never localStorage, so XSS can't read
// it). After a reload the session is restored from the httpOnly refresh cookie.
const initialState: AuthState = {
  user: null,
  accessToken: null,
  isAuthenticated: false,
  sessionRestored: false,
};

export const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    setCredentials(state, action: PayloadAction<{ user: AuthUser; accessToken: string }>) {
      state.user = action.payload.user;
      state.accessToken = action.payload.accessToken;
      state.isAuthenticated = true;
      state.sessionRestored = true;
    },
    clearCredentials(state) {
      state.user = null;
      state.accessToken = null;
      state.isAuthenticated = false;
      state.sessionRestored = true;
    },
  },
});

export const { setCredentials, clearCredentials } = authSlice.actions;
export default authSlice.reducer;
