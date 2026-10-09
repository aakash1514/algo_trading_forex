import { KeyedThrottle } from './keyed-throttle';

describe('KeyedThrottle', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('runs the first call immediately', () => {
    const throttle = new KeyedThrottle(1000);
    const task = jest.fn();
    throttle.run('a', task);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('collapses calls inside the window into one trailing call with the latest task', () => {
    const throttle = new KeyedThrottle(1000);
    const seen: number[] = [];
    for (let i = 1; i <= 5; i++) throttle.run('a', () => seen.push(i));

    expect(seen).toEqual([1]);
    jest.advanceTimersByTime(1000);
    expect(seen).toEqual([1, 5]);
  });

  it('never runs more than once per window for a key', () => {
    const throttle = new KeyedThrottle(1000);
    const task = jest.fn();
    // 10 calls/second for 3 seconds
    for (let t = 0; t < 30; t++) {
      throttle.run('a', task);
      jest.advanceTimersByTime(100);
    }
    jest.advanceTimersByTime(1000);
    expect(task.mock.calls.length).toBeLessThanOrEqual(4);
    expect(task.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('throttles keys independently', () => {
    const throttle = new KeyedThrottle(1000);
    const a = jest.fn();
    const b = jest.fn();
    throttle.run('a', a);
    throttle.run('b', b);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('forget() cancels a pending trailing call', () => {
    const throttle = new KeyedThrottle(1000);
    const task = jest.fn();
    throttle.run('a', task);
    throttle.run('a', task);
    throttle.forget('a');
    jest.advanceTimersByTime(2000);
    expect(task).toHaveBeenCalledTimes(1);
  });
});
