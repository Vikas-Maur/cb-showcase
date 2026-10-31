// R2-03: two parallel subagents, each making three dependent edits on the user's cut, while another person edits too:
// the user sees all six, each attributed to its subagent (port of system-v11 test/r2-03-subagents.test.mjs, on real
// processes and real Carton). Run with the app open (the engine thread holds the lease and every write goes to it
// over its control socket) and closed (no holder: the local cut's writes commit in each process through carton.db's
// CAS). Identities come from CARDBOARD_ACTOR as the PreToolUse prefixer sets it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { Rec } from "@carton/core";
import { openLocal } from "../src/open.ts";
import { subagentSuffix } from "../src/identity.ts";
import { adapter, bundle, doc0 } from "./support/real.ts";

const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
const run = (script: string, args: string[], env: Record<string, string> = {}) => {
  const p = spawn(process.execPath, [here(script), ...args], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, CARDBOARD_ACTOR: "", ...env } });
  const out = new Promise<any>((resolve, reject) => {
    let s = "";
    p.stdout!.on("data", (d) => (s += d));
    p.on("exit", (code) => (code === 0 && s.trim() ? resolve(JSON.parse(s.trim().split("\n").at(-1)!)) : reject(new Error(`${script} exited ${code}: ${s}`))));
  });
  return { p, out };
};

const ROUNDS = 3;
for (const appOpen of [true, false]) {
  test(`R2-03 two parallel subagents × three dependent edits on the user's cut: all six visible and attributed (app ${appOpen ? "open: through the engine thread's lease" : "closed: carton.db CAS"}), ${ROUNDS} rounds`, async (t) => {
    const stats = { writerCommits: 0, viaHolder: 0 };
    for (let k = 0; k < ROUNDS; k++) {
      const { dir, projectId } = bundle(`r203-${appOpen ? "open" : "closed"}`);
      const init = await openLocal({ projectDir: dir, projectId, adapter, init: { doc: doc0() }, actor: { kind: "human", id: "human:me", name: "me" } });
      await init.close();
      let worker: ReturnType<typeof run> | null = null;
      let workerPid: number | null = null;
      if (appOpen) {
        worker = run("./support/real-worker.ts", [dir, projectId]);
        workerPid = await new Promise<number>((r) => createInterface({ input: worker!.p.stdout! }).once("line", (l) => r(JSON.parse(l).pid)));
      }
      try {
        const writer = run("./support/writer.ts", [dir, projectId, "2500"]);
        const actorOf = (x: string) => `director/chat/turn1${subagentSuffix("editor", x)}`;
        const subs = ["A", "B"].map((x) => run("./support/subagent.ts", [dir, projectId, x], { CARDBOARD_ACTOR: actorOf(x) }));
        const [ra, rb] = await Promise.all(subs.map((s) => s.out));
        stats.writerCommits += (await writer.out).commits;
        for (const r of [ra, rb]) {
          assert.equal(r.results.length, 3);
          assert.deepEqual(r.holders, [workerPid, workerPid, workerPid], appOpen ? "every write went to the engine thread's lease holder" : "no holder: committed in-process");
          if (appOpen) stats.viaHolder += r.holders.length;
        }
        const check = await openLocal({ projectDir: dir, projectId, adapter, actor: { kind: "human", id: "human:me" } });
        try {
          const head = (await check.carton.head()).doc.timelineItems as Rec[];
          for (const x of ["A", "B"]) {
            const it = head.find((i) => i.id === `title-${x}`);
            assert.ok(it, `title-${x} exists`);
            assert.equal(it.textContent, `${x} v2`, `${x}'s second edit landed`);
            assert.deepEqual([it.startTime, it.endTime], [1, 4], `${x}'s third edit landed`);
          }
          assert.equal(head.filter((i) => i.trackId === "T2").length, 2, "no duplicate titles");
          const log = await check.carton.log({ limit: 10000 });
          const ids = log.map((v) => v.change).filter(Boolean);
          assert.equal(new Set(ids).size, ids.length, "no change id twice");
          for (const x of ["A", "B"]) {
            const mine = log.filter((v) => v.author?.id === actorOf(x));
            assert.equal(mine.length, 3, `three changes by sub-editor-${x}`);
            assert.ok(mine.every((v) => v.author?.agentType === "editor" && v.author?.agentId === x && v.author?.turn === "turn1"), "attributed down to the subagent");
            assert.equal((await check.carton.credits(["timelineItems", `title-${x}`]))?.id, actorOf(x), "credits name the subagent");
          }
        } finally {
          await check.close();
        }
      } finally {
        if (worker) { worker.p.stdin!.write("exit\n"); await new Promise((r) => worker!.p.on("exit", r)); }
      }
    }
    t.diagnostic(JSON.stringify({ rounds: ROUNDS, subagentEdits: ROUNDS * 6, ...stats }));
  });
}
