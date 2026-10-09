import { configureStore } from '@reduxjs/toolkit';
import { useDispatch, useSelector, type TypedUseSelectorHook } from 'react-redux';
import authReducer from './slices/auth.slice';
import marketReducer from './slices/market.slice';
import positionsReducer from './slices/positions.slice';
import accountReducer from './slices/account.slice';
import signalsReducer from './slices/signals.slice';
import { baseApi } from './api/base.api';

export const store = configureStore({
  reducer: {
    auth: authReducer,
    market: marketReducer,
    positions: positionsReducer,
    account: accountReducer,
    signals: signalsReducer,
    [baseApi.reducerPath]: baseApi.reducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware().concat(baseApi.middleware),
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

// Typed hooks — use these everywhere instead of plain useDispatch/useSelector
export const useAppDispatch = () => useDispatch<AppDispatch>();
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;