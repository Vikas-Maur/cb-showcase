// The recording switch (fix/take5-names; CARTON_AGENT_NAME on Cardboard's process, README "Carton: settings for a
// recording"), between two computers: Cardboard 1.4.0's real library worker, patched, on Alice's and Bob's own libraries
// and app data, syncing through a real Carton host on 127.0.0.1. Alice's app runs with CARTON_AGENT_NAME="Claude 1";
// Bob's without it. With it, Alice's invite link adds no Sent landmark, her worker answers the page's `recording` ask,
// and her own Claude Code is “Claude 1” in her History while Bob's History still shows it as her Claude Code. Bob joins
// as “Bob 2” under the account Bob (liveJoin's `account`), and Alice's History names him so, keyed as Bob. Without the
// switch everything is as before: ux2-open.test.js (the link's Sent) and the rest of the sync tests.
//   CARDBOARD_PRISTINE=<Cardboard 1.4.0 unpacked> node --test --test-concurrency=1 scripts/carton/test/sync/take5-recording.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const S = require("./support.js");

const t = { skip: S.skip || S.noBuild, timeout: S.TEST_MS };
let b, host, alice, bob, id;
const done = new Set();
const need = (...steps) => { const miss = steps.filter((x) => !done.has(x)); if (miss.length) throw new Error(`not run: ${miss.join(" and ")} failed earlier`); };

test.before(async () => {
  if (t.skip) return;
  b = await S.build();
  host = await S.startHost(path.join(S.TMP, "take5-host"));
  alice = await S.computer("take5-alice", b);
  bob = await S.computer("take5-bob", b);
  S.seed(alice, b);
  await alice.startWorker({ CARTON_AGENT_NAME: "Claude 1" });
  await bob.startWorker();
  id = (await alice.call("projects.list"))[0].id;
}, { timeout: S.SETUP_MS });
test.after(async () => {
  for (const pc of [alice, bob]) if (pc?.worker()) fs.writeFileSync(path.join(S.TMP, pc.name + "-worker.log"), pc.worker().stderr());
  for (const pc of [alice, bob]) pc?.kill();
  S.killHelpers();
  await host?.stop().catch(() => {});
}, { timeout: S.STOP_MS });

const cbJson = (pc, args) => {
  const r = pc.cb(args);
  assert.equal(r.code, 0, args.join(" ") + ": " + r.out + r.err);
  return r.json();
};
/** A History panel on a computer (the editor's page, through the worker's carton.ui), its rows kept as the page keeps them. */
async function openPanel(pc, client) {
  const msgs = () => pc.events().filter((e) => e.change?.kind === "carton" && e.change.client === client).map((e) => e.change.message);
  assert.equal((await pc.call("carton.ui", { projectId: id, client, message: { t: "hello" } }))?.status, "ok", "the History panel opens");
  await S.until(() => msgs().some((x) => x.t === "init"), 20_000, pc.name + "'s panel init");
  return {
    rows: () => {
      let rows = [];
      for (const m of msgs()) {
        if (m.t === "init") rows = m.history.slice();
        else if (m.t === "history") {
          rows.length = m.length;
          for (const [i, v] of m.rows) rows[i] = v;
        }
      }
      return rows;
    },
  };
}
const newest = (p) => { const rows = p.rows(); return rows[rows.length - 1]; };

test("the worker answers the page's `recording` ask: on at Alice's (CARTON_AGENT_NAME), off at Bob's", t, async () => {
  assert.deepEqual(await alice.call("carton.recording"), { on: true });
  assert.deepEqual(await bob.call("carton.recording"), { on: false });
});

test("switch on: Alice's invite link adds no Sent landmark; Bob joins as “Bob 2” under the account Bob", t, async () => {
  const r = await alice.call("carton.liveShare", { projectId: id, host: host.origin, adminToken: S.ADMIN, name: "Alice" });
  assert.equal(r.status, "shared", JSON.stringify(r));
  await S.until(async () => { const s = await alice.call("carton.liveStatus", { projectId: id }); return s.status === "up-to-date" && s.holder; }, 20_000, "alice up to date, holding the lease");
  const { link } = await alice.call("carton.liveInvite", { projectId: id, role: "editor" });
  // a mark made after the link: once it is there, the link's would be too (both go to the same Carton, in order)
  assert.equal((await alice.call("carton.mark", { projectId: id, kind: "exported", label: "1080p for the client" })).status, "ok");
  const marks = await S.until(() => {
    const l = cbJson(alice, ["history", "Demo", "--landmarks"]).landmarks;
    return l.some((x) => x.kind === "exported") && l;
  }, 20_000, "the export's landmark");
  assert.deepEqual(marks.filter((x) => x.kind === "sent"), [], "no Sent for the link: " + JSON.stringify(marks));
  // an account that isn't a name is refused before anything is made
  await assert.rejects(bob.call("carton.liveJoin", { link, name: "Bob 2", account: 42 }), /must be a name/);
  assert.equal((await bob.call("carton.liveJoin", { link, name: "Bob 2", account: "Bob" })).projectId, id);
  const st = await S.until(async () => { const s = await bob.call("carton.liveStatus", { projectId: id }); return s.status === "up-to-date" && s.holder && s; }, 30_000, "bob up to date, holding the lease");
  assert.deepEqual([st.account, st.name], ["Bob", "Bob 2"], JSON.stringify(st));
  done.add("join");
});

test("Alice's History names Bob “Bob 2”, keyed (and so coloured) as his account Bob", t, async () => {
  need("join");
  const alices = await openPanel(alice, "take5-alice-1");
  await S.guiSave(bob, id, (it) => (it.type === "text" ? { ...it, textContent: "Hello?" } : undefined));
  const row = await S.until(() => { const v = newest(alices); return v?.author?.name === "Bob 2" && v; }, 30_000, "Bob's row at Alice's");
  assert.deepEqual([row.author.key, row.author.kind, !!row.author.isYou], ["human/Bob", "human", false], JSON.stringify(row.author));
});

test("switch on: Alice's own Claude Code is “Claude 1” in her History; at Bob's (switch off) it is her Claude Code", t, async () => {
  need("join");
  const alices = await openPanel(alice, "take5-alice-2");
  const bobs = await openPanel(bob, "take5-bob-2");
  // (from the print on disk, whatever version it is: Carton merges an apply made from an older print)
  const tsx = path.join(alice.root, "Demo.cardboard", "timeline.tsx");
  const edit = path.join(alice.home, "cc.tsx");
  fs.writeFileSync(edit, fs.readFileSync(tsx, "utf8").replace(/fontSize=\{\d+\}/, "fontSize={160}"));
  const r = alice.cb(["source", "apply", "Demo", edit], { CARDBOARD_ACTOR: "claude-code/ab12cd34" });
  assert.equal(r.code, 0, r.out + r.err);
  const cc = (p) => { const v = newest(p); return v?.author?.key === "agent/claude-code/ab12cd34" && v; };
  const mine = await S.until(() => cc(alices), 20_000, "her Claude Code's row at Alice's");
  assert.deepEqual([mine.author.name, !!mine.author.isYou], ["Claude 1", true], JSON.stringify(mine.author));
  const hers = await S.until(() => cc(bobs), 30_000, "her Claude Code's row at Bob's");
  assert.deepEqual([hers.author.name, !!hers.author.isYou], ["Claude Code", false], JSON.stringify(hers.author));
});
