// Store plug-in on IndexedDB for browsers (PLAN §3.1, §15): one database per project, conditional batches in one
// readwrite transaction (no awaits on anything but IDB requests inside it, or the transaction auto-commits). The
// one-pusher rule across tabs uses Web Locks; tabs hear each other's writes on a BroadcastChannel. Owner: stores.
import type { Store } from "@carton/core/plugins";

const todo = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

export interface IdbStoreOptions {
  /** Default `carton:<projectId>`. */
  name?: string;
}

export async function openIdbStore(projectId: string, opts: IdbStoreOptions = {}): Promise<Store> {
  return todo("openIdbStore");
}

/** Run `fn` holding the project's push lock (Web Locks), so one tab pushes at a time. */
export async function withPushLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  return todo("withPushLock");
}
