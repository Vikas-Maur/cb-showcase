// A sequencer for the shared-cut tests: the in-process host of @carton/server on SQLite, with a token per account.
import type { AuthContext, AuthProvider, Store } from "@carton/core/plugins";
import { createInProcessHost } from "@carton/server";
import { sqliteStorage } from "../../conformance/src/system/sqlite.ts";
import { createMemoryStore } from "../src/index.ts";
import { schema } from "./fixture.ts";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until(pred: () => boolean | Promise<boolean>, ms = 5000, what = "condition"): Promise<void> {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/**
 * `opts`: the host's sequencer options (a small `maxBehind` and `keyframeEvery` force keyframe catch-ups;
 * `schemaVersion`: the newest document schema it accepts; a small `catchupBytes` pages catch-up and history).
 */
export function world(opts: { maxBehind?: number; keyframeEvery?: number; schemaVersion?: number; catchupBytes?: number } = {}) {
  const tokens = new Map<string, AuthContext>();
  const auth: AuthProvider = { kind: "table", async verify(t) { return tokens.get(t) ?? null; } };
  const host = createInProcessHost({ storage: sqliteStorage(), auth, timeline: schema.timeline!, groupOf: (c, f) => schema.collections[c]?.groupOf.get(f)?.name, ...opts });
  const token = (name: string) => {
    tokens.set(`tok-${name}`, { account: name, credential: `${name}/install`, role: "editor", projectId: "p", expires: Date.now() + 3600_000 });
    return `tok-${name}`;
  };
  const sync = (name: string, autoConnect = true) => ({ transport: host.transport, url: host.url, token: token(name), autoConnect });
  return { host, sync };
}
/** A copy of a store's tables (another machine that got the project with its shared cut). */
export async function copyStore(from: Store): Promise<Store> {
  const to = createMemoryStore();
  const data = (from as unknown as { data: { tables: Map<string, unknown> } }).data;
  for (const t of data.tables.keys()) {
    const rows = await from.range(t);
    if (rows.length) await to.write(rows.map((r) => ({ table: t, key: r.key, value: JSON.parse(JSON.stringify(r.value)) })));
  }
  return to;
}
