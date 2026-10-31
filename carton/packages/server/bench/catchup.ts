// Catch-up cost per hello: CPU time, rows read and pages for a joiner catching up R small rows (the common case), on
// node:sqlite in memory. For the A/B of byte-paged catch-up, copy this file into a checkout of the parent commit
// (`7212a1e`, which pages by rows only) and run both, alternating, inside the CPU lock:
//   flock /tmp/gfv-race/cpu.lock node carton/packages/server/bench/catchup.ts <label> [rows=1000] [hellos=200]
// It prints one JSON line: the label, rows, the median and p90 CPU µs per full catch-up (every page), rows read and
// pages per catch-up.
import { loadavg } from "node:os";
import { createSequencer, type HostConnection } from "../src/index.ts";
import { sqliteStorage } from "../../conformance/src/system/sqlite.ts";
import type { Change } from "@carton/core";
import type { sync } from "@carton/core";

const label = process.argv[2] ?? "this";
const R = Number(process.argv[3] ?? 1000), H = Number(process.argv[4] ?? 200), WARM = 20;
const B = "bench-catchup";
const storage = sqliteStorage();
const auth = { kind: "static", async verify() { return null; } };
const seq = createSequencer({ storage, auth });
const items = Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, trackId: "V1", type: "video", name: `c${i}`, startTime: i * 5, endTime: i * 5 + 5, trimStart: 0, trimEnd: 5 }));
await seq.createBranch({ id: B, name: "b", forkOf: null, owner: "w", kind: "main", sequencer: { kind: "server", since: 0 } }, { doc0: { tracks: [{ id: "V1" }], timelineItems: items } as never, stateHash: "h0" });

const conn = (name: string): HostConnection & { inbox: sync.ServerMessage[] } => {
  const inbox: sync.ServerMessage[] = [];
  return { id: `${name}-${Math.random()}`, auth: { account: name, credential: `${name}/1`, role: "editor", projectId: "p", expires: Date.now() + 3600_000 }, send: (m) => void inbox.push(JSON.parse(JSON.stringify(m))), inbox };
};
const w = conn("writer");
await seq.handle(w, { type: "hello", branchId: B, have: 0, pending: [], rids: [], schemaVersion: 1 });
for (let i = 0; i < R; i++) {
  const id = `c${i % 40}`;
  const ch: Change = { id: `writer1.${i + 1}`, hash: "h", author: { kind: "human", id: "writer" }, branchId: B, base: { seq: i, pending: [] }, ops: [{ op: "set", path: ["timelineItems", id, "name"], value: `n${i}` }], intent: null, kinds: null, policy: "merge", at: 0, paths: [`timelineItems/${id}/name`], reads: [`timelineItems/${id}`], spans: [], trackOrder: [] };
  await seq.handle(w, { type: "push", branchId: B, epoch: 1, changes: [ch] });
}

const cpu: number[] = [];
let rowsRead = 0, pages = 0;
for (let h = 0; h < WARM + H; h++) {
  const c = conn("joiner");
  const r0 = storage.stats!().rowsRead;
  const t0 = process.cpuUsage();
  let have = 0, p = 0;
  for (;;) {
    c.inbox.length = 0;
    await seq.handle(c, { type: "hello", branchId: B, have, pending: [], rids: [], schemaVersion: 1 });
    const welcome = c.inbox.find((m) => m.type === "hello") as sync.WelcomeMsg;
    p++;
    have = welcome.rows.at(-1)?.seq ?? have;
    if (!welcome.more) break;
  }
  const t = process.cpuUsage(t0);
  seq.disconnect(c);
  if (h < WARM) continue;
  cpu.push(t.user + t.system);
  rowsRead += storage.stats!().rowsRead - r0;
  pages += p;
}
cpu.sort((a, b) => a - b);
const q = (f: number) => cpu[Math.min(cpu.length - 1, Math.floor(f * cpu.length))]!;
console.log(JSON.stringify({ label, node: process.version, load1: loadavg()[0], rows: R, hellos: H, cpuUsMedian: q(0.5), cpuUsP90: q(0.9), rowsReadPerCatchup: rowsRead / H, pagesPerCatchup: pages / H }));
