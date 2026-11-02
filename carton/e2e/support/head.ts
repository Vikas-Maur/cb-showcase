// What a machine's carton.db says head is, read in this process (a reader beside the app; never the user's data), and
// a wait that prefers the files the person sees.
import { existsSync, readFileSync } from "node:fs";
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

/** Whether a headless helper took this machine's lease at or after `since` (its `helper.log` says so). */
export function helperTookLeaseSince(m: Machine, since: number): boolean {
  const f = join(m.dbDir, "helper.log");
  if (!existsSync(f)) return false;
  return readFileSync(f, "utf8").split("\n").some((l) => {
    try { const e = JSON.parse(l); return e.kind === "helper" && e.type === "lease" && e.t >= since; } catch { return false; }
  });
}

/**
 * Waits for project.json to show a `cb` write. Strict: since B11's fix (local-cli 38814d9) a write served by any holder
 * reaches the app's files, so a miss here is a regression, never a known bug to step around.
 */
export async function untilShown(m: Machine, pred: (items: Item[]) => boolean, what: string, ms = 20_000): Promise<Item[]> {
  return until(() => { const it = items(m); return pred(it) && it; }, ms, `${what} in project.json`);
}

/** The item called `name` in a list of items. */
export const named = (list: Item[], name: string): Item | undefined => list.find((i) => i.name === name);
