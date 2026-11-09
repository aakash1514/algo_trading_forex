import { Injectable } from '@nestjs/common';

// Runs the work on one replay session strictly one after another: playback steps,
// orders, cancels, closes, commands and ending never interleave, so each reads the
// state the previous one saved. In-process only: replay-service runs as a single
// instance (a second instance would need a DB-level lock; roadmap step 7).
@Injectable()
export class SessionLock {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    const result = previous.then(work, work);
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(sessionId, tail);
    void tail.then(() => {
      if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId);
    });
    return result;
  }
}
