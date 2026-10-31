// R2-03: two parallel subagents, each making three dependent edits on the user's branch: the user sees all six.
// Run on the shared timeline.tsx (legacy flow, Claude Code's "modified since read, re-read") and on per-agent views
// (the documented flow), with a remote writer active throughout. Port of system-v11 `test/r2-03-subagents.test.mjs`.
import test from "node:test";
import assert from "node:assert/strict";
import { doc, clips, type World } from "../sim/world.ts";
import { Agent } from "../sim/agent.ts";
import { TIMELINE } from "../sim/replica.ts";
import { A, world, until, runFor, botWriter, assertConverged, report, ENGINE } from "../helpers.ts";

const title = (id: string, text: string): A.Item => ({ id, trackId: "T2", type: "text", name: id, textContent: text, startTime: 0, endTime: 3, trimStart: 0, trimEnd: 3, opacity: 1 });
const find = (d: A.SimDoc, id: string) => d.timelineItems!.find((i) => i.id === id);

// Three dependent steps: add a title, then retext it (needs it), then move it (needs the new text).
function steps(x: string): { ready: (d: A.SimDoc) => boolean; apply: (d: A.SimDoc) => void }[] {
  const id = `title-${x}`;
  return [
    { ready: () => true, apply: (d) => { d.timelineItems!.push(title(id, `${x} v1`)); } },
    { ready: (d) => !!find(d, id), apply: (d) => { find(d, id)!.textContent = `${x} v2`; } },
    { ready: (d) => find(d, id)?.textContent === `${x} v2`, apply: (d) => { Object.assign(find(d, id)!, { startTime: 1, endTime: 4 }); } },
  ];
}
// Claude Code's rhythm: read, think, edit; "modified since read" → re-read, think briefly, edit again.
async function runSub(w: World, sub: Agent, path: string, x: string) {
  for (const s of steps(x)) {
    await w.sim.sleep(w.sim.uni(2000, 8000));
    let d = (await sub.read(path)).doc;
    while (!s.ready(d)) { await w.sim.sleep(1000); d = (await sub.read(path)).doc; } // reads its own writes
    await w.sim.sleep(w.sim.uni(2000, 6000));
    await sub.editUntilDone(path, s.apply);
  }
}

async function scenario({ views, seed }: { views: boolean; seed: number }) {
  const w = world({ seed });
  const m1 = w.replica({ name: "m1", link: w.net.link({ rtt: 100 }) });
  const m2 = w.replica({ name: "m2-bob", link: w.net.link({ rtt: 100 }) });
  const b = w.shared(doc({ tracks: ["V1", "T2"], items: clips(8) }), [m1, m2]);
  await m1.startApp();
  await m2.startApp({ gui: false, materialize: false });
  botWriter(m2, { rate: 1, untilT: 200000, ids: clips(8).map((c) => c.id) });
  const mk = (x: string) => new Agent(m1, { name: `director/chat/turn1/sub-editor-${x}`, hooked: true, actor: { window: m1.worker!.window, turn: "turn1", agentId: x, agentType: "editor" } });
  const subs = [mk("A"), mk("B")];
  let paths = [TIMELINE, TIMELINE];
  if (views) paths = await until(w, Promise.all(subs.map(async (s) => (await s.cb({ kind: "printView" })).path as string)));
  await until(w, Promise.all(subs.map((s, i) => runSub(w, s, paths[i]!, ["A", "B"][i]!))));
  await runFor(w, 3000);
  for (const s of subs) s.stop();
  await runFor(w, 70000); // freeze ends; the remote writer stops at 200 s
  await runFor(w, Math.max(0, 210000 - w.sim.now));
  return { w, b, m1, m2, subs };
}

const SEEDS = 10;
export function register(): void {
  for (const views of [false, true]) {
    test(`R2-03 two parallel subagents × three dependent edits on the user's branch: all six visible (${views ? "per-agent views" : "shared timeline.tsx"}), ${SEEDS} seeds [${ENGINE}]`, async (t) => {
      const out = { refusals: 0, retries: 0, remoteChanges: 0 };
      for (let k = 0; k < SEEDS; k++) {
        const { w, b, m1, m2, subs } = await scenario({ views, seed: (views ? 1000 : 2000) + k });
        const head = m1.store.optimistic(b).doc as A.SimDoc;
        for (const x of ["A", "B"]) {
          const it = A.item(head, `title-${x}`);
          assert.ok(it, `title-${x} exists`);
          assert.equal(it.textContent, `${x} v2`, `${x}'s second edit landed`);
          assert.deepEqual([it.startTime, it.endTime], [1, 4], `${x}'s third edit landed`);
        }
        assert.equal(head.timelineItems!.filter((i) => i.type === "text").length, 2, "no duplicate titles");
        const rows = w.server.branches.get(b)!.rows;
        for (const [i, x] of [[0, "A"], [1, "B"]] as const) {
          const touching = rows.filter((r) => r.ops.some((o) => o.path[1] === `title-${x}`));
          assert.ok(touching.length >= 3, `three changes on title-${x}`);
          assert.ok(touching.every((r) => r.author.id === subs[i]!.actor.id), `all attributed to sub-editor-${x}`);
        }
        if (!views) {
          const file = m1.fs.read(TIMELINE)!.content;
          assert.ok(file.includes("A v2") && file.includes("B v2"), "after the freeze the shared file shows both");
        }
        assert.equal(m1.worker!.materializer!.superseded.length, 0, "no save replaced before it was applied");
        assertConverged(w, b, [m1, m2]);
        out.refusals += subs[0]!.stats.refusals + subs[1]!.stats.refusals;
        out.retries += subs[0]!.stats.retries + subs[1]!.stats.retries;
        out.remoteChanges += rows.filter((r) => r.author.id === "human:m2-bob").length;
      }
      report(t, { seeds: SEEDS, subagentEdits: SEEDS * 6, ...out });
    });
  }
}
