// The per-page fallback of withPushLock (no Web Locks): exclusive, FIFO, and an abort while queued rejects at once.
import { test } from "node:test";
import assert from "node:assert/strict";

// Run the module with navigator.locks hidden, as in an insecure page or an old runtime.
const saved = Object.getOwnPropertyDescriptor(globalThis, "navigator");
Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true });
const { withPushLock } = await import("../src/lock.ts");

test("fallback lock: one holder at a time, in order, and ifAvailable doesn't wait", async () => {
  const order: string[] = [];
  let releaseA!: () => void;
  const a = withPushLock("p", () => new Promise<void>((r) => { order.push("a"); releaseA = r; }));
  const b = withPushLock("p", async () => { order.push("b"); });
  const c = withPushLock("p", async () => { order.push("c"); });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(order, ["a"]);
  assert.equal(await withPushLock("p", async () => "ran", { ifAvailable: true }), undefined);
  releaseA();
  await Promise.all([a, b, c]);
  assert.deepEqual(order, ["a", "b", "c"]);
  assert.equal(await withPushLock("p", async () => "ran", { ifAvailable: true }), "ran");
});

test("fallback lock: aborting a queued request rejects at once, and the queue behind it still runs in order", async () => {
  let releaseA!: () => void;
  const order: string[] = [];
  const a = withPushLock("q", () => new Promise<void>((r) => { order.push("a"); releaseA = r; }));
  const ctl = new AbortController();
  const b = withPushLock("q", async () => { order.push("b"); }, { signal: ctl.signal });
  const c = withPushLock("q", async () => { order.push("c"); });
  await new Promise((r) => setTimeout(r, 10));
  const t0 = Date.now();
  ctl.abort(new Error("stop waiting"));
  await assert.rejects(b, /stop waiting/);
  assert.ok(Date.now() - t0 < 50, "rejected without waiting for the holder");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(order, ["a"], "c still waits for a");
  releaseA();
  await Promise.all([a, c]);
  assert.deepEqual(order, ["a", "c"]);
});

test("fallback lock: an abort during the hand-over (the holder just let go) still stops the request", async () => {
  let releaseA!: () => void;
  const a = withPushLock("h", () => new Promise<void>((r) => (releaseA = r)));
  const ctl = new AbortController();
  let ran = false;
  const b = withPushLock("h", async () => { ran = true; }, { signal: ctl.signal });
  await new Promise((r) => setTimeout(r, 5));
  releaseA();
  await a;
  // a's release resolves b's wait in a microtask; abort in the same turn, before b's callback can start
  ctl.abort(new Error("too late"));
  await assert.rejects(b, /too late/);
  assert.equal(ran, false);
  assert.equal(await withPushLock("h", async () => "free", { ifAvailable: true }), "free", "and the lock is free again");
});

test.after(() => {
  if (saved) Object.defineProperty(globalThis, "navigator", saved);
});
