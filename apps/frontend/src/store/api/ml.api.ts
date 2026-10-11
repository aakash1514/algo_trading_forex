import { baseApi } from './base.api';
import type { MlEvaluation, MlPredictions } from '../../types/api.types';
import { API_BASE } from '../../lib/constants';

// The ML service's historical walk-forward results (read-only)
export const mlApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    getMlEvaluation: build.query<MlEvaluation, void>({
      query: () => `${API_BASE.ML}/ml/evaluation`,
    }),
    getMlPredictions: build.query<MlPredictions, { instrument: string; from: string; to: string }>({
      query: ({ instrument, from, to }) =>
        `${API_BASE.ML}/ml/predictions/${instrument}?timeframe=1h&from=${from}&to=${to}`,
    }),
  }),
});

export const { useGetMlEvaluationQuery, useGetMlPredictionsQuery } = mlApi;
