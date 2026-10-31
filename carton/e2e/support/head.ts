// What a machine's carton.db says head is, read in this process (a reader beside the app; never the user's data), and
// a wait that prefers the files the person sees.
import type { test } from "node:test";
import { join } from "node:path";
import { Carton } from "@carton/core";
import type { HostAdapter } from "@carton/core";
import { openSqliteStore } from "@carton/store-sqlite";
import { cardboardAdapter, toHost } from "@carton/cardboard";
import { nodeHasher } from "@carton/local";
import { assertInScratch, until } from "./env.ts";
import { items, type Item, type Machine } from "./project.ts";

/** Head's timeline items, from carton.db. */
export async function headItems(m: Machine): Promise<Item[]> {
  const db = join(m.dbDir, "carton.db");
  assertInScratch(db, "carton.db");
  const store = await openSqliteStore(db);
  try {
    const c = await Carton.open({ adapter: cardboardAdapter as HostAdapter, store, hasher: nodeHasher, actor: { kind: "system", id: "e2e-reader", name: "e2e" } });
    try {
      return toHost((await c.head()).doc).timelineItems as Item[];
    } finally {
      await c.close();
    }
  } finally {
    await store.close();
  }
}

/**
 * Waits for project.json to show a `cb` write. If it never does but carton.db's head has it, the write landed outside
 * the app's lease holder (B3's takeover on a loaded machine) and the app's files missed it: that is B11, pinned by its
 * own test (s1-takeover-views.test.ts); here it is a diagnostic, and the scenario goes on from carton.db's head.
 */
export async function untilShown(t: test.TestContext, m: Machine, pred: (items: Item[]) => boolean, what: string, ms = 20_000): Promise<Item[]> {
  try {
    return await until(() => { const it = items(m); return pred(it) && it; }, ms, `${what} in project.json`);
  } catch (e) {
    const head = await headItems(m);
    if (!pred(head)) throw e;
    t.diagnostic(`B11 hit: ${what} is in carton.db's head but not in project.json (a write served outside the app's holder)`);
    return head;
  }
}

/** The item called `name` in a list of items. */
export const named = (list: Item[], name: string): Item | undefined => list.find((i) => i.name === name);
