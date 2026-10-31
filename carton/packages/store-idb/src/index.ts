// Store plug-in on IndexedDB for browsers (PLAN §3.1, §15): one database per project, conditional batches in one
// readwrite transaction (no awaits on anything but IDB requests inside it, or the transaction auto-commits). The
// one-pusher rule across tabs uses Web Locks; tabs hear each other's writes on a BroadcastChannel. Owner: stores.
export { IdbStore, openIdbStore, deleteIdbStore, type IdbStoreOptions } from "./store.ts";
export { withPushLock, pushLockName, type PushLockOptions } from "./lock.ts";
