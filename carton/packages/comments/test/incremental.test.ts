// Incremental placement is never a different answer: after each of many random edits (moves, ripples, looks, deletes,
// inserts, splits with lineage, hidden tracks), the long-lived handle that re-places only what a change could move
// agrees with a fresh handle that places everything from scratch.
import test from "node:test";
import assert from "node:assert/strict";
import type { Doc, Rec } from "@carton/core";
import { toHost, fromHost } from "@carton/cardboard";
import { Comments } from "../src/comments.ts";
import { ME, clip, commitDoc, openCarton } from "./helpers.ts";

function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => ((x = (Math.imul(x ^ (x >>> 15), 2246822519) + 0x9e3779b9) >>> 0) / 2 ** 32);
}

const SEEDS = Array.from({ length: Number(process.env.COMMENTS_SEEDS ?? 6) }, (_, i) => i + 1);
for (const seed of SEEDS) {
  test(`random edits, seed ${seed}: incremental placements equal fresh ones after every version`, async () => {
    const r = rng(seed);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
    const items: Rec[] = [];
    for (const [t, track] of ["V1", "V2", "V3"].entries())
      for (let k = 0; k < 20; k++) items.push(clip(`i${t}-${k}`, k * 4 + t, k * 4 + t + 3, track, { mediaItemId: `m${Math.floor(r() * 25)}`, trimStart: Math.floor(r() * 5), trimEnd: 0 }));
    for (const it of items) it.trimEnd = (it.trimStart as number) + ((it.endTime as number) - (it.startTime as number));
    const carton = await openCarton(items);
    const live = await Comments.open({ carton, me: ME });
    for (let c = 0; c < 40; c++) {
      const s = Math.round(r() * 800) / 10;
      await live.add({ body: `note ${c}`, range: r() < 0.2 ? [s, s] : [s, s + Math.round(r() * 30) / 10] });
    }
    await live.placements();
    let n = 0;
    for (let step = 0; step < 30; step++) {
      const kind = pick(["move", "ripple", "look", "delete", "insert", "split", "hide", "move"]);
      const edits = (d: Doc): Doc => {
        const h = toHost(d);
        let list = [...h.timelineItems!];
        const tracks = [...(h.tracks as Rec[])];
        const i = Math.floor(r() * list.length);
        const it = list[i]!;
        const len = (it.endTime as number) - (it.startTime as number);
        if (kind === "move") {
          const to = Math.round(r() * 900) / 10;
          list[i] = { ...it, startTime: to, endTime: to + len };
        } else if (kind === "ripple") {
          const at = it.startTime as number;
          list = list.map((x) => (x.trackId === it.trackId && (x.startTime as number) > at ? { ...x, startTime: (x.startTime as number) - 1.5, endTime: (x.endTime as number) - 1.5 } : x));
        } else if (kind === "look") list[i] = { ...it, opacity: Math.round(r() * 10) / 10 };
        else if (kind === "delete") list.splice(i, 1);
        else if (kind === "insert") {
          const s = Math.round(r() * 900) / 10;
          list.push(clip(`n${step}`, s, s + 2, pick(["V1", "V2", "V3"]), { mediaItemId: `m${Math.floor(r() * 25)}` }));
        } else if (kind === "split") {
          const cut = (it.startTime as number) + len / 2;
          const off = cut - (it.startTime as number);
          list[i] = { ...it, endTime: cut, trimEnd: (it.trimStart as number) + off };
          list.push({ ...it, id: `${it.id}-s${step}`, startTime: cut, trimStart: (it.trimStart as number) + off });
        } else if (kind === "hide") {
          const t = Math.floor(r() * tracks.length);
          tracks[t] = { ...tracks[t]!, visible: tracks[t]!.visible === false };
        }
        return fromHost({ ...h, tracks, timelineItems: list }, d);
      };
      const { doc: before } = await carton.head();
      const target = (before.timelineItems as Rec[])[0];
      void target;
      const res = await carton.commit({ doc: edits(before), ...(kind === "split" ? { intent: { kind: "split" } } : {}) });
      if (res.status !== "confirmed") continue;
      n++;
      const inc = await live.placements();
      const fresh = await Comments.open({ carton, me: ME });
      const all = await fresh.placements();
      assert.deepEqual([...inc.entries()].sort(), [...all.entries()].sort(), `step ${step} (${kind})`);
      await fresh.close();
    }
    assert.ok(n >= 12, `most edits were versions (${n})`);
    await live.close();
  });
}

test("a split recorded with lineage: the incremental handle follows the new piece like a fresh one", async () => {
  const carton = await openCarton([clip("a", 0, 10, "V1", { mediaItemId: undefined }), clip("c", 10, 20, "V1", { mediaItemId: undefined })]);
  const live = await Comments.open({ carton, me: ME });
  const c = await live.add({ body: "here", range: [16, 17] });
  await live.placements();
  await commitDoc(carton, (d) => fromHost({ ...toHost(d), timelineItems: [clip("a", 0, 10, "V1", { mediaItemId: undefined }), clip("c", 10, 15, "V1", { mediaItemId: undefined, trimEnd: 5 }), clip("c-b", 15, 20, "V1", { mediaItemId: undefined, trimStart: 5, trimEnd: 10 })] }, d), { kind: "split", lineage: { c: ["c", "c-b"] } });
  const p = await live.placements();
  assert.deepEqual([p.get(c.id)?.status, p.get(c.id)?.items], ["exact", ["c-b"]]);
  await live.close();
});
