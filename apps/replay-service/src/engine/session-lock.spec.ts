import { SessionLock } from './session-lock';

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('SessionLock', () => {
  it('runs the work on one session one after another, in order', async () => {
    const lock = new SessionLock();
    const log: string[] = [];
    const job = (name: string, waits: number) => async () => {
      log.push(`${name} start`);
      for (let i = 0; i < waits; i++) await tick();
      log.push(`${name} end`);
      return name;
    };
    const results = await Promise.all([lock.run('s1', job('a', 3)), lock.run('s1', job('b', 1)), lock.run('s1', job('c', 0))]);
    expect(results).toEqual(['a', 'b', 'c']);
    expect(log).toEqual(['a start', 'a end', 'b start', 'b end', 'c start', 'c end']);
  });

  it('keeps going after a failure, and the failure reaches its caller', async () => {
    const lock = new SessionLock();
    const failed = lock.run('s1', async () => { throw new Error('boom'); });
    const next = lock.run('s1', async () => 'next');
    await expect(failed).rejects.toThrow('boom');
    await expect(next).resolves.toBe('next');
  });

  it('does not serialize different sessions', async () => {
    const lock = new SessionLock();
    const log: string[] = [];
    let release!: () => void;
    const blocked = lock.run('s1', () => new Promise<void>((resolve) => { release = resolve; }));
    await lock.run('s2', async () => { log.push('s2 ran'); });
    expect(log).toEqual(['s2 ran']);
    release();
    await blocked;
  });
});
