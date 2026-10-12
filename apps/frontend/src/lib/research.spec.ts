import { MAX_QUESTION_CHARS, askErrorKind, questionLength, questionProblem } from './research';
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

describe('askErrorKind with the real 422 body', () => {
  it('tells the user the question is too long', () => {
    expect(tooLong.detail.length).toBeGreaterThan(0);
    expect(askErrorKind({ status: 422, data: tooLong })).toBe('too_long');
    expect(askErrorKind({ status: 422, data: {} })).toBe('invalid');
  });
});
