import { baseApi } from './base.api';
import type { TickPrice, Candle, FeedStatus } from '../../types/api.types';
import { API_BASE, type Timeframe } from '../../lib/constants';

export const marketApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    getPrice: build.query<TickPrice, string>({
      query: (pair) => `${API_BASE.MARKET}/market/price/${pair}`,
    }),
    getCandles: build.query<Candle[], { pair: string; timeframe: Timeframe; limit?: number }>({
      query: ({ pair, timeframe, limit = 200 }) =>
        `${API_BASE.MARKET}/market/candles/${pair}/${timeframe}?limit=${limit}`,
    }),
    // Which feed runs and its state; polled by the terminal (no feed by default)
    getFeedStatus: build.query<FeedStatus, void>({
      query: () => `${API_BASE.MARKET}/market/feed/status`,
    }),
  }),
});

export const { useGetPriceQuery, useGetCandlesQuery, useGetFeedStatusQuery } = marketApi;