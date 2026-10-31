// Request 6 (foundation `fb7f4e9`): the B11 follower adopts a cut switch another process stored in meta ["current"]
// without writing that row again (`switchTo(cut, { persist: false })`). Before, the adoption wrote it, so a third
// process's switch made between the follower's re-read and its adoption was overwritten: the machine's current cut
// went back to the one adopted, and the app showed it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { Carton } from "@carton/core";
import type { Actor } from "@carton/core";
import { openSqliteStore } from "@carton/store-sqlite";
import { followStore } from "../src/follow.ts";
import { adapter, doc0 } from "./support/real.ts";
import { scratch } from "./support/scratch.ts";

const actor: Actor = { kind: "agent", id: "req6", name: "Request 6", group: "req6" };

test("request 6: the follower's adoption never overwrites a switch a third process stored meanwhile; it then follows that one", async () => {
  const path = join(mkdtempSync(join(scratch(), "req6-")), "carton.db");
  const [s, os, ts] = [await openSqliteStore(path), await openSqliteStore(path), await openSqliteStore(path)];
  const app = await Carton.open({ adapter, store: s, actor, init: { doc: doc0() } });
  const other = await Carton.open({ adapter, store: os, actor });
  const third = await Carton.open({ adapter, store: ts, actor });
  const main = app.cut, alt = (await app.fork("Alt")).id, b = (await app.fork("B")).id;
  const name = (cut: string | undefined) => (cut === alt ? "Alt" : cut === b ? "B" : cut === main ? "Main" : String(cut));
  // the third process switches to B in the instant between the follower's re-read (under the cut lock) and its adoption
  const adopt = app.switchTo.bind(app);
  let injected = false;
  app.switchTo = async (cut, o) => {
    if (!injected) { injected = true; await third.switchTo(b); }
    return adopt(cut, o);
  };
  const told: string[] = [];
  const f = followStore(app, s, { intervalMs: 0, onHead: () => {}, onCut: (cut) => void told.push(name(cut)) })!;
  try {
    await f.check();
    await other.switchTo(alt);
    await f.check();
    assert.ok(injected, "the third process switched during the adoption");
    assert.equal(name(await os.get<string>("meta", ["current"])), "B", "the third process's switch stands: the adoption wrote nothing");
    // the third process's write is news at the next look: the app follows it
    await f.check();
    assert.equal(name(app.cut), "B");
    assert.deepEqual(told, ["Alt", "B"]);
    assert.equal(name(await os.get<string>("meta", ["current"])), "B");
  } finally {
    await f.stop();
    await third.close();
    await other.close();
    await app.close();
    for (const x of [ts, os, s]) await x.close();
  }
});
