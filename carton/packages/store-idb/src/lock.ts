// One pusher per replica (§6.2, R3-01), in a browser: the tab that holds the project's Web Lock pushes and rebases
// the pending queue; every other tab of the origin waits in the lock's queue. A tab that closes or crashes releases
// the lock at once, so there is no heartbeat and no expiry to wait for, unlike carton.db's lease row.

export interface PushLockOptions {
  /** Stop waiting for the lock (it rejects with the signal's reason); has no effect once `fn` runs. */
  signal?: AbortSignal;
  /** Don't wait: when another tab holds the lock, resolve `undefined` without running `fn`. */
  ifAvailable?: boolean;
}

export const pushLockName = (projectId: string) => `carton:${projectId}:push`;

/** Run `fn` holding the project's push lock (Web Locks), so one tab pushes at a time. */
export async function withPushLock<T>(projectId: string, fn: () => Promise<T>, opts: PushLockOptions = {}): Promise<T> {
  const locks = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;
  if (!locks) return localLock(projectId, fn, opts);
  const options: LockOptions = { mode: "exclusive" };
  if (opts.ifAvailable) options.ifAvailable = true;
  else if (opts.signal) options.signal = opts.signal;
  return locks.request(pushLockName(projectId), options, (lock) => (lock ? fn() : (undefined as T))) as Promise<T>;
}

// Without Web Locks (an insecure page, an old runtime) the lock is per page only. Two pages could then both push;
// the server still applies each change once (stable ids, §6.2), so this is slower, never wrong.
const tails = new Map<string, Promise<unknown>>();
async function localLock<T>(projectId: string, fn: () => Promise<T>, opts: PushLockOptions): Promise<T> {
  const name = pushLockName(projectId);
  const before = tails.get(name);
  if (before && opts.ifAvailable) return undefined as T;
  opts.signal?.throwIfAborted();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const tail = (before ?? Promise.resolve()).then(() => mine);
  tails.set(name, tail);
  const done = () => {
    release();
    if (tails.get(name) === tail) tails.delete(name);
  };
  if (before) {
    // Waiting: an abort rejects at once. The place in the queue is still handed on in order, the moment the
    // predecessor releases, so the waiters behind this one neither skip ahead nor wait for nothing.
    const aborted = await new Promise<boolean>((resolve) => {
      const onAbort = () => resolve(true);
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      void before.then(() => {
        opts.signal?.removeEventListener("abort", onAbort);
        resolve(false);
      });
    });
    if (aborted) {
      void before.then(done);
      throw opts.signal!.reason;
    }
  }
  try {
    return await fn();
  } finally {
    done();
  }
}
