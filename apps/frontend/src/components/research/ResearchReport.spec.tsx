import { render, screen, within } from '@testing-library/react';
import { COULD_NOT_VERIFY_MESSAGE, ResearchReport } from './ResearchReport';
import type { ResearchReport as Report } from '../../types/api.types';
import answerFixture from './__fixtures__/answer.json';
import refusalFixture from './__fixtures__/refusal.json';
import notInDataFixture from './__fixtures__/not-in-data.json';
import couldNotVerifyFixture from './__fixtures__/could-not-verify-no-llm.json';

// Real recorded POST /api/research/ask responses (__fixtures__/README.md).
const answer = answerFixture as Report;
const refusal = refusalFixture as Report;
const notInData = notInDataFixture as Report;
const couldNotVerify = couldNotVerifyFixture as Report;

// SECURITY TEST INPUT, hand-written (not a recorded response): markup that would run if any report
// text were rendered as HTML. It is placed into a copy of the real answer fixture.
const XSS = '<img src=x onerror="window.__xss=1"><script>window.__xss=1</script><b>bold</b>';

describe('ResearchReport: answer', () => {
  it('shows the answer, the verified badge and the claims exactly as returned', () => {
    expect(answer.type).toBe('answer');
    expect(answer.claims.length).toBeGreaterThan(0);
    render(<ResearchReport report={answer} />);
    expect(screen.getByTestId('report-answer-text').textContent).toBe(answer.answer);
    expect(screen.getByText('verified')).toBeTruthy();
    const rows = screen.getAllByTestId('claim-row');
    expect(rows).toHaveLength(answer.claims.length);
    answer.claims.forEach((c, i) => {
      const cells = within(rows[i]).getAllByRole('cell').map((td) => td.textContent);
      expect(cells).toEqual([c.text, c.value, c.unit, c.tool_call_id]);
    });
    expect(screen.getByTestId('report-disclaimer').textContent).toBe(answer.disclaimer);
  });

  it('lists the tool calls with their arguments and results as plain text', () => {
    expect(answer.tool_calls.length).toBeGreaterThan(0);
    render(<ResearchReport report={answer} />);
    const log = screen.getByTestId('tool-call-log');
    expect(log.tagName).toBe('DETAILS');
    const items = within(log).getAllByTestId('tool-call');
    expect(items).toHaveLength(answer.tool_calls.length);
    answer.tool_calls.forEach((call, i) => {
      expect(items[i].textContent).toContain(call.id);
      expect(items[i].textContent).toContain(call.name);
      const [args, result] = Array.from(items[i].querySelectorAll('pre')).map((p) => p.textContent);
      expect(args).toBe(JSON.stringify(call.args));
      expect(result).toBe(call.result_truncated);
    });
  });

  it('shows the data ranges used', () => {
    expect(answer.data_ranges.length).toBeGreaterThan(0);
    render(<ResearchReport report={answer} />);
    const items = within(screen.getByTestId('report-data-ranges')).getAllByRole('listitem');
    expect(items).toHaveLength(answer.data_ranges.length);
    answer.data_ranges.forEach((r, i) => {
      expect(items[i].textContent).toContain(r.tool);
      for (const v of [r.pair, r.timeframe, r.from_date, r.to_date].filter(Boolean)) {
        expect(items[i].textContent).toContain(v as string);
      }
    });
  });
});

describe.each([
  ['refusal', refusal, 'Not answered'],
  ['not_in_data', notInData, 'Not in the data'],
])('ResearchReport: %s', (type, report, title) => {
  it('shows the answer text in a neutral box, with no badge or claims', () => {
    expect(report.type).toBe(type);
    expect(report.answer.length).toBeGreaterThan(0);
    render(<ResearchReport report={report} />);
    const box = screen.getByTestId(`report-${type}`);
    expect(within(box).getByText(title)).toBeTruthy();
    expect(within(box).getByRole('status').textContent).toBe(report.answer);
    expect(screen.queryByText('verified')).toBeNull();
    expect(screen.queryByTestId('claims-table')).toBeNull();
    expect(screen.getByTestId('report-disclaimer').textContent).toBe(report.disclaimer);
  });
});

describe('ResearchReport: could_not_verify', () => {
  it('shows only the warning and the disclaimer, never the report text, claims or failures', () => {
    expect(couldNotVerify.type).toBe('could_not_verify');
    expect(couldNotVerify.answer.length).toBeGreaterThan(0);
    expect(couldNotVerify.verification.failures.length).toBeGreaterThan(0);
    const { container } = render(<ResearchReport report={couldNotVerify} />);
    const text = container.textContent ?? '';
    expect(screen.getByRole('alert').textContent).toContain(COULD_NOT_VERIFY_MESSAGE);
    expect(screen.getByTestId('report-disclaimer').textContent).toBe(couldNotVerify.disclaimer);
    expect(text).not.toContain(couldNotVerify.answer);
    for (const f of couldNotVerify.verification.failures) expect(text).not.toContain(f);
    expect(screen.queryByTestId('claims-table')).toBeNull();
    expect(screen.queryByTestId('tool-call-log')).toBeNull();
    expect(screen.queryByText('verified')).toBeNull();
  });
});

describe('ResearchReport: plain text only', () => {
  it('renders markup from the model and the tools as literal text', () => {
    const hostile: Report = {
      ...answer,
      answer: XSS,
      claims: answer.claims.map((c) => ({ ...c, text: XSS })),
      tool_calls: answer.tool_calls.map((t) => ({ ...t, result_truncated: XSS })),
    };
    for (const report of [hostile, { ...refusal, answer: XSS }, { ...notInData, answer: XSS }]) {
      const { container, unmount } = render(<ResearchReport report={report} />);
      expect(container.querySelector('img, script, b')).toBeNull();
      expect(container.textContent).toContain(XSS);
      unmount();
    }
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
  });
});
