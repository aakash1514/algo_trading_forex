import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import type { RootState } from '../index';

const baseQuery = fetchBaseQuery({
  baseUrl: '/',
  prepareHeaders(headers, { getState }) {
    const token = (getState() as RootState).auth.accessToken
      ?? (typeof window !== 'undefined' ? localStorage.getItem('fx_access_token') : null);
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }
    return headers;
  },
  credentials: 'include',
});

const baseQueryWithReauth = async (args: any, api: any, extraOptions: any) => {
  let result = await baseQuery(args, api, extraOptions);

  if (result.error?.status === 401) {
    // Try refresh
    const refreshResult = await baseQuery(
      { url: 'http://localhost:3000/api/auth/refresh', method: 'POST' },
      api,
      extraOptions
    );

    if (refreshResult.data) {
      const data = refreshResult.data as { accessToken: string };
      if (typeof window !== 'undefined') {
        localStorage.setItem('fx_access_token', data.accessToken);
      }
      // Retry original request
      result = await baseQuery(args, api, extraOptions);
    } else {
      if (typeof window !== 'undefined') {
        localStorage.removeItem('fx_access_token');
        localStorage.removeItem('fx_user');
        window.location.href = '/login';
      }
    }
  }

  return result;
};

export const baseApi = createApi({
  reducerPath: 'api',
  baseQuery: baseQueryWithReauth,
  tagTypes: ['Orders', 'Positions', 'Account', 'Backtest', 'Calendar'],
  endpoints: () => ({}),
});