// local-cli (notes/local-cli.md, "cardboard-adapter (low)"): a cut id core didn't make (a caller's own, one from an
// imported .cbproj or another host) printed a `b:` that neither the adapter's nor core's parser read back (core reads
// exactly 8 lowercase hex characters and finds the cut by prefix), so every save from that cut's files failed "state
// unknown: re-print". A cut name with " by " in it lost the header's nonce, so a view's last applied save was never
// its next base, and one with " b:" in it printed a broken ref. Any cut id and any cut name now round-trip; ids core
// makes print the same headers as before.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { branchToken, findRev, toHost } from "@carton/cardboard";
import { TIMELINE_FILE, statusPath } from "@carton/cardboard/node";
import { openWorld, clip, find, render, type Item } from "./world.ts";

const CASES: [string, string | undefined, string][] = [
  ["a dot in its first 8 characters", "b6b.alt", "Alt"],
  ["a dash in its first 8 characters", "ab-cdef01234", "Alt"],
  ["uppercase and non-ASCII characters", "ÉCLAT-Cut-1", "Alt"],
  ["a core-made id and a name with ' by ', ' p:' and ' b:' in it", undefined, "Version by Alice p:2 b:12345678"],
];

for (const [label, id, name] of CASES) {
  test(`cut ids (local-cli): on a cut with ${label}, saves from a view (twice from one print) and from the shared file are applied [real engine]`, async (t) => {
    const w = await openWorld(t, { items: [clip("X", 0, 10), clip("Y", 10, 20)], tracks: ["V1"] });
    const cut = await w.carton.fork(name, id ? { id } : {});
    await w.carton.switchTo(cut.id);
    await w.mz.onCutSwitch(cut.id);
    const rev = findRev(fs.readFileSync(w.abs(TIMELINE_FILE), "utf8"))?.rev;
    assert.ok(rev?.kind === "carton" && rev.branch8 === branchToken(cut.id) && rev.nonce, JSON.stringify(rev));
    // a view: two saves from one print, the second based on the first (keyed on the header's nonce read back)
    const agent = w.agent("director/c2/t2", { hooked: true, actor: { turn: "t2", chat: "c2" } });
    const { path: rel, name: view } = await w.mz.printView("v", agent.actor, { hooked: true });
    await agent.read(rel);
    await agent.editUntilDone(rel, (its) => void (find(its, "Y").name = "first"));
    await w.tick(2000);
    const first = JSON.parse(fs.readFileSync(w.abs(statusPath(view)), "utf8"));
    assert.equal(first.status, "confirmed", JSON.stringify(first));
    const row = await w.engine.getMeta<{ last: unknown }>(["view", view]);
    assert.ok(row?.last, "the save is the view's base for its next save");
    await agent.editUntilDone(rel, (its) => void (find(its, "X").name = "second"));
    await w.tick(2000);
    const second = JSON.parse(fs.readFileSync(w.abs(statusPath(view)), "utf8"));
    assert.equal(second.status, "confirmed", JSON.stringify(second));
    await agent.stop();
    // the shared file
    const A = w.agent("director/c/t1");
    await A.read();
    await A.editUntilDone(TIMELINE_FILE, (its) => void (find(its, "X").opacity = 0.5));
    await w.tick(2000);
    const head = await w.head();
    assert.equal(w.carton.cut, cut.id);
    assert.deepEqual([find(head, "Y").name, find(head, "X").name, find(head, "X").opacity], ["first", "second", 0.5]);
    assert.deepEqual(w.mz.log.errors, []);
  });
}

for (const after of ["", "rename", "switch"] as const) {
  const how = after === "rename" ? ", the printed one renamed after the print" : after === "switch" ? ", the other one current when it is read" : "";
  test(`cut ids (review 14 #5): two cuts with one b: token and one name${how}: the print resolves on the cut it was made on [real engine]`, async (t) => {
    const w = await openWorld(t, { items: [clip("X", 0, 10), clip("Y", 10, 20)], tracks: ["V1"] });
    // a twin whose id starts with b6b.alt's token (derived, never a hard-coded hash value)
    const twinId = `${branchToken("b6b.alt")}-other`;
    assert.equal(branchToken(twinId), branchToken("b6b.alt"), "the two ids share a token");
    const twin = await w.carton.fork("Alt", { id: twinId });
    const cut = await w.carton.fork("Alt", { id: "b6b.alt" });
    await w.carton.switchTo(cut.id);
    await w.mz.onCutSwitch(cut.id);
    await w.gui((its) => void (find(its, "X").opacity = 0.5)); // its seq is past the other cut's head
    await w.tick(1000);
    const agent = w.agent("director/c2/t2", { hooked: true, actor: { turn: "t2", chat: "c2" } });
    const { path: rel, name: view } = await w.mz.printView("v", agent.actor, { hooked: true });
    if (after === "rename") await w.carton.renameCut(cut.id, "Alt renamed");
    if (after === "switch") {
      // the twin is current now (preferring the current cut would pick it): the printed header still names b6b.alt's
      // state (a commit from it onto the twin then follows core's rule for a base on another cut)
      await w.carton.switchTo(twin.id);
      const rev = findRev(fs.readFileSync(w.abs(rel), "utf8"))!.rev!;
      const held = await w.engine.resolve(rev);
      assert.equal(find(toHost(held.baseDoc).timelineItems as Item[], "X").opacity, 0.5, "the state printed on b6b.alt");
      return;
    }
    await agent.read(rel);
    await agent.editUntilDone(rel, (its) => void (find(its, "Y").name = "saved"));
    await w.tick(2000);
    const status = JSON.parse(fs.readFileSync(w.abs(statusPath(view)), "utf8"));
    assert.equal(status.status, "confirmed", JSON.stringify(status));
    assert.equal(find(await w.head(), "Y").name, "saved", "the save lands on the current cut");
    assert.deepEqual(w.mz.log.errors, []);
    await agent.stop();
  });
}

/**
 * The token the adapter printed before core's `branchToken` (`cfa541a`, FNV-1a over the id's UTF-8) for an id core
 * didn't make: a fixture of the old format, to read an old header back. Never compared with a hard-coded value.
 */
const oldToken = (id: string): string => {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(id)) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
};

test("cut ids (core's branchToken): a header printed before it (FNV-1a) for an id core didn't make is refused 'state unknown: re-print', never applied to another cut; a re-print fixes it [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("X", 0, 10), clip("Y", 10, 20)], tracks: ["V1"] });
  const main = w.carton.cut;
  const id = "b6b.alt";
  const old = oldToken(id);
  assert.notEqual(old, branchToken(id), "core's token differs from the old one");
  // a decoy that the old header's b: now names (its id starts with the old token), under the same cut name, with a state
  // of its own at the printed seq
  const decoy = await w.carton.fork("Alt", { id: `${old}-decoy` });
  const cut = await w.carton.fork("Alt", { id });
  await w.carton.switchTo(decoy.id);
  await w.gui((its) => void (find(its, "X").name = "the decoy's edit"));
  await w.carton.switchTo(cut.id);
  await w.mz.onCutSwitch(cut.id);
  await w.gui((its) => void (find(its, "X").opacity = 0.5)); // the print's seq, on Alt
  await w.tick(1000);
  const agent = w.agent("director/c2/t2", { hooked: true, actor: { turn: "t2", chat: "c2" } });
  const { path: rel, name: view } = await w.mz.printView("v", agent.actor, { hooked: true });
  const r = await agent.read(rel);
  const oldHeader = r.header.replace(` b:${branchToken(id)} `, ` b:${old} `);
  assert.notEqual(oldHeader, r.header, "the view's header, as the adapter printed it before");
  const rev = findRev(oldHeader)!.rev!;
  await assert.rejects(w.engine.resolve(rev), /state unknown: re-print/);
  const heads = async () => Promise.all([cut.id, decoy.id, main].map(async (c) => JSON.stringify(toHost((await w.carton.head(c)).doc))));
  const before = await heads();
  // a save from a file with the old header
  w.writeAtomic(rel, render({ ...r, header: oldHeader }, r.items.map((i) => (i.id === "Y" ? { ...i, name: "from the old header" } : i))));
  await w.tick(2000);
  const status = JSON.parse(fs.readFileSync(w.abs(statusPath(view)), "utf8"));
  assert.equal(status.status, "error", JSON.stringify(status));
  assert.match(status.error, /state unknown: re-print/);
  assert.deepEqual(await heads(), before, "applied to no cut: not Alt, not the decoy");
  assert.deepEqual(w.mz.log.errors, []);
  // a re-print gives a header core reads back, and the save lands
  const again = await w.mz.printView("v", agent.actor, { hooked: true });
  await agent.read(again.path);
  await agent.editUntilDone(again.path, (its) => void (find(its, "Y").name = "after a re-print"));
  await w.tick(2000);
  assert.equal(JSON.parse(fs.readFileSync(w.abs(statusPath(view)), "utf8")).status, "confirmed");
  assert.equal(find(await w.head(), "Y").name, "after a re-print");
  assert.equal(w.carton.cut, cut.id);
  await agent.stop();
});
