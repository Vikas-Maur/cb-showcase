// Carton UX v2 (N0) for agents, on real Carton and a real carton.db: `cb history --find`, `cb history --landmarks`,
// `cb restore <version> --clip`, `cb compare … --show`, and the words in place of a reference (sent, now, a version's
// name, a cut's name), in DESIGN-V2 §5's words.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "@carton/core";
import { runCb } from "../src/cb.ts";
import type { CbProject } from "../src/commands.ts";
import { mcpTools } from "../src/mcp.ts";
import { realProject } from "./support/real.ts";

const human: Actor = { kind: "human", id: "human:me", name: "me", group: "local:me@box" };
const director: Actor = { kind: "agent", id: "director/c1/t1", name: "Director", chat: "c1", turn: "t1", provider: "claude-code", group: "local:me@box" };
const set = (id: string, f: string, v: unknown) => ({ op: "set", path: ["timelineItems", id, f], value: v });

async function cb(project: CbProject, argv: string[], actor: Actor = human) {
  let out = "", err = "";
  const code = await runCb(argv, { cwd: ".", env: {}, stdout: (t) => (out += t), stderr: (t) => (err += t) }, { open: async () => project, actor: () => actor });
  return { code, out: out.trim(), err: err.trim(), json: () => JSON.parse(out) };
}

test("cb history --find and --landmarks: why each matched, newest first, refs at the end of each line", async () => {
  const { local } = await realProject("n0-find", human);
  try {
    await local.write({ kind: "commit", ops: [set("c0", "name", "Intro")] });
    await local.write({ kind: "commit", ops: [set("c0", "endTime", 4)] }, { actor: director });
    await local.carton.name({ branchId: local.carton.cut, seq: 3, pending: [] } as never, "Tighten the intro");
    await local.write({ kind: "commit", ops: [set("c1", "endTime", 9)] });
    await local.carton.name({ branchId: local.carton.cut, seq: 4, pending: [] } as never, "Sent to client");
    await local.carton.mark("exported", { label: "1080p for the client" });
    const f = await cb(local, ["history", "--find", "intro"]);
    assert.equal(f.code, 0, f.err);
    const lines = f.out.split("\n");
    assert.match(lines[0]!, /^The clip “Intro”: added by You today at .*, renamed by You today at .*, trimmed by Director today at .*\.$/);
    assert.match(lines[1]!, /^2 versions on Main cut mention “intro” \(newest first\):$/);
    assert.match(lines[2]!, /^  today \d+:\d\d [ap]m\s+Director\s+“Tighten the intro” · 1 change · “Intro” was 0:00–0:04 here\s+main@3$/);
    assert.match(lines[3]!, /^  today \d+:\d\d [ap]m\s+You\s+.*“Intro”.*main@2$/);
    // nothing found says what to try
    const none = await cb(local, ["history", "--find", "drone at night"]);
    assert.match(none.out, /^No versions on Main cut mention “drone at night”\.\nTry a clip's name, words from a title or caption, an agent's request, or a person\. Other cuts: --all-cuts$/);
    // landmarks: exported, named, the turn
    const l = await cb(local, ["history", "--landmarks"]);
    assert.equal(l.code, 0, l.err);
    assert.match(l.out, /^Landmarks on Main cut \(newest first\):/);
    assert.match(l.out, /Exported\s+1080p for the client · 0:30\s+main@4/);
    assert.match(l.out, /Named\s+“Sent to client”\s+main@4/);
    assert.match(l.out, /Director\s+“Tighten the intro” · 1 change\s+main@3/);
    assert.match(l.out, /Words that work in place of a reference: sent, exported, today, now, a version's name, a cut's name\.$/);
    // MCP
    const tools = mcpTools();
    const find = await tools.find((t) => t.name === "timeline_find")!.call({ project: local, actor: human }, { text: "sent client" });
    assert.match(find.text, /1 version on Main cut mentions “sent client”/);
  } finally {
    await local.close();
  }
});

test("cb restore <version> --clip: brought back, nothing else; not there then says how to take it out; two clips match", async () => {
  const { local } = await realProject("n0-clip", human);
  try {
    await local.write({ kind: "commit", ops: [set("c0", "name", "Intro"), set("c1", "name", "Interview A"), set("c2", "name", "Interview B")] }); // @2
    await local.carton.name({ branchId: local.carton.cut, seq: 2, pending: [] } as never, "Sent to client");
    await local.write({ kind: "commit", ops: [set("c0", "endTime", 3), set("c3", "endTime", 19)] }); // @3
    const r = await cb(local, ["restore", "sent", "--clip", "Intro"]);
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /^Brought back “Intro” as it was in “Sent to client” \(today at \d+:\d\d [ap]m\): now 0:00–0:05, was 0:00–0:03\.\nNothing else changed\. The user can undo it with Ctrl\+Z; you can with: cb undo$/);
    const { doc } = await local.carton.head();
    const items = Object.fromEntries((doc.timelineItems as any[]).map((x) => [x.id, x]));
    assert.equal(items.c0.endTime, 5);
    assert.equal(items.c3.endTime, 19, "nothing else changed");
    const v = (await local.carton.log({ limit: 1, summary: true, rows: true }))[0]!;
    assert.deepEqual(v.title, { kind: "bring-back", of: `${local.carton.cut}@2`, record: "timelineItems/c0", name: "Intro" });
    // two clips match
    const two = await cb(local, ["restore", "sent", "--clip", "Interview"]);
    assert.equal(two.code, 1);
    assert.equal(two.out, "Two clips match “Interview”: “Interview A” (0:05) and “Interview B” (0:10). Nothing changed. Name one.");
    // a clip that wasn't there then
    await local.write({ kind: "commit", ops: [{ op: "insert", path: ["timelineItems", "d1"], value: { id: "d1", trackId: "V1", name: "Drone shot", startTime: 20, endTime: 24, trimStart: 0, trimEnd: 4 } }] });
    const seq = (await local.carton.head()).ref.seq;
    const no = await cb(local, ["restore", "sent", "--clip", "Drone shot"]);
    assert.equal(no.code, 1);
    assert.equal(no.out, "“Drone shot” wasn't in “Sent to client” (today at " + no.out.match(/today at ([^)]+)\)/)![1] + "), so bringing that version back means taking it out (0:20–0:24). Nothing changed. To take it out: cb restore sent --clip 'Drone shot' --remove");
    assert.equal((await local.carton.head()).ref.seq, seq, "nothing written");
    const out = await cb(local, ["restore", "sent", "--clip", "Drone shot", "--remove"]);
    assert.equal(out.code, 0, out.err);
    assert.match(out.out, /^Took out “Drone shot”: it wasn't in “Sent to client” \(today at .*\)\. Nothing else changed\./);
    // a deleted clip comes back where it was
    await local.write({ kind: "commit", ops: [{ op: "remove", path: ["timelineItems", "c1"] }] });
    const back = await cb(local, ["restore", "sent", "--clip", "Interview A"]);
    assert.equal(back.code, 0, back.err);
    assert.match(back.out, /^Brought back “Interview A” \(deleted by the user today at .*\) where it was: 0:05 on its track\. Nothing else changed\./);
  } finally {
    await local.close();
  }
});

test("cb compare across cuts by name, and --show with no editor open: plain words, the comparison printed", async () => {
  const { local } = await realProject("n0-compare", human);
  try {
    await local.write({ kind: "commit", ops: [set("c0", "name", "Intro")] });
    const fork = await local.write({ kind: "fork", name: "30s Instagram cut" });
    assert.equal(fork.status, "confirmed");
    const insta = (fork as any).cut.id as string;
    await local.write({ kind: "commit", cut: insta, ops: [{ op: "remove", path: ["timelineItems", "c2"] }, set("c0", "endTime", 3)] });
    // a cut's name is that cut now; plain compare as before
    const plain = await cb(local, ["compare", "30s Instagram cut", "main", "--json"]);
    assert.equal(plain.code, 0, plain.err);
    assert.equal(plain.json().changes.length, 2);
    const show = await cb(local, ["compare", "30s Instagram cut", "main", "--show"]);
    assert.equal(show.code, 0, show.err);
    const lines = show.out.split("\n");
    assert.equal(lines[0], "No editor window has this project open, so nothing opened. Here is the comparison:");
    assert.equal(lines[1], "“30s Instagram cut” (now) with Main cut (the user's edit now): 2 differences:");
    assert.deepEqual(lines.slice(2).map((x) => x.trim()).sort(), ["0:00  “Intro” ends at 0:05 here, 0:03 in “30s Instagram cut”", "0:10  Only in Main cut: “c2”"].sort());
    // within one cut: changes, from a version to now
    const one = await cb(local, ["compare", "main@1", "now", "--show", "--json"]);
    assert.equal(one.json().between, "versions");
    assert.equal(one.json().opened, 0);
  } finally {
    await local.close();
  }
});
