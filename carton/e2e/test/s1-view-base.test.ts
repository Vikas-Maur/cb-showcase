// §6.4's interleaved cases on real processes (cardboard-adapter's conformance runs them in one process):
//   - R4-02: an agent saves its per-agent view twice with a person's GUI change in between. The base of the second
//     save is the state of the first (same print nonce), so the agent's own first edit is never merged again: no card,
//     the person's values stay. Trim case: the agent trims Clip A's end, the person trims it further, the agent's
//     second save edits the logo. Ripple case: the agent closes the gap before the titles (a file edit: the remap is
//     inferred at commit), the person adds a title after them, the agent's second save renames the first title.
//   - R7-01: two terminal agents on the legacy shared timeline.tsx; one saves the title "B" from a fresh read, the
//     other then saves from an older read (still the old title) with an edit of its own. "B" is never silently
//     reverted, and the stale writer's edit lands.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeMachine, itemNamed, items, SAMPLE, type Machine } from "../support/project.ts";
import { Procs, type Proc } from "../support/procs.ts";
import { renameRetry, support, until } from "../support/env.ts";
import { cbOk } from "../support/cb.ts";

async function world(t: test.TestContext, name: string, config: Record<string, unknown> = {}) {
  const procs = new Procs();
  t.after(() => procs.close());
  const m = makeMachine(name);
  procs.watchHelpers(m.dbDir);
  const app = procs.start("app", [support("app.ts"), m.bundle, m.projectId, JSON.stringify(config)]);
  await app.next((x) => x.ready);
  return { procs, m, app };
}
const gui = (app: Proc, set: { name: string; field: string; value: unknown }[]) => app.ask({ cmd: "serve", req: { e2e: "gui", set } });

async function twoSaves(t: test.TestContext, name: string, first: unknown[], person: (m: Machine, app: Proc) => Promise<void>, second: unknown[]) {
  const { procs, m, app } = await world(t, name);
  const actor = "director/chatW/turn1/sub-editor-w1";
  const agent = procs.start(actor, [support("agent.ts"), m.bundle, m.projectId, JSON.stringify({ steps: [...first, { op: "wait" }, ...second] })], { env: { CARDBOARD_ACTOR: actor } });
  await agent.next((x) => x.waiting !== undefined, 120_000);
  await person(m, app);
  agent.p.stdin!.write("go\n");
  const out = await agent.next((x) => Array.isArray(x.results), 120_000);
  return { m, out, actor };
}

test("R4-02 trim: the agent trims Clip A's end, the person trims it further, the agent's next save edits the logo: no card, the person's trim stays", { timeout: 180_000 }, async (t) => {
  const { m, out } = await twoSaves(t, "s1-r402-trim",
    [{ op: "set", name: SAMPLE.clipA, set: { endTime: 1.25, trimEnd: 1.5 } }],
    async (mm, app) => {
      // the person sees the agent's trim in the editor (project.json shows head), then trims further; their save is
      // applied before the agent saves again. (Trimming from what the editor showed before would be a concurrent edit
      // of the same time group: a card for the person, rightly.)
      await until(() => itemNamed(mm, SAMPLE.clipA)?.endTime === 1.25, 20_000, "the editor to show the agent's trim");
      await gui(app, [{ name: SAMPLE.clipA, field: "endTime", value: 1 }, { name: SAMPLE.clipA, field: "trimEnd", value: 1.25 }]);
      await until(async () => (await cbOk(mm, ["history"])).versions[0].by?.id === "human:me", 20_000, "the person's trim applied");
    },
    [{ op: "set", name: SAMPLE.logo, set: { zIndex: 4 } }]);
  assert.deepEqual(out.results.map((r: any) => [r.status, r.conflicts.length]), [["confirmed", 0], ["confirmed", 0]], JSON.stringify(out.results));
  await until(() => itemNamed(m, SAMPLE.logo)?.zIndex === 4, 20_000, "the second save");
  const a = itemNamed(m, SAMPLE.clipA)!;
  if (a.endTime !== 1) {
    const h = await cbOk(m, ["history"]);
    const steps = [];
    for (let s = 2; s <= h.versions[0].ref.seq; s++) steps.push([s, h.versions.find((v: any) => v.ref.seq === s)?.by?.id, (await cbOk(m, ["compare", `main@${s - 1}`, `main@${s}`])).changes]);
    assert.fail(`the person's trim was lost: Clip A ends at ${a.endTime}; history ${JSON.stringify(steps)}; agent results ${JSON.stringify(out.results)}`);
  }
  assert.deepEqual([a.endTime, a.trimEnd], [1, 1.25], "the person's trim stays (the agent's own first trim isn't merged again)");
});

test("R4-02 ripple: the agent closes the gap before the titles, the person adds a title after them, the agent's next save renames the title: no card, the new title stays put", { timeout: 180_000 }, async (t) => {
  const badge = SAMPLE.badge;
  const { m, out } = await twoSaves(t, "s1-r402-ripple",
    // Title 0.5–2.5 and the badge 2.5–4 move left by 0.5 (the gap at 0–0.5 closes): a ripple, inferred at commit
    [{ op: "set", name: SAMPLE.title, set: { startTime: 0, endTime: 2 } }, { op: "set", name: badge, set: { startTime: 2, endTime: 3.5 } }],
    async (mm, app) => {
      // the person adds a title right after the badge (as the editor shows it after the agent's ripple): an insert the
      // agent's view never saw
      await until(() => itemNamed(mm, badge)?.startTime === 2, 20_000, "the editor to show the agent's ripple");
      await app.ask({ cmd: "serve", req: { e2e: "gui", insert: [{ like: SAMPLE.title, id: "title-h", name: "Title h", set: { startTime: 3.5, endTime: 4, trimStart: 0, trimEnd: 0.5 } }] } });
      await until(async () => (await cbOk(mm, ["history"])).versions[0].by?.id === "human:me" && itemNamed(mm, "Title h"), 20_000, "the person's insert");
    },
    [{ op: "set", name: SAMPLE.title, set: { textContent: "renamed" } }]);
  assert.deepEqual(out.results.map((r: any) => [r.status, r.conflicts.length]), [["confirmed", 0], ["confirmed", 0], ["confirmed", 0]], JSON.stringify(out.results));
  await until(() => itemNamed(m, SAMPLE.title)?.textContent === "renamed", 20_000, "the second save");
  assert.deepEqual([itemNamed(m, "Title h")!.startTime, itemNamed(m, "Title h")!.endTime], [3.5, 4], "the person's title stays where they put it (the ripple isn't applied to it again)");
  assert.deepEqual([itemNamed(m, SAMPLE.title)!.startTime, itemNamed(m, badge)!.startTime], [0, 2]);
  assert.equal(items(m).filter((i) => i.name === "Title h").length, 1);
});

test("R7-01 a stale writer on the shared timeline.tsx: the title another agent just saved is never silently reverted, and the stale writer's own edit lands", { timeout: 180_000 }, async (t) => {
  // freezeIdleMs short: a cb-less legacy agent freezes the shared file for a minute after each save (§6.4)
  const { m } = await world(t, "s1-r701", { freezeIdleMs: 500 });
  const shared = join(m.bundle, "timeline.tsx");
  const read = () => { const text = readFileSync(shared, "utf8"); const i = text.indexOf("\n{"); return { head: text.slice(0, i + 1), body: JSON.parse(text.slice(i + 1)) }; };
  const save = (f: { head: string; body: any }, name: string, set: Record<string, unknown>) => {
    const body = structuredClone(f.body);
    Object.assign(body.timelineItems.find((i: any) => i.name === name), set);
    writeFileSync(`${shared}.w.tmp`, f.head + JSON.stringify(body, null, 1) + "\n");
    renameRetry(`${shared}.w.tmp`, shared);
  };
  const stale = read(); // the second writer reads now and never again
  const fresh = read();
  save(fresh, SAMPLE.title, { textContent: "B" });
  await until(() => itemNamed(m, SAMPLE.title)?.textContent === "B", 20_000, "the first writer's title");
  await until(() => read().body.timelineItems.find((i: any) => i.name === SAMPLE.title).textContent === "B", 20_000, "timeline.tsx regenerated after the save (R7-01)");
  save(stale, SAMPLE.logo, { zIndex: 5 });
  await until(() => itemNamed(m, SAMPLE.logo)?.zIndex === 5, 20_000, "the stale writer's edit");
  assert.equal(itemNamed(m, SAMPLE.title)!.textContent, "B", "the title is kept, not reverted by the stale file");
  const h = await cbOk(m, ["history", "--limit", "10"]);
  assert.equal(h.versions.filter((v: any) => v.change && v.kind !== "import").length, 2, "two changes, one per save");
});
