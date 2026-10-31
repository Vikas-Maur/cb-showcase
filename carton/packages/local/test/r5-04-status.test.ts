// R5-04: after each apply of a per-agent view, Carton writes `.scratch/views/<name>.status`
// {status: confirmed|pending|conflicts, ref, conflicts, diagnostics}; view names are distinct (hooked agents use their
// actor id, unhooked callers get a fresh name). Port of system-v11 test/r5-04-status.test.mjs on real processes: the
// app's engine thread holds the lease and runs the cardboard materializer; agents are separate processes that print
// with `cb source print --view`, save the file, and read the sidecar.
// Not covered here yet: the offline `pending` status and the late conflict flipping the sidecar. Both need shared
// cuts, which Carton doesn't route through its sync client yet (see notes).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { Rec } from "@carton/core";
import { openLocal } from "../src/open.ts";
import { adapter, bundle, doc0 } from "./support/real.ts";

const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));

const live = new Set<ReturnType<typeof spawn>>();
// a failed assertion must not leave a child holding the test process open through its pipes
const killAll = () => { for (const p of live) if (p.exitCode === null) p.kill("SIGKILL"); live.clear(); };

function proc(script: string, args: string[], env: Record<string, string> = {}) {
  const p = spawn(process.execPath, [here(script), ...args], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, CARDBOARD_ACTOR: "", CLAUDECODE: "", ...env } });
  live.add(p);
  p.on("exit", () => live.delete(p));
  const lines: any[] = [];
  const waiting: ((x: any) => void)[] = [];
  createInterface({ input: p.stdout! }).on("line", (l) => { const x = JSON.parse(l); const w = waiting.shift(); if (w) w(x); else lines.push(x); });
  const next = () => new Promise<any>((r) => (lines.length ? r(lines.shift()) : waiting.push(r)));
  return { p, next, send: (x: object) => p.stdin!.write(JSON.stringify(x) + "\n") };
}

async function app() {
  const { dir, projectId } = bundle("r504");
  // the starting state as the root (main@0): the seqs and credits below count only this test's own changes
  const init = await openLocal({ projectDir: dir, projectId, adapter, init: { doc: doc0(), asChange: false }, actor: { kind: "human", id: "human:me" } });
  await init.close();
  const worker = proc("./support/real-worker.ts", [dir, projectId, "./real-mz-factory.ts"]);
  await worker.next();
  return { dir, projectId, worker, stop: async () => { worker.p.stdin!.write("exit\n"); await new Promise((r) => worker.p.on("exit", r)); } };
}

test("R5-04 the agent reads its status after each save: confirmed, conflicts, diagnostics", async (t) => {
  const { dir, projectId, stop } = await app();
  try {
    const agent = proc("./support/view-agent.ts", [dir, projectId], { CARDBOARD_ACTOR: "director/c/t1" });
    const { printed } = await agent.next();
    assert.equal(printed.name, "director_c_t1", "a hooked agent's view is named after its actor id");
    const seen: string[] = [];

    agent.send({ set: [["c1", "name", "s1"]] });
    let s = (await agent.next()).status;
    assert.equal(s.status, "confirmed", JSON.stringify(s));
    assert.equal(typeof s.seq, "number");
    assert.match(s.ref, /@\d+~[0-9a-f]{8}( b:[0-9a-f]{8})?$/); // the full ref, as the materializer prints it
    seen.push(s.status);

    // another person trims c3 meanwhile (through the lease holder); the agent's view still shows 20
    const bob = await openLocal({ projectDir: dir, projectId, adapter, actor: { kind: "human", id: "human:bob", name: "bob" } });
    assert.equal((await bob.write({ kind: "commit", ops: [{ op: "set", path: ["timelineItems", "c3", "endTime"], value: 19 }, { op: "set", path: ["timelineItems", "c3", "trimEnd"], value: 4 }] })).status, "confirmed");
    agent.send({ set: [["c3", "endTime", 18.5], ["c3", "trimEnd", 3.5]] });
    s = (await agent.next()).status;
    assert.equal(s.status, "conflicts", JSON.stringify(s));
    assert.ok(s.conflicts.some((c: any) => c.path === "timelineItems/c3/#time"), "c3's time group is carded");
    const c3 = ((await bob.carton.head()).doc.timelineItems as Rec[]).find((i) => i.id === "c3")!;
    assert.deepEqual([c3.endTime, c3.trimEnd], [19, 4], "head keeps the other person's trim until someone chooses");
    seen.push(s.status);

    agent.send({ set: [["c4", "endTime", 19]] }); // c4 is 20..25: ends before it starts
    s = (await agent.next()).status;
    assert.ok(s.diagnostics.some((x: string) => /c4 ends at or before it starts/.test(x)), JSON.stringify(s));
    assert.equal(s.status, "conflicts", "the invalid clip is a card, not committed (hard validators in merge3)");
    assert.equal(((await bob.carton.head()).doc.timelineItems as Rec[]).find((i) => i.id === "c4")!.endTime, 25, "head keeps the valid clip");
    seen.push("diagnostics:" + s.status);
    await bob.close();
    agent.send({ exit: true });
    await new Promise((r) => agent.p.on("exit", r));
    t.diagnostic(JSON.stringify({ statusesSeen: seen }));
  } finally {
    await Promise.race([stop(), new Promise((r) => setTimeout(r, 10000))]);
    killAll();
  }
});

test("R5-04 unhooked agents never share a view file", async (t) => {
  const { dir, projectId, stop } = await app();
  try {
    const a1 = proc("./support/view-agent.ts", [dir, projectId]);
    const a2 = proc("./support/view-agent.ts", [dir, projectId]);
    const [p1, p2] = [(await a1.next()).printed, (await a2.next()).printed];
    assert.notEqual(p1.name, p2.name);
    assert.match(p1.name, /^agent-[0-9a-f]{4}$/);
    a1.send({ set: [["c0", "name", "from-1"]] });
    a2.send({ set: [["c1", "name", "from-2"]] });
    const [s1, s2] = [(await a1.next()).status, (await a2.next()).status];
    assert.equal(s1.status, "confirmed");
    assert.equal(s2.status, "confirmed");
    const check = await openLocal({ projectDir: dir, projectId, adapter, actor: { kind: "human", id: "human:me" } });
    const head = (await check.carton.head()).doc.timelineItems as Rec[];
    assert.deepEqual([head.find((i) => i.id === "c0")!.name, head.find((i) => i.id === "c1")!.name], ["from-1", "from-2"], "each save applied from its own file");
    const authors = (await check.carton.log({ limit: 3 })).filter((v) => v.change).map((v) => v.author?.id).sort();
    assert.deepEqual(authors, [`external:.scratch/views/${p1.name}.tsx`, `external:.scratch/views/${p2.name}.tsx`].sort());
    await check.close();
    for (const a of [a1, a2]) { a.send({ exit: true }); await new Promise((r) => a.p.on("exit", r)); }
    t.diagnostic(JSON.stringify({ views: [p1.name, p2.name] }));
  } finally {
    await Promise.race([stop(), new Promise((r) => setTimeout(r, 10000))]);
    killAll();
  }
});
