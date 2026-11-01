// HostAdapter and IdentitySource conformance (PLAN §3.1, §4.3, §10): round trip, determinism, key stability,
// projection idempotence, one-clip GUI saves through the real fm∘sv (B10), and actor parsing. `cardboardSuite()` runs
// them on `@carton/cardboard` with the fixtures made by Cardboard's own CLI. Owner: cardboard-adapter.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonical, diff } from "@carton/core";
import type { Doc, Rec } from "@carton/core";
import type { HostAdapter, IdentitySource } from "@carton/core/plugins";
import { realProjection } from "./real-projection.ts";

export { realProjection } from "./real-projection.ts";

/** The invariants every HostAdapter must keep (plugins.ts), on the given host documents. */
export function hostAdapterSuite<H>(name: string, adapter: HostAdapter<H>, fixtures: { hosts: H[] }): void {
  const S = adapter.schema;
  fixtures.hosts.forEach((h, i) => {
    test(`${name} #${i}: toHost(fromHost(h)) keeps every versioned field; fromHost is deterministic`, () => {
      const d = adapter.fromHost(h, null);
      assert.equal(canonical(adapter.fromHost(h, null)), canonical(d), "same input, same doc, byte for byte");
      const back = adapter.fromHost(adapter.toHost(d), d);
      assert.deepEqual(diff(d, back, S), [], "a round trip is not a change");
    });
    test(`${name} #${i}: fromHost keeps base's sequence keys when nothing moved`, () => {
      const d = adapter.fromHost(h, null);
      const again = adapter.fromHost(adapter.toHost(d), d);
      assert.equal(canonical(again), canonical(d));
    });
    if (adapter.project)
      test(`${name} #${i}: the projection is idempotent`, () => {
        const p = adapter.project!(adapter.fromHost(h, null));
        assert.equal(canonical(adapter.project!(p)), canonical(p));
      });
  });
}

/** Actor parsing: each env gives exactly the expected actor (or null). */
export function identitySourceSuite(name: string, source: IdentitySource, cases: { env: Record<string, string>; expect: unknown }[]): void {
  test(`${name}: ${cases.length} environments`, () => {
    for (const c of cases) assert.deepEqual(source.current(c.env), c.expect, JSON.stringify(c.env));
  });
}

const fixture = (rel: string): string => readFileSync(fileURLToPath(new URL(`./fixtures/${rel}`, import.meta.url)), "utf8");

/** The Cardboard conformance tests on `@carton/cardboard`. */
export async function cardboardSuite(): Promise<void> {
  const C = await import("@carton/cardboard");
  const sample = JSON.parse(fixture("sample/project.json")) as { project: Rec };
  const before = JSON.parse(fixture("edit-trim-move-add-remove/project.before.json")) as { project: Rec };
  const after = JSON.parse(fixture("edit-trim-move-add-remove/project.after.json")) as { project: Rec };
  hostAdapterSuite("cardboard (CLI-made sample)", C.cardboardAdapter, { hosts: [sample.project, before.project, after.project] });
  hostAdapterSuite("cardboard + stand-in projection", C.createCardboardAdapter({ projection: C.standInProjection }), { hosts: [sample.project] });

  test("cardboard: a project.json written by Cardboard's CLI converts, round-trips and materializes back unchanged", () => {
    const d = C.fromHost(sample.project, null);
    const out = C.materializeProject(d, sample.project);
    assert.deepEqual(out, sample.project, "every field Cardboard wrote is kept, versioned or not");
  });

  test("cardboard: the CLI's apply of an agent edit diffs to exactly the records that edit touched", () => {
    const b = C.fromHost(before.project, null);
    const a = C.fromHost(after.project, b);
    const touched = new Set(diff(b, a, C.cardboardSchema).map((o) => (o.path.length > 1 ? `${String(o.path[0])}/${String(o.path[1])}` : String(o.path[0]))));
    // 1.4.0 reorders an item's JSON keys across writes: compare canonically
    const items = (p: Rec) => new Map(((p.timelineItems ?? []) as Rec[]).map((i) => [i.id as string, canonical(i)]));
    const bi = items(before.project), ai = items(after.project);
    const changed = new Set([...new Set([...bi.keys(), ...ai.keys()])].filter((id) => bi.get(id) !== ai.get(id)).map((id) => `timelineItems/${id}`));
    for (const t of touched) if (t.startsWith("timelineItems/")) assert.ok(changed.has(t), `${t} changed in the diff but not in Cardboard's apply`);
    for (const c of changed) assert.ok(touched.has(c), `${c} changed in Cardboard's apply but not in the diff`);
  });

  const P = realProjection();
  test("B10 with Cardboard's real fm∘sv: an agent places 60 frame-accurate clips, the human edits one other clip, and the GUI save touches exactly that clip", { skip: P ? false : "the 1.4.0 renderer bundle isn't on this machine" }, () => {
    const adapter = C.createCardboardAdapter({ projection: P! });
    const fps = 30;
    const q = (t: number) => Math.round(t * fps) / fps;
    const items: Rec[] = Array.from({ length: 60 }, (_, i) => ({ id: `a${i}`, trackId: "V1", type: "video", name: `a${i}`, startTime: q(i * 1.37), endTime: q(i * 1.37 + 1.03), trimStart: q(0.07 * i), trimEnd: q(0.07 * i + 1.03), opacity: 1, autoReframe: true }));
    items.push({ id: "h", trackId: "V1", type: "video", name: "h", startTime: 90, endTime: 95, trimStart: 0, trimEnd: 5, opacity: 1 });
    const base: Doc = C.fromHost({ name: "P", aspectRatio: "16:9", tracks: [{ id: "V1", name: "V1", order: 0, locked: false, visible: true, muted: false }], timelineItems: items }, null);
    const host = C.toHost(base);
    const save = { ...host, timelineItems: host.timelineItems!.map((i) => P!(i.id === "h" ? { ...i, opacity: 0.5 } : i)) };
    const naive = diff(base, C.fromHost(save, base), C.cardboardSchema);
    assert.ok(new Set(naive.map((o) => String(o.path[1]))).size > 1, "control: the GUI's lossy save, diffed directly, rewrites the agent's clips");
    const ops = diff(base, adapter.projectGuiSave!(base, save), C.cardboardSchema);
    assert.deepEqual([...new Set(ops.map((o) => String(o.path[1])))], ["h"]);
    assert.deepEqual(ops.map((o) => [o.op, o.path.join("/")]), [["set", "timelineItems/h/opacity"]]);
  });

  identitySourceSuite("cardboard CARDBOARD_ACTOR", C.cardboardIdentity, [
    { env: {}, expect: null },
    { env: { CARDBOARD_ACTOR: "director/c1/t1" }, expect: { kind: "agent", id: "director/c1/t1", name: "Director", provider: "claude-code", chat: "c1", turn: "t1" } },
    { env: { CARDBOARD_ACTOR: "director/c1/t1/sub-Explore-ab12" }, expect: { kind: "subagent", id: "director/c1/t1/sub-Explore-ab12", name: "Director › Explore", provider: "claude-code", chat: "c1", turn: "t1", agentType: "Explore", agentId: "ab12" } },
    { env: { CARDBOARD_ACTOR: "not an id" }, expect: null },
  ]);
}
