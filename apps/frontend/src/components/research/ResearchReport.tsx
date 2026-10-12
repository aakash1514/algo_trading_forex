'use client';

import type { ResearchDataRange, ResearchReport as Report } from '../../types/api.types';
import { ClaimsTable } from './ClaimsTable';
import { ToolCallLog } from './ToolCallLog';

// Every string from the report (the model's text, claim values, tool results) is rendered as a
// React text node: no HTML, no markdown, and numbers exactly as the verifier checked them.

const panel = 'bg-terminal-surface border border-terminal-border rounded-lg overflow-hidden';
const panelTitle = 'px-4 py-3 border-b border-terminal-border text-[10px] font-medium text-terminal-muted uppercase tracking-wider';

export const COULD_NOT_VERIFY_MESSAGE =
  'The research agent could not verify an answer, so nothing from it is shown. Try asking again in a minute, or rephrase the question.';

const NEUTRAL_TITLES = { refusal: 'Not answered', not_in_data: 'Not in the data' } as const;

function rangeText(r: ResearchDataRange): string {
  const parts = [r.pair, r.timeframe].filter((p): p is string => !!p);
  if (r.from_date || r.to_date) parts.push(`${r.from_date ?? '…'} to ${r.to_date ?? '…'}`);
  if (r.year !== null && r.year !== undefined) {
    parts.push(r.month ? `${r.year}-${String(r.month).padStart(2, '0')}` : String(r.year));
  }
  if (r.run_id) parts.push(`run ${r.run_id}`);
  return parts.join(' · ');
}

function Disclaimer({ text }: { text: string }) {
  return (
    <p className="px-4 py-2.5 border-t border-terminal-border text-[11px] text-terminal-muted" data-testid="report-disclaimer">
      {text}
    </p>
  );
}

export function ResearchReport({ report }: { report: Report }) {
  // An answer the verifier didn't pass is treated like could_not_verify (the service never sends one).
  if (report.type === 'could_not_verify' || (report.type === 'answer' && !report.verification.ok)) {
    return (
      <section className={panel} data-testid="report-could-not-verify">
        <div className="px-4 py-3 bg-yellow-400/10 text-[12px] text-yellow-300" role="alert">
          <span className="font-medium uppercase tracking-wider">Could not verify.</span> {COULD_NOT_VERIFY_MESSAGE}
        </div>
        <Disclaimer text={report.disclaimer} />
      </section>
    );
  }

  if (report.type === 'refusal' || report.type === 'not_in_data') {
    return (
      <section className={panel} data-testid={`report-${report.type}`}>
        <p className={panelTitle}>{NEUTRAL_TITLES[report.type]}</p>
        <p className="px-4 py-3 text-[12px] text-[#e2e4e9] whitespace-pre-wrap" role="status">
          {report.answer}
        </p>
        <Disclaimer text={report.disclaimer} />
      </section>
    );
  }

  return (
    <section className={panel} data-testid="report-answer">
      <div className="px-4 py-3 border-b border-terminal-border flex items-center gap-2">
        <span className="text-[10px] font-medium text-terminal-muted uppercase tracking-wider">Answer</span>
        <span className="text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded text-accent-green bg-accent-green/10">
          verified
        </span>
        <span className="text-[10px] text-terminal-muted">
          {report.verification.claims_checked} claims, {report.verification.numbers_checked} numbers checked
        </span>
      </div>
      <p className="px-4 py-3 text-[13px] text-[#e2e4e9] whitespace-pre-wrap" data-testid="report-answer-text">
        {report.answer}
      </p>
      <ClaimsTable claims={report.claims} />
      {report.data_ranges.length > 0 && (
        <div className="px-4 py-3 border-t border-terminal-border">
          <p className="text-[10px] text-terminal-muted uppercase tracking-wider mb-1">Data used</p>
          <ul className="text-[11px] text-[#e2e4e9] space-y-0.5" data-testid="report-data-ranges">
            {report.data_ranges.map((r, i) => (
              <li key={i}>
                <span className="text-terminal-muted">{r.tool}</span> {rangeText(r)}
              </li>
            ))}
          </ul>
        </div>
      )}
      <ToolCallLog calls={report.tool_calls} />
      <Disclaimer text={report.disclaimer} />
    </section>
  );
}
