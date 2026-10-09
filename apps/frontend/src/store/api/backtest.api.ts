import { baseApi } from './base.api';
import type { BacktestRun } from '../../types/api.types';
import { API_BASE } from '../../lib/constants';

export const backtestApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    getBacktests: build.query<BacktestRun[], void>({
      query: () => `${API_BASE.WS}/backtest`,
      providesTags: ['Backtest'],
    }),
    getBacktestResults: build.query<any, string>({
      query: (runId) => `${API_BASE.WS}/backtest/${runId}/results`,
    }),
runBacktest: build.mutation<BacktestRun, {
  strategyName: string;
  instrument: string;
  fromDate: string;
  toDate: string;
  timeframe?: string;
  parameters?: Record<string, number>;
  lots?: number;
}>({
  query: (body) => ({
    url: `${API_BASE.WS}/backtest/run`,
    method: 'POST',
    body,
  }),
  invalidatesTags: ['Backtest'],
}),
    deleteBacktest: build.mutation<void, string>({
      query: (runId) => ({
        url: `${API_BASE.WS}/backtest/${runId}`,
        method: 'DELETE',
      }),
      invalidatesTags: ['Backtest'],
    }),
  }),
});

export const {
  useGetBacktestsQuery,
  useGetBacktestResultsQuery,
  useRunBacktestMutation,
  useDeleteBacktestMutation,
} = backtestApi;