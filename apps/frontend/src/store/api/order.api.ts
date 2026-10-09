import { baseApi } from './base.api';
import type { Order, Position, AccountSummary, CreateOrderRequest } from '../../types/api.types';
import { API_BASE } from '../../lib/constants';

export const orderApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    getOrders: build.query<Order[], void>({
      query: () => `${API_BASE.ORDER}/orders`,
      providesTags: ['Orders'],
    }),
    createOrder: build.mutation<Order, CreateOrderRequest>({
      query: (body) => ({
        url: `${API_BASE.ORDER}/orders`,
        method: 'POST',
        headers: { 'X-Idempotency-Key': crypto.randomUUID() },
        body,
      }),
      invalidatesTags: ['Orders', 'Positions', 'Account'],
    }),
    cancelOrder: build.mutation<void, string>({
      query: (id) => ({
        url: `${API_BASE.ORDER}/orders/${id}`,
        method: 'DELETE',
      }),
      invalidatesTags: ['Orders'],
    }),
    getPositions: build.query<Position[], void>({
      query: () => `${API_BASE.ORDER}/positions`,
      providesTags: ['Positions'],
    }),
    closePosition: build.mutation<void, string>({
      query: (id) => ({
        url: `${API_BASE.ORDER}/positions/${id}`,
        method: 'DELETE',
      }),
      invalidatesTags: ['Positions', 'Account'],
    }),
    getAccountSummary: build.query<AccountSummary, void>({
      query: () => `${API_BASE.ORDER}/account/summary`,
      providesTags: ['Account'],
    }),
  }),
});

export const {
  useGetOrdersQuery,
  useCreateOrderMutation,
  useCancelOrderMutation,
  useGetPositionsQuery,
  useClosePositionMutation,
  useGetAccountSummaryQuery,
} = orderApi;