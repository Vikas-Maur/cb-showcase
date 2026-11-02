import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTEXT_CAP_BYTES, planShare, sourceFor, toMediaRecord, type Availability, type MediaUse } from "../src/tiers.ts";

test("the T0 record keeps only shareable fields: no paths, no blob URLs", () => {
  const r = toMediaRecord({
    id: "m1",
    kind: "video",
    fileName: "C:\\Users\\alice\\Videos\\take 1.mp4",
    src: "/Users/alice/take 1.mp4",
    thumbnail: "blob:abc",
    size: 1234,
    durationSec: 4,
    width: 1920,
    height: 1080,
  });
  assert.deepEqual(r, { id: "m1", kind: "video", fileName: "take 1.mp4", size: 1234, durationSec: 4, width: 1920, height: 1080 });
  assert.throws(() => toMediaRecord({ id: "x" }), TypeError);
});

test("sharing uploads T1 and the proxy, never originals unless opted in", () => {
  const rec = toMediaRecord({ id: "m", kind: "video", fileName: "a.mp4", size: 10 });
  const local = { original: true, t1: { poster: 10, peaks: 5, context: CONTEXT_CAP_BYTES + 1 } };
  const plan = planShare(rec, local, { originals: false });
  assert.deepEqual(plan.steps, [{ tier: "T1", kind: "poster" }, { tier: "T1", kind: "peaks" }, { tier: "T2", reuseHostProxy: false }]);
  assert.deepEqual(plan.skipped.map((s) => s.what), [".context"]);
  assert.deepEqual(planShare(rec, local, { originals: true }).steps.at(-1), { tier: "T3" });
  const done = { ...rec, t1: { poster: { hash: "h", size: 1 } }, proxy: { hash: "p", size: 1, profile: "x", encoder: "libx264" } };
  assert.deepEqual(planShare(done, local, { originals: false }).steps, [{ tier: "T1", kind: "peaks" }], "only what is missing moves");
  const img = toMediaRecord({ id: "i", kind: "image", fileName: "a.png", size: 1 });
  assert.deepEqual(planShare(img, { original: true, t1: {} }, { originals: false }).steps, [], "images have no proxy");
});

test("without originals, every use maps as PLAN §11's table says", () => {
  const proxyOnly: Availability = { original: "none", proxy: true, t1: { transcript: true, lut: true } };
  const expect: Record<MediaUse, [string, boolean]> = {
    preview: ["proxy", false],
    export: ["proxy", true],
    grab_frame: ["proxy", false],
    filmstrip: ["proxy", false],
    detect_scenes: ["proxy", false],
    transcribe_media: ["transcript", false],
    measure_loudness: ["proxy", true],
    probe_media: ["record", false],
    lut: ["lut", false],
    context: ["none", false],
    recipe: ["none", false],
    font: ["none", false],
  };
  for (const [use, [source, approximate]] of Object.entries(expect)) {
    const s = sourceFor(use as MediaUse, proxyOnly);
    assert.equal(s.source, source, use);
    assert.equal(s.approximate, approximate, use);
  }
  assert.equal(sourceFor("grab_frame", proxyOnly).ranged, true, "tools read the proxy by range");
  assert.equal(sourceFor("transcribe_media", { ...proxyOnly, t1: {} }).source, "proxy");
  const local: Availability = { original: "local", proxy: true, t1: {} };
  for (const use of ["preview", "export", "grab_frame", "measure_loudness"] as const) assert.equal(sourceFor(use, local).source, "original", use);
  assert.match(sourceFor("font", local).note!, /L4/);
});
