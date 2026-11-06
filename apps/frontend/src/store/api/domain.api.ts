import { baseApi } from './base.api';
import type { SessionInfo, PipValueResponse, MarginResponse, CalendarEvent } from '../../types/api.types';
import { API_BASE } from '../../lib/constants';

export const domainApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    getCurrentSession: build.query<SessionInfo, void>({
      query: () => `${API_BASE.DOMAIN}/domain/sessions/current`,
    }),
    getPipValue: build.query<PipValueResponse, { pair: string; lots: number; accountCurrency: string }>({
      query: ({ pair, lots, accountCurrency }) =>
        `${API_BASE.DOMAIN}/domain/pip-value/${pair}/${lots}/${accountCurrency}`,
    }),
    calculateMargin: build.mutation<MarginResponse, { pair: string; lots: number; direction: string }>({
      query: (body) => ({
        url: `${API_BASE.DOMAIN}/domain/margin/calculate`,
        method: 'POST',
        body,
      }),
    }),
    getCalendarEvents: build.query<CalendarEvent[], { currency?: string; impact?: string }>({
      query: ({ currency, impact } = {}) => {
        const params = new URLSearchParams();
        if (currency) params.set('currency', currency);
        if (impact) params.set('impact', impact);
        return `${API_BASE.DOMAIN}/domain/calendar?${params.toString()}`;
      },
      providesTags: ['Calendar'],
    }),
  }),
});

export const {
  useGetCurrentSessionQuery,
  useGetPipValueQuery,
  useCalculateMarginMutation,
  useGetCalendarEventsQuery,
} = domainApi;