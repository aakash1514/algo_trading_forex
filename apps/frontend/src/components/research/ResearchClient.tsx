'use client';

import { useState, type FormEvent } from 'react';
import { useAskResearchMutation } from '../../store/api/research.api';
import {
  ASK_ERROR_MESSAGES,
  MAX_QUESTION_CHARS,
  RESEARCH_DISCLAIMER,
  askErrorKind,
  questionLength,
  questionProblem,
} from '../../lib/research';
import { cn } from '../../lib/cn';
import { ResearchReport } from './ResearchReport';

export function ResearchClient() {
  const [question, setQuestion] = useState('');
  const [ask, { data, error, isLoading }] = useAskResearchMutation();
  const length = questionLength(question);
  const problem = questionProblem(question);

  function submit(e: FormEvent) {
    e.preventDefault();
    // One request in flight: each call spends free LLM quota, and nothing retries automatically.
    if (isLoading || problem) return;
    void ask({ question: question.trim() });
  }

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4 max-w-4xl">
      <div className="rounded-lg border border-yellow-400/30 bg-yellow-400/10 px-4 py-2.5 text-[12px] text-yellow-300" role="note">
        {RESEARCH_DISCLAIMER} Answers cover the Dukascopy history (EUR/USD, GBP/USD, USD/JPY, XAU/USD, 2010-2022), your
        own backtest runs and the LSTM walk-forward evaluation; every number is checked against the data before it is shown.
      </div>

      <form onSubmit={submit} className="bg-terminal-surface border border-terminal-border rounded-lg p-4 space-y-2">
        <label htmlFor="research-question" className="block text-[10px] font-medium text-terminal-muted uppercase tracking-wider">
          Question
        </label>
        <textarea
          id="research-question"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          rows={3}
          className="w-full rounded border border-terminal-border bg-terminal-bg px-3 py-2 text-[13px] text-[#e2e4e9] focus:outline-none focus:border-accent-blue"
          placeholder="e.g. What was EUR/USD's return in 2022 on daily bars?"
        />
        <div className="flex items-center justify-between gap-3">
          <span className={cn('text-[11px] tabular-nums', problem === 'too_long' ? 'text-accent-red' : 'text-terminal-muted')}>
            {length}/{MAX_QUESTION_CHARS}
            {problem === 'too_long' && ` — ${ASK_ERROR_MESSAGES.too_long}`}
          </span>
          <button
            type="submit"
            disabled={isLoading || problem !== null}
            className="px-4 py-1.5 rounded bg-accent-blue text-white text-[12px] font-medium disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isLoading ? 'Researching...' : 'Ask'}
          </button>
        </div>
      </form>

      {isLoading && (
        <p className="text-[12px] text-terminal-muted" role="status">
          Researching your question. This can take up to about 90 seconds.
        </p>
      )}
      {!isLoading && error && (
        <p className="text-[12px] text-accent-red" role="alert">
          {ASK_ERROR_MESSAGES[askErrorKind(error)]}
        </p>
      )}
      {!isLoading && data && <ResearchReport report={data} />}
    </div>
  );
}
