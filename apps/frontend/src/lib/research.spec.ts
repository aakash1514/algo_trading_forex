import { ASK_ERROR_MESSAGES, MAX_QUESTION_CHARS, askErrorKind, questionLength, questionProblem } from './research';
import tooLong from '../components/research/__fixtures__/too-long.json';

describe('research question limits', () => {
  it('counts code points like the backend, not UTF-16 units', () => {
    const globe = '\u{1F310}';
    expect(globe.length).toBe(2);
    expect(questionLength(globe.repeat(MAX_QUESTION_CHARS))).toBe(MAX_QUESTION_CHARS);
    expect(questionProblem(globe.repeat(MAX_QUESTION_CHARS))).toBeNull();
    expect(questionProblem(globe.repeat(MAX_QUESTION_CHARS + 1))).toBe('too_long');
  });

  it('matches the backend limits at the boundaries', () => {
    expect(MAX_QUESTION_CHARS).toBe(500);
    expect(questionProblem('x'.repeat(500))).toBeNull();
    expect(questionProblem('x'.repeat(501))).toBe('too_long');
    expect(questionProblem('ab')).toBe('too_short');
    expect(questionProblem('abc')).toBeNull();
  });

  it('rejects empty and whitespace-only questions', () => {
    expect(questionProblem('')).toBe('empty');
    expect(questionProblem('   \n\t ')).toBe('empty');
    expect(questionLength('  abc  ')).toBe(3);
  });
});

describe('askErrorKind', () => {
  it('maps statuses to what the user is told', () => {
    expect(askErrorKind({ status: 429, data: {} })).toBe('busy');
    expect(askErrorKind({ status: 503, data: {} })).toBe('busy');
    expect(askErrorKind({ status: 'TIMEOUT_ERROR', error: 'AbortError' })).toBe('busy');
    expect(askErrorKind({ status: 'FETCH_ERROR', error: 'TypeError' })).toBe('network');
    expect(askErrorKind({ status: 401, data: {} })).toBe('session');
    expect(askErrorKind({ status: 500, data: {} })).toBe('server');
    expect(askErrorKind({ status: 'PARSING_ERROR', originalStatus: 200, data: '', error: 'x' })).toBe('server');
    expect(askErrorKind({ message: 'boom' })).toBe('server');
  });
});

// The body research-agent sends past the daily quota (asserted field for field in
// apps/research-agent/tests/test_quota.py) and when Redis is down
const DAILY_LIMIT_BODY = {
  detail: { code: 'daily_limit', message: 'Daily limit of 20 questions reached. It resets at 00:00 UTC.', limit: 20 },
};
const QUOTA_DOWN_BODY = { detail: { code: 'quota_unavailable', message: "The question limit can't be checked right now. Please try again later." } };

describe('askErrorKind and the daily quota', () => {
  it('the daily limit has its own message; any other 429 or a quota outage stays "busy"', () => {
    expect(askErrorKind({ status: 429, data: DAILY_LIMIT_BODY })).toBe('daily_limit');
    expect(ASK_ERROR_MESSAGES.daily_limit).toBe("You've reached today's limit of research questions. It resets at 00:00 UTC.");
    expect(askErrorKind({ status: 429, data: { detail: 'Too Many Requests' } })).toBe('busy');
    expect(askErrorKind({ status: 503, data: QUOTA_DOWN_BODY })).toBe('busy');
  });
});

describe('askErrorKind with the real 422 body', () => {
  it('tells the user the question is too long', () => {
    expect(tooLong.detail.length).toBeGreaterThan(0);
    expect(askErrorKind({ status: 422, data: tooLong })).toBe('too_long');
    expect(askErrorKind({ status: 422, data: {} })).toBe('invalid');
  });
});
