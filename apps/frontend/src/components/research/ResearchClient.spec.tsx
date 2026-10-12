/** @jest-environment ./test/jsdom-with-fetch.cjs */
import { readFileSync } from 'fs';
import { join } from 'path';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { store } from '../../store';
import { setCredentials } from '../../store/slices/auth.slice';
import { ResearchClient } from './ResearchClient';
import { RESEARCH_DISCLAIMER } from '../../lib/research';

// Goes through the real askResearch mutation and fetchBaseQuery; only fetch is mocked, answering
// with the real recorded response bodies (__fixtures__/README.md).
const ASK_URL = 'http://localhost:3007/api/research/ask';
const recorded = (name: string, status = 200) =>
  new Response(readFileSync(join(__dirname, '__fixtures__', `${name}.json`)), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const answer = JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'answer.json'), 'utf8'));
const couldNotVerify = JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'could-not-verify-no-llm.json'), 'utf8'));
const askCalls = (spy: jest.SpyInstance) =>
  spy.mock.calls.filter((c) => (c[0] instanceof Request ? c[0].url : String(c[0])) === ASK_URL);

function setup() {
  render(
    <Provider store={store}>
      <ResearchClient />
    </Provider>,
  );
  const box = screen.getByLabelText('Question') as HTMLTextAreaElement;
  const button = screen.getByRole('button') as HTMLButtonElement;
  return { box, button };
}

describe('ResearchClient', () => {
  beforeEach(() => {
    jest.useFakeTimers(); // fetchBaseQuery's 100 s timeout timer must not outlive the test
    store.dispatch(setCredentials({ accessToken: 'tok', user: { id: 'u1' } as never }));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('always shows the disclaimer and needs a question before it can ask', () => {
    const spy = jest.spyOn(global, 'fetch');
    const { box, button } = setup();
    expect(screen.getByRole('note').textContent).toContain(RESEARCH_DISCLAIMER);
    expect(button.disabled).toBe(true);
    fireEvent.change(box, { target: { value: '   ' } });
    expect(button.disabled).toBe(true);
    fireEvent.change(box, { target: { value: answer.answer } });
    expect(button.disabled).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('allows one request in flight, says it can take ~90 s, then shows the real answer', async () => {
    let respond: (r: Response) => void = () => undefined;
    const spy = jest.spyOn(global, 'fetch').mockImplementation(() => new Promise<Response>((r) => (respond = r)));
    const { box, button } = setup();
    fireEvent.change(box, { target: { value: "  What was GBP/USD's return in 2021 on daily bars?  " } });
    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(true));
    expect(screen.getByRole('status').textContent).toContain('90 seconds');
    fireEvent.click(button);
    fireEvent.submit(box.form as HTMLFormElement);
    expect(askCalls(spy)).toHaveLength(1);
    expect(await (askCalls(spy)[0][0] as Request).json()).toEqual({
      question: "What was GBP/USD's return in 2021 on daily bars?",
    });
    await act(async () => respond(recorded('answer')));
    await waitFor(() => expect(screen.getByTestId('report-answer-text').textContent).toBe(answer.answer));
    expect(button.disabled).toBe(false);
    expect(askCalls(spy)).toHaveLength(1);
  });

  it.each([
    [503, 'Try again in a minute'],
    [429, 'Try again in a minute'],
    [500, 'Try again in a minute'],
  ])('shows a friendly message after a %i and does not retry', async (status, message) => {
    const spy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status }));
    const { box, button } = setup();
    fireEvent.change(box, { target: { value: 'Which pair moved most in 2020?' } });
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(message));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(120_000);
    });
    expect(askCalls(spy)).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(false);
  });

  it('reports a network error once, without retrying', async () => {
    const spy = jest.spyOn(global, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    const { box, button } = setup();
    fireEvent.change(box, { target: { value: 'Which pair moved most in 2020?' } });
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('could not be reached'));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('blocks a question over the backend limit without calling the service', () => {
    const spy = jest.spyOn(global, 'fetch');
    const { box, button } = setup();
    fireEvent.change(box, { target: { value: 'x'.repeat(501) } });
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/501\/500/).textContent).toContain('too long');
    fireEvent.submit(box.form as HTMLFormElement);
    expect(spy).not.toHaveBeenCalled();
  });

  it('shows only the warning for a real could_not_verify response', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(recorded('could-not-verify-no-llm'));
    const { box, button } = setup();
    fireEvent.change(box, { target: { value: "What was EUR/USD's return in 2022 on daily bars?" } });
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByTestId('report-could-not-verify')).toBeTruthy());
    expect(couldNotVerify.answer.length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain(couldNotVerify.answer);
  });
});
