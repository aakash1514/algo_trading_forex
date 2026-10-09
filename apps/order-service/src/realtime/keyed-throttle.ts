type Task = () => void;

interface KeyState {
  lastRun: number;
  timer?: ReturnType<typeof setTimeout>;
  pending?: Task;
}

// Runs at most one task per key per interval. Calls inside the window replace
// the pending task, which runs at the end of the window (trailing edge), so the
// latest value is always delivered and nothing is sent more than once per window.
export class KeyedThrottle {
  private readonly keys = new Map<string, KeyState>();

  constructor(
    private readonly intervalMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  run(key: string, task: Task): void {
    const state = this.keys.get(key) ?? { lastRun: Number.NEGATIVE_INFINITY };
    this.keys.set(key, state);

    const wait = state.lastRun + this.intervalMs - this.now();
    if (wait <= 0 && !state.timer) {
      state.lastRun = this.now();
      task();
      return;
    }

    state.pending = task;
    state.timer ??= setTimeout(() => {
      state.timer = undefined;
      const next = state.pending;
      state.pending = undefined;
      if (next) {
        state.lastRun = this.now();
        next();
      }
    }, Math.max(wait, 0));
  }

  // Drop any pending task for the key (e.g. the position was closed).
  forget(key: string): void {
    const state = this.keys.get(key);
    if (state?.timer) clearTimeout(state.timer);
    this.keys.delete(key);
  }

  clear(): void {
    for (const key of [...this.keys.keys()]) this.forget(key);
  }
}
