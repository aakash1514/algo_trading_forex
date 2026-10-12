import { baseApi } from './base.api';
import type { ResearchReport } from '../../types/api.types';
import { API_BASE } from '../../lib/constants';
import { ASK_TIMEOUT_MS } from '../../lib/research';

// The research agent (read-only). A mutation: never cached and never retried, because every call
// spends free-tier LLM quota. baseQueryWithReauth re-sends only after a 401 (rejected before the agent runs).
export const researchApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    askResearch: build.mutation<ResearchReport, { question: string }>({
      query: ({ question }) => ({
        url: `${API_BASE.RESEARCH}/research/ask`,
        method: 'POST',
        body: { question },
        timeout: ASK_TIMEOUT_MS,
      }),
    }),
  }),
});

export const { useAskResearchMutation } = researchApi;
