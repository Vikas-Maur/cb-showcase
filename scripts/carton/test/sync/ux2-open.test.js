// Carton UX v2 for teammates (fix/ux2-open), between two computers: Cardboard 1.4.0's real library worker, patched, on
// Alice's and Bob's own libraries and app data, syncing through a real Carton host (server-node on 127.0.0.1). Alice's
// Exported and Sent (the page's export_completed and a link made, through `carton.mark`) reach Bob's `cb history
// --landmarks` and his History panel as hers, and are never edits; her Start and her Before stay hers; her `cb restore
// <version> --clip` on the shared cut reads at Bob's as "Brought back “Hello” from …", not as a plain restore.
//   CARDBOARD_PRISTINE=<Cardboard 1.4.0 unpacked> node --test --test-concurrency=1 scripts/carton/test/sync/ux2-open.test.js
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
  host = await S.startHost(path.join(S.TMP, "ux2-open-host"));
  alice = await S.computer("ux2-open-alice", b);
  bob = await S.computer("ux2-open-bob", b);
  S.seed(alice, b);
  await alice.startWorker();
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
  let calls = 0;
  const msgs = () => pc.events().filter((e) => e.change?.kind === "carton" && e.change.client === client).map((e) => e.change.message);
  const send = (message) => pc.call("carton.ui", { projectId: id, client, message });
  assert.equal((await send({ t: "hello" }))?.status, "ok", "the History panel opens");
  await S.until(() => msgs().some((x) => x.t === "init"), 20_000, pc.name + "'s panel init");
  return {
    /** The rows, oldest first, as the page has them now (init, then every `history` message). */
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
    /** Ask for rows' words, as the page does for the rows it shows (`want`). */
    want: (ids) => send({ t: "want", ids }),
    call: async (method, ...args) => {
      const n = ++calls;
      await send({ t: "call", id: n, method, args });
      const ret = await S.until(() => msgs().find((x) => x.t === "ret" && x.id === n), 30_000, "the panel's " + method);
      if (!ret.ok) throw new Error(`panel ${method}: ${ret.error}`);
      return ret.value;
    },
  };
}

test("share and join: Alice shares Demo, Bob joins from her invite", t, async () => {
  const r = await alice.call("carton.liveShare", { projectId: id, host: host.origin, adminToken: S.ADMIN, name: "Alice" });
  assert.equal(r.status, "shared", JSON.stringify(r));
  await S.until(async () => { const s = await alice.call("carton.liveStatus", { projectId: id }); return s.status === "up-to-date" && s.holder; }, 20_000, "alice up to date, holding the lease");
  const { link } = await alice.call("carton.liveInvite", { projectId: id, role: "editor" });
  assert.equal((await bob.call("carton.liveJoin", { link, name: "Bob" })).projectId, id);
  const want = S.textOf(await S.projectOf(alice, id)).fontSize;
  await S.until(async () => S.textOf(await S.projectOf(bob, id).catch(() => ({ timelineItems: [] })))?.fontSize === want, 30_000, "bob's project at alice's head");
  await S.until(async () => { const s = await bob.call("carton.liveStatus", { projectId: id }); return s.status === "up-to-date" && s.holder; }, 20_000, "bob up to date, holding the lease");
  done.add("join");
});

test("Alice's Exported and Sent reach Bob's cb and History panel as hers, and are no edits; her Start stays hers", t, async () => {
  need("join");
  const bobs = await openPanel(bob, "ux2-open-bob");
  // Alice's editor opens the project (a Start, hers), an export finishes, and she sends a version
  await openPanel(alice, "ux2-open-alice");
  await S.until(async () => (await alice.call("carton.liveStatus", { projectId: id })).status === "up-to-date", 20_000, "alice up to date");
  const head = cbJson(alice, ["history", "Demo", "--limit", "1"]).versions[0].version;
  const versions = cbJson(bob, ["history", "Demo", "--limit", "500"]).versions.length;
  assert.equal((await alice.call("carton.mark", { projectId: id, kind: "exported", label: "1080p for the client" })).status, "ok");
  assert.equal((await alice.call("carton.mark", { projectId: id, kind: "sent", label: "Shared with Leo" })).status, "ok");
  // (making Bob's invite link was a Sent of hers too: "Shared a link to edit", marked by the generic person and told
  // as Alice by its replica id)
  const labels = ["1080p for the client", "Shared with Leo", "Shared a link to edit"];
  const landmarks = await S.until(() => {
    const l = cbJson(bob, ["history", "Demo", "--landmarks"]).landmarks.filter((x) => x.kind === "exported" || x.kind === "sent");
    return labels.every((w) => l.some((x) => x.label === w)) && l;
  }, 20_000, "Alice's export and sends at Bob's");
  for (const l of landmarks) assert.deepEqual([l.by?.name, l.local, l.personal], ["Alice", false, false], JSON.stringify(l));
  for (const w of labels.slice(0, 2)) assert.equal(landmarks.find((x) => x.label === w).version, head, w + ": on the version she exported");
  const words = bob.cb(["history", "Demo", "--landmarks"]).out;
  assert.match(words, /1080p for the client · \d+:\d{2} · by Alice/, words);
  assert.match(words, /Shared with Leo · by Alice/, words);
  const all = cbJson(bob, ["history", "Demo", "--landmarks"]).landmarks;
  assert.ok(!all.some((x) => x.kind === "start" && x.by?.name === "Alice"), "her Start stays hers: " + JSON.stringify(all.filter((x) => x.kind === "start")));
  // no edit: Bob's History has no new version
  assert.equal(cbJson(bob, ["history", "Demo", "--limit", "500"]).versions.length, versions);
  // Bob's History panel: the landmark, by Alice, not his
  const marks = await bobs.call("landmarks");
  const ex = marks.find((m) => m.kind === "exported");
  assert.deepEqual([ex?.label, ex?.by?.name, !!ex?.by?.isYou, ex?.local, ex?.personal], ["1080p for the client", "Alice", false, false, false], JSON.stringify(ex));
  // at Alice's, hers no longer say "only you see this" once the host has them
  await S.until(() => cbJson(alice, ["history", "Demo", "--landmarks"]).landmarks.filter((x) => x.kind === "exported" || x.kind === "sent").every((x) => x.local === false), 20_000, "Alice's own, shared");
  done.add("landmarks");
});

test("Alice's bring-back of one clip on the shared cut reads as one in Bob's History; her Before stays hers", t, async () => {
  need("join");
  const bobs = await openPanel(bob, "ux2-open-bob-2");
  // Alice retypes the title, then brings back how it was
  await S.guiSave(alice, id, (it) => (it.type === "text" ? { ...it, textContent: "Summer launch" } : undefined));
  await S.until(async () => S.textOf(await S.projectOf(bob, id)).textContent === "Summer launch", 30_000, "the retyping at Bob's");
  const before = cbJson(alice, ["history", "Demo", "--limit", "2"]).versions[1];
  const r = cbJson(alice, ["restore", "Demo", before.version, "--clip", "Hello"]);
  assert.equal(r.status, "confirmed", JSON.stringify(r));
  await S.until(async () => S.textOf(await S.projectOf(bob, id)).textContent === "Hello", 30_000, "the bring-back at Bob's");
  const top = cbJson(bob, ["history", "Demo", "--limit", "1"]).versions[0];
  assert.equal(top.kind, "restore", JSON.stringify(top));
  const row = await S.until(async () => {
    const rows = bobs.rows(), v = rows[rows.length - 1];
    if (v?.id) await bobs.want([v.id]); // as the page asks for the words of the rows it shows
    return v && /^Brought back /.test(v.summary ?? "") && v;
  }, 20_000, "Bob's newest row's words");
  assert.match(row.summary, /^Brought back “Hello” from \d{1,2}:\d{2} [ap]m$/, row.summary);
  // her safety point is hers: at Alice's, a Before; at Bob's, the row alone
  assert.ok(cbJson(alice, ["history", "Demo", "--landmarks"]).landmarks.some((x) => x.kind === "before" && x.before === "bring-back"), "Alice's Before");
  assert.ok(!cbJson(bob, ["history", "Demo", "--landmarks"]).landmarks.some((x) => x.kind === "before"), "none at Bob's");
});
