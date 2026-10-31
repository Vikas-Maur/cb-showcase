// Code that runs inside the test pages (headless Chromium). The Node side (idb.test.ts) imports this module in each
// page and calls its functions through page.evaluate.
import { storeCases, runStoreCase } from "../../conformance/src/store/suite.ts";
import { openIdbStore, deleteIdbStore, withPushLock, type IdbStore } from "../src/index.ts";

export interface CaseResult {
  name: string;
  ok: boolean;
  error?: string;
  ms: number;
}

let n = 0;
const fresh = () => `conf-${Date.now().toString(36)}-${++n}`;

/** Every Store conformance case on IndexedDB. Second handles are separate connections, as another tab has. */
export async function conformance(): Promise<CaseResult[]> {
  const out: CaseResult[] = [];
  for (const c of storeCases) {
    const id = fresh();
    const t0 = performance.now();
    try {
      await runStoreCase(c, () => openIdbStore(id), {
        second: () => openIdbStore(id),
        reopen: async (first) => {
          await first.close();
          return openIdbStore(id);
        },
      });
      out.push({ name: c.name, ok: true, ms: performance.now() - t0 });
    } catch (e) {
      out.push({ name: c.name, ok: false, error: (e as Error).stack ?? String(e), ms: performance.now() - t0 });
    } finally {
      await deleteIdbStore(id).catch(() => {});
    }
  }
  return out;
}

const open = new Map<string, IdbStore>();
async function store(id: string): Promise<IdbStore> {
  let s = open.get(id);
  if (!s) open.set(id, (s = await openIdbStore(id)));
  return s;
}

/** The local sequencer's append, `count` times, racing whatever other tabs do. */
export async function casAppend(id: string, tab: string, count: number): Promise<{ lostRaces: number }> {
  const s = await store(id);
  let lostRaces = 0;
  for (let i = 0; i < count; i++) {
    for (;;) {
      const top = await s.range("changes", { prefix: ["main"], reverse: true, limit: 1 });
      const seq = (top.length ? (top[0].key[1] as number) : 0) + 1;
      const change = `${tab}.${i}`;
      const ok = await s.write(
        [{ table: "changes", key: ["main", seq], value: { id: change, tab } }, { table: "ids", key: [change], value: ["main", seq] }],
        [{ table: "changes", key: ["main", seq], expect: "absent" }],
      );
      if (ok) break;
      lostRaces++;
    }
  }
  return { lostRaces };
}

export async function readLog(id: string): Promise<{ seqs: number[]; ids: string[]; idRows: number }> {
  const s = await store(id);
  const rows = await s.range<{ id: string }>("changes", { prefix: ["main"] });
  return { seqs: rows.map((r) => r.key[1] as number), ids: rows.map((r) => r.value.id), idRows: (await s.range("ids")).length };
}

export async function write(id: string, table: string, key: (string | number)[], value: unknown): Promise<boolean> {
  return (await store(id)).write([{ table, key, value }]);
}

export async function get(id: string, table: string, key: (string | number)[]): Promise<unknown> {
  return (await store(id)).get(table, key);
}

// What this tab's watch listener has heard, in order.
const heard: string[][] = [];
export async function watch(id: string): Promise<void> {
  (await store(id)).watch((tables) => heard.push([...tables]));
}
export const heardSoFar = () => heard;

// The push lock: hold it until `release(id)` (or the tab closes); report whether we got it.
const releases = new Map<string, () => void>();
export function holdPushLock(id: string): Promise<boolean> {
  return new Promise((got) => {
    void withPushLock(id, () => {
      got(true);
      return new Promise<void>((r) => releases.set(id, r));
    });
  });
}
export function release(id: string): void {
  releases.get(id)?.();
}
export async function tryPushLock(id: string): Promise<boolean> {
  return (await withPushLock(id, async () => true, { ifAvailable: true })) === true;
}
/** Start waiting for the lock; `waited()` reports when this tab got it. */
let gotAt = 0;
export function waitPushLock(id: string): void {
  void withPushLock(id, async () => {
    gotAt = performance.now();
    await new Promise(() => {}); // keep it
  });
}
export const waited = () => gotAt > 0;

export async function deleteDb(id: string): Promise<void> {
  await deleteIdbStore(id);
}
export async function afterDelete(id: string): Promise<string> {
  try {
    await (await store(id)).get("t", ["k"]);
    return "still open";
  } catch (e) {
    return (e as Error).message;
  }
}
