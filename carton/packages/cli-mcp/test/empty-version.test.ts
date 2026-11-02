// Laptop, build 915eb36: restoring "Started the cut" (main@0) emptied the project, and so did a new cut from it. The
// commands (cb, and the MCP tools that run them: undo_timeline with a rev, timeline_cuts new) refuse that version before
// anything is written, saying which version holds the project, and `cb history` marks it.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "@carton/core";
import { runCb } from "../src/cb.ts";
import type { CbProject } from "../src/commands.ts";
import { realProject } from "./support/real.ts";

const human: Actor = { kind: "human", id: "human:me", name: "me", group: "local:me@box" };
async function cb(project: CbProject, argv: string[]) {
  let out = "", err = "";
  const code = await runCb(argv, { cwd: ".", env: {}, stdout: (t) => (out += t), stderr: (t) => (err += t) }, { open: async () => project, actor: () => human });
  return { code, out: out.trim(), err: err.trim(), json: () => JSON.parse(out) };
}

test("cb restore, cut new --from and publish at main@0 say there is nothing there, and change nothing", async () => {
  const { local } = await realProject("cli-empty-version", human);
  try {
    await local.write({ kind: "commit", ops: [{ op: "set", path: ["timelineItems", "c1", "name"], value: "Cold open" }] });
    const head = await local.carton.head();
    const cuts = (await local.carton.cuts()).length;
    const why = /^Error: main@0 is where the history starts, before the project was added: there is nothing in it to (restore|make a cut from|publish)\. The project as it was first saved is main@1\.$/;
    for (const argv of [["restore", "main@0"], ["revert", "@0"], ["undo", "main@0"], ["cut", "new", "From the start", "--from", "main@0"], ["publish", "main@0"]]) {
      const r = await cb(local, argv);
      assert.equal(r.code, 1, argv.join(" "));
      assert.match(r.err, why, argv.join(" "));
    }
    const j = await cb(local, ["restore", "main@0", "--json"]);
    assert.deepEqual([j.json().status, j.json().code], ["error", "EMPTY_VERSION"]);
    assert.equal((await local.carton.head()).ref.seq, head.ref.seq, "no version made");
    assert.equal((await local.carton.cuts()).length, cuts, "no cut made");
    assert.equal((await local.carton.head()).doc.name, head.doc.name);
    // history marks it; main@1, the project as it came in, restores
    const h = await cb(local, ["history"]);
    assert.match(h.out.split("\n").at(-1)!, /^main@0\s+.*\sroot \(empty\)$/);
    assert.equal((await cb(local, ["history", "--json"])).json().versions.at(-1).empty, true);
    const ok = await cb(local, ["restore", "main@1"]);
    assert.equal(ok.code, 0, ok.err);
    assert.equal((await cb(local, ["cut", "new", "From the import", "--from", "main@1"])).code, 0);
  } finally {
    await local.close();
  }
});

// Laptop, final candidate P3-2: a later version an earlier build's bug emptied ("Restored an earlier version", main@4)
// was refused with "the history starts there", which only main@0 is. And P2-1: `cb undo` right after the Restore that
// brought such a project back undid it into the empty state (the app's open tab crashed). The schema's own rule says
// what holds nothing of the project (`Schema.empty`: here, as Cardboard's, no aspect ratio and nothing in it).
test("cb restore of a later empty version says what it is; cb undo never leaves the project empty", async () => {
  const { defineSchema } = await import("@carton/core");
  const { openLocal } = await import("@carton/local");
  const { bundle, schema, doc0 } = await import("./support/real.ts");
  const none = (v: unknown) => !Array.isArray(v) || !v.length;
  const empty = defineSchema({ ...schema, root: {}, collections: { tracks: { seq: true }, timelineItems: { parent: { field: "trackId", collection: "tracks" } } }, timeline: schema.timeline, empty: (d) => !d.aspectRatio && none(d.tracks) && none(d.timelineItems) });
  const adapter = { name: "test", schema: empty, schemaVersion: 1, fromHost: (h: any) => h, toHost: (d: any) => d };
  const { dir, projectId } = bundle("cli-empty-later");
  const local = await openLocal({ projectDir: dir, projectId, adapter, actor: human, init: { doc: { ...doc0(), aspectRatio: "16:9" } } });
  try {
    await local.write({ kind: "commit", doc: { tracks: [], timelineItems: [] } as any }); // main@2: the old bug's empty version
    await local.write({ kind: "commit", doc: { name: "Demo", tracks: [], timelineItems: [] } as any }); // main@3: named again
    for (const v of ["main@2", "main@3"]) {
      const r = await cb(local, ["restore", v]);
      assert.equal(r.code, 1, v);
      assert.equal(r.err, `Error: ${v} holds nothing of the project: there is nothing in it to restore. Pick another version (see \`cb history\`).`);
    }
    assert.equal((await cb(local, ["restore", "main@1"])).code, 0, "the project as it came in"); // main@4
    const head = await local.carton.head();
    const u = await cb(local, ["undo"]);
    assert.equal(u.code, 1, u.out + u.err);
    assert.equal(u.err, "Error: Can't undo that: the project would be left empty");
    assert.equal((await local.carton.head()).ref.seq, head.ref.seq, "no version made");
    assert.equal((await local.carton.head()).doc.aspectRatio, "16:9");
  } finally {
    await local.close();
  }
});
