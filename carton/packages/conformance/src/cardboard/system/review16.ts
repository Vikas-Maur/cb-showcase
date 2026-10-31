// Regressions found by review round 16 (GPT 6.1 Sol), on the real engine, history and materializer. Round 15 built a
// state on a save that repeated a hidden edit at the save's own commit, on the cut the commit went to, and printed the
// view again there. The cut was the one current at the commit call, so a retry answered by id (core's dedup spans every
// cut) after a switch named the other cut; and a save the agent wrote on the print it had saved, landing while the
// reprint rendered, was taken against that print's state (a spurious card). Such a save is refused "re-print" (round 17:
// no base describes it).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { findRev, jsonTimelineCodec, type TimelineCodec } from "@carton/cardboard";
import { statusPath } from "@carton/cardboard/node";
import { openWorld, clip, find, render, parseFile, type Item } from "./world.ts";

const ripple = (its: Item[]) => void (Object.assign(find(its, "c"), { startTime: 10, endTime: 20 }), Object.assign(find(its, "d"), { startTime: 20, endTime: 30 }));

test("review 16 #1: a save committed on Main, its result lost, retried after a switch to Alt: built on Main's commit, not Alt's [real engine]", async (t) => {
  const w = await openWorld(t, { items: [clip("a", 0, 10), clip("c", 15, 25), clip("d", 25, 35)] });
  const main = w.carton.cut;
  const B = w.agent("director/c/t2", { hooked: true, actor: { turn: "t2" } });
  const { path: vb, name } = await w.mz.printView("vb", B.actor, { hooked: true });
  const v0 = await B.read(vb);
  const alt = await w.carton.fork("Alt");
  await w.carton.switchTo(alt.id);
  await w.remote(ripple); // Alt's seq 1
  await w.carton.switchTo(main);
  await w.remote(ripple); // Main's seq 1, hidden from B's print
  await w.tick(500);
  // B's save repeats the ripple (a reprint at its commit, Main's seq 2); recording its result fails once, after another
  // process switched to Alt: the retry is answered by id with Main's confirmation
  const put = w.engine.putMeta.bind(w.engine);
  let injected = false;
  w.engine.putMeta = async (key, val) => {
    if (!injected && key[0] === "attempt" && key[1] === vb && (val as { result?: unknown } | undefined)?.result) {
      injected = true;
      await w.carton.switchTo(alt.id);
      throw new Error("result write failed after the commit");
    }
    return put(key, val);
  };
  const items = structuredClone(v0.items);
  ripple(items);
  find(items, "a").name = "mine";
  w.writeAtomic(vb, render(v0, items));
  await w.tick(5000);
  w.engine.putMeta = put;
  assert.ok(injected);
  assert.deepEqual(w.mz.log.errors.filter((e) => !String(e.error).includes("result write failed")), [], "no pin of a state Alt doesn't hold");
  assert.equal(await w.engine.getMeta(["attempt", vb]), undefined, "the save finished");
  const rev = findRev(fs.readFileSync(w.abs(vb), "utf8"))!.rev!;
  assert.ok(rev.kind === "carton" && /@2~/.test(rev.ref), `printed again at the commit: ${rev.kind === "carton" ? rev.ref : rev.kind}`);
  const held = await w.engine.resolve(rev);
  assert.equal(held.baseSeq, 2);
  const shown = parseFile(fs.readFileSync(w.abs(vb), "utf8")).items;
  assert.deepEqual([find(shown, "a").name, find(shown, "d").startTime], ["mine", 20], "Main's commit, B's save in it");
  assert.equal((await w.carton.head(main)).ref.seq, 2, "one change on Main, not two");
  assert.equal(JSON.parse(fs.readFileSync(w.abs(statusPath(name)), "utf8")).status, "confirmed");
  await B.stop();
});

for (const race of [false, true])
  test(`review 16 #2, round 17: a save written on the print a reprint replaced${race ? ", landing while the reprint renders" : ", after the reprint"}: refused "re-print", no card; redone after a print, it lands [real engine]`, async (t) => {
    let during: (() => Promise<void>) | null = null;
    const codec: TimelineCodec = {
      ...jsonTimelineCodec,
      print: async (p, r) => {
        const f = during;
        during = null;
        await f?.();
        return jsonTimelineCodec.print(p, r);
      },
    };
    const w = await openWorld(t, { items: [clip("a", 0, 10), clip("c", 15, 25)], codec });
    const B = w.agent("director/c/t2", { hooked: true, actor: { turn: "t2" } });
    const { path: vb, name } = await w.mz.printView("vb", B.actor, { hooked: true });
    const v0 = await B.read(vb);
    await w.remote((its) => void (find(its, "c").name = "remote rename")); // hidden from B's print
    await w.tick(500);
    // B's first save repeats the hidden rename (a reprint at its commit) and sets a's opacity; its second, written on the
    // same print from B's own buffer, renames a, while a remote sets a's opacity again
    const first = structuredClone(v0.items);
    find(first, "c").name = "remote rename";
    find(first, "a").opacity = 0.5;
    const second = structuredClone(first);
    find(second, "a").name = "mine";
    const remoteThenSecond = async () => {
      await w.remote((its) => void (find(its, "a").opacity = 0.8));
      w.writeAtomic(vb, render(v0, second));
    };
    let reprints = 0;
    const pin = w.engine.pin.bind(w.engine);
    w.engine.pin = async (o) => {
      const p = await pin(o);
      if (o.owner.startsWith("turn:") && o.seq !== undefined && reprints++ === 0 && race) during = remoteThenSecond;
      return p;
    };
    w.writeAtomic(vb, render(v0, first));
    await w.tick(1000);
    if (!race) {
      await remoteThenSecond();
      await w.tick(1000);
    }
    w.engine.pin = pin;
    assert.equal(reprints, 1, "printed again once, at the first save's commit");
    const head = await w.head();
    assert.deepEqual([find(head, "a").name, find(head, "a").opacity, find(head, "c").name], ["a", 0.8, "remote rename"], "the second save is not applied");
    assert.deepEqual(w.mz.log.cards, [], "no card: neither 0.5 (B's own saved value) nor anything else");
    assert.deepEqual(w.mz.log.errors, []);
    const status = JSON.parse(fs.readFileSync(w.abs(statusPath(name)), "utf8"));
    assert.equal(status.status, "error");
    assert.match(status.error, /state unknown: re-print .*cb source print --view vb/);
    // as the status says: print the view again, redo the edit
    await w.mz.printView("vb", B.actor, { hooked: true });
    await B.read(vb);
    await B.editUntilDone(vb, (its) => void (find(its, "a").name = "mine"));
    await w.tick(1000);
    const end = await w.head();
    assert.deepEqual([find(end, "a").name, find(end, "a").opacity, find(end, "c").name], ["mine", 0.8, "remote rename"]);
    assert.deepEqual(w.mz.log.cards, []);
    assert.deepEqual(w.mz.log.errors, []);
    assert.equal(JSON.parse(fs.readFileSync(w.abs(statusPath(name)), "utf8")).status, "confirmed");
    // the replaced print stays refused after the new print: B's old buffer once more
    const third = structuredClone(second);
    find(third, "c").startTime = 16;
    w.writeAtomic(vb, render(v0, third));
    await w.tick(1000);
    assert.equal(find(await w.head(), "c").startTime, 15);
    assert.match(JSON.parse(fs.readFileSync(w.abs(statusPath(name)), "utf8")).error, /state unknown: re-print/);
    assert.deepEqual(w.mz.log.cards, []);
    await B.stop();
  });
