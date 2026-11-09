/** Native Web Locks boundary for DOM tests; browser tests also exercise the real cross-tab API. */
export class TestLocks implements LockManager {
  private readonly held = new Set<Lock>();
  private readonly queues = new Map<string, Promise<unknown>>();
  query(): Promise<LockManagerSnapshot> {
    return Promise.resolve({
      held: [...this.held].map(({ name, mode }) => ({ name, mode, clientId: 'test' })),
      pending: [],
    });
  }
  request<T>(name: string, callback: LockGrantedCallback<T>): Promise<T>;
  request<T>(name: string, options: LockOptions, callback: LockGrantedCallback<T>): Promise<T>;
  async request<T>(
    name: string,
    options: LockOptions | LockGrantedCallback<T>,
    callback?: LockGrantedCallback<T>,
  ): Promise<T> {
    const settings = typeof options === 'function' ? {} : options;
    const run = typeof options === 'function' ? options : callback;
    if (run === undefined) throw new TypeError('Missing lock callback');
    const prior =
      settings.mode === 'shared' ? Promise.resolve() : (this.queues.get(name) ?? Promise.resolve());
    const next = prior
      .catch(() => undefined)
      .then(async (): Promise<T> => {
        if (settings.signal?.aborted === true) throw new DOMException('Aborted', 'AbortError');
        const lock: Lock = { name, mode: settings.mode ?? 'exclusive' };
        this.held.add(lock);
        try {
          return await run(lock);
        } finally {
          this.held.delete(lock);
        }
      });
    if (settings.mode !== 'shared') this.queues.set(name, next);
    return await next;
  }
}
