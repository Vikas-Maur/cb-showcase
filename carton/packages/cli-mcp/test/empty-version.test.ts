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
