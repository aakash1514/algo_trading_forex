import { baseApi } from './base.api';
import type { LoginRequest, RegisterRequest, AuthResponse, AuthUser } from '../../types/api.types';
import { API_BASE } from '../../lib/constants';

export const authApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    login: build.mutation<AuthResponse, LoginRequest>({
      query: (body) => ({
        url: `${API_BASE.AUTH}/auth/login`,
        method: 'POST',
        body,
      }),
    }),
    register: build.mutation<AuthResponse, RegisterRequest>({
      query: (body) => ({
        url: `${API_BASE.AUTH}/auth/register`,
        method: 'POST',
        body,
      }),
    }),
    // Public: whether sign-up is open on this deployment (auth-service REGISTRATION_ENABLED)
    getAuthConfig: build.query<{ registrationEnabled: boolean }, void>({
      query: () => `${API_BASE.AUTH}/auth/config`,
    }),
    getMe: build.query<AuthUser, void>({
      query: () => `${API_BASE.AUTH}/auth/me`,
    }),
    logout: build.mutation<void, void>({
      query: () => ({
        url: `${API_BASE.AUTH}/auth/logout`,
        method: 'POST',
      }),
    }),
    refresh: build.mutation<{ accessToken: string }, void>({
      query: () => ({
        url: `${API_BASE.AUTH}/auth/refresh`,
        method: 'POST',
      }),
    }),
  }),
});

export const {
  useLoginMutation,
  useRegisterMutation,
  useGetAuthConfigQuery,
  useGetMeQuery,
  useLogoutMutation,
  useRefreshMutation,
} = authApi;