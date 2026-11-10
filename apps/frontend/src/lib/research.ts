import type { FetchBaseQueryError } from '@reduxjs/toolkit/query';
import type { SerializedError } from '@reduxjs/toolkit';

// Mirrors research-agent's AskRequest (MIN 3, MAX_QUESTION_CHARS 500 in research_agent/main.py).
// Pydantic counts Unicode code points, so count them here too (String.length counts UTF-16 units).
export const MIN_QUESTION_CHARS = 3;
export const MAX_QUESTION_CHARS = 500;

// Same text as research-agent's DISCLAIMER (research_agent/domain.py); every report also carries it.
export const RESEARCH_DISCLAIMER =
  "Historical analysis of ForexEdge's own data only; not financial advice, and nothing here is a signal to buy or sell.";

// The agent's wall-clock budget is 90 s; the client waits a little longer.
export const ASK_TIMEOUT_MS = 100_000;

export function questionLength(question: string): number {
  return Array.from(question.trim()).length;
}

export function questionProblem(question: string): 'empty' | 'too_short' | 'too_long' | null {
  const n = questionLength(question);
  if (n === 0) return 'empty';
  if (n < MIN_QUESTION_CHARS) return 'too_short';
  if (n > MAX_QUESTION_CHARS) return 'too_long';
  return null;
}

export type AskErrorKind = 'too_long' | 'invalid' | 'daily_limit' | 'busy' | 'network' | 'session' | 'server';

export const ASK_ERROR_MESSAGES: Record<AskErrorKind, string> = {
  too_long: `The question is too long (at most ${MAX_QUESTION_CHARS} characters).`,
  invalid: `The question was rejected; it needs ${MIN_QUESTION_CHARS} to ${MAX_QUESTION_CHARS} characters.`,
  daily_limit: "You've reached today's limit of research questions. It resets at 00:00 UTC.",
  busy: 'The research agent is busy or took too long. Try again in a minute.',
  network: 'The research agent could not be reached. Check your connection and that the service is running.',
  session: 'Your session has expired. Log in again.',
  server: 'The research agent failed to answer. Try again in a minute.',
};

function isFetchError(e: unknown): e is FetchBaseQueryError {
  return typeof e === 'object' && e !== null && 'status' in e;
}

export function askErrorKind(error: FetchBaseQueryError | SerializedError): AskErrorKind {
  if (!isFetchError(error)) return 'server';
  const { status } = error;
  // research-agent's per-user daily quota (research_agent/quota.py), not the model being busy
  if (status === 429 && (error.data as { detail?: { code?: string } } | undefined)?.detail?.code === 'daily_limit') {
    return 'daily_limit';
  }
  if (status === 'TIMEOUT_ERROR' || status === 429 || status === 503) return 'busy';
  if (status === 'FETCH_ERROR') return 'network';
  if (status === 401) return 'session';
  if (status === 422) {
    const detail = (error.data as { detail?: { type?: string }[] } | undefined)?.detail;
    return Array.isArray(detail) && detail.some((d) => d?.type === 'string_too_long') ? 'too_long' : 'invalid';
  }
  return 'server';
}
