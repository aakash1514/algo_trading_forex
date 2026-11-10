import {
  createApi,
  fetchBaseQuery,
  type BaseQueryFn,
  type FetchArgs,
  type FetchBaseQueryError,
} from '@reduxjs/toolkit/query/react';
import type { RootState } from '../index';
import { setCredentials, sessionExpired } from '../slices/auth.slice';
import { refreshSession } from '../../lib/session';

const baseQuery = fetchBaseQuery({
  baseUrl: '/',
  prepareHeaders(headers, { getState }) {
    const token = (getState() as RootState).auth.accessToken;
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return headers;
  },
  credentials: 'include',
});

// A 401 from these means bad credentials or an expired session, not a stale access token.
const AUTH_ENDPOINTS = /\/auth\/(login|register|refresh|logout)$/;

export const baseQueryWithReauth: BaseQueryFn<string | FetchArgs, unknown, FetchBaseQueryError> = async (
  args, api, extraOptions,
) => {
  let result = await baseQuery(args, api, extraOptions);
  const url = typeof args === 'string' ? args : args.url;

  if (result.error?.status === 401 && !AUTH_ENDPOINTS.test(url)) {
    // Shared single-flight refresh: concurrent 401s wait on the same call.
    const session = await refreshSession();
    if (session) {
      // Store the new token first; prepareHeaders reads it for the retry.
      api.dispatch(setCredentials(session));
      result = await baseQuery(args, api, extraOptions);
    } else {
      // The session ended (the refresh cookie expired or was revoked). AuthGuard redirects to
      // /login once isAuthenticated is false, and the login page says the session expired.
      api.dispatch(sessionExpired());
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
