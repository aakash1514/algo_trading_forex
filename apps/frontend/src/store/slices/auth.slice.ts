import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { AuthState } from '../../types/store.types';
import type { AuthUser } from '../../types/api.types';

const initialState: AuthState = {
  user: null,
  accessToken: null,
  isAuthenticated: false,
};

export const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    setCredentials(state, action: PayloadAction<{ user: AuthUser; accessToken: string }>) {
      state.user = action.payload.user;
      state.accessToken = action.payload.accessToken;
      state.isAuthenticated = true;
      if (typeof window !== 'undefined') {
        localStorage.setItem('fx_access_token', action.payload.accessToken);
        localStorage.setItem('fx_user', JSON.stringify(action.payload.user));
      }
    },
    setAccessToken(state, action: PayloadAction<string>) {
      state.accessToken = action.payload;
      if (typeof window !== 'undefined') {
        localStorage.setItem('fx_access_token', action.payload);
      }
    },
    clearCredentials(state) {
      state.user = null;
      state.accessToken = null;
      state.isAuthenticated = false;
      if (typeof window !== 'undefined') {
        localStorage.removeItem('fx_access_token');
        localStorage.removeItem('fx_user');
      }
    },
  },
});

export const { setCredentials, setAccessToken, clearCredentials } = authSlice.actions;
export default authSlice.reducer;