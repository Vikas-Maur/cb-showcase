// Presence after the host drops and comes back (P2, seen on merge/prod-2 in the real app): Cardboard 1.4.0's real
// library worker on two computers, sharing a project through a real Carton host (server-node on 127.0.0.1). Both
// editors are open and idle, so neither sends presence again by itself (the page says "here" once on open). The host
// stops and starts again, several times: each time both Share panels must list the other within a few seconds of both
// saying "Up to date". Before the fix, the first computer back re-announced to a room the other hadn't rejoined yet,
// and the host kept no presence to tell the latecomer: one side listed nobody, for good.
//   CARDBOARD_PRISTINE=… node --test --test-concurrency=1 scripts/carton/test/sync/presence-reconnect.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const S = require("./support.js");

const t = { skip: S.noBuild, timeout: S.TEST_MS };
let b, host, alice, bob, id;
const done = new Set();
const need = (...steps) => { const miss = steps.filter((x) => !done.has(x)); if (miss.length) throw new Error(`not run: ${miss.join(" and ")} failed earlier`); };
const ROUNDS = 3;

test.before(async () => {
  if (S.noBuild) return;
  b = await S.build();
  host = await S.startHost(path.join(S.TMP, "host"));
  alice = await S.computer("alice", b);
  bob = await S.computer("bob", b);
  S.seed(alice, b);
  await alice.startWorker();
  await bob.startWorker();
  id = (await alice.call("projects.list"))[0].id;
}, { timeout: S.SETUP_MS });
test.after(async () => {
  for (const pc of [alice, bob]) pc?.kill();
  S.killHelpers();
  await host?.stop().catch(() => {});
}, { timeout: S.STOP_MS });

const status = (pc) => pc.call("carton.liveStatus", { projectId: id });
const lists = (st, who) => (st.peers ?? []).some((p) => p.actor?.id === who);
// Both up to date and each listing the other; the state of each when it isn't, for the failure's message.
async function bothList(ms, what) {
  let last = null;
  try {
    return await S.until(async () => {
      const [a, o] = await Promise.all([status(alice), status(bob)]);
      last = { alice: { status: a.status, peers: (a.peers ?? []).map((p) => p.actor?.id) }, bob: { status: o.status, peers: (o.peers ?? []).map((p) => p.actor?.id) } };
      return a.status === "up-to-date" && o.status === "up-to-date" && lists(a, "Bob") && lists(o, "Alice") && last;
    }, ms, what);
  } catch (e) {
    throw new Error(`${e.message}: ${JSON.stringify(last)}`);
  }
}

test("share, join, and both editors open: each Share panel lists the other", t, async () => {
  const r = await alice.call("carton.liveShare", { projectId: id, host: host.origin, adminToken: S.ADMIN, name: "Alice" });
  assert.equal(r.status, "shared", JSON.stringify(r));
  await S.until(async () => (await status(alice)).status === "up-to-date", 20_000, "alice up to date");
  // Each editor opens the project: the page says "here" once (idle), as __cbCartonPresence does, and nothing more.
  // Alice's is open before Bob joins: idle, she never speaks again, and Bob must still list her.
  await alice.call("carton.livePresence", { projectId: id, state: { activity: null, idle: true } });
  const { link } = await alice.call("carton.liveInvite", { projectId: id, role: "editor" });
  const j = await bob.call("carton.liveJoin", { link, name: "Bob" });
  assert.equal(j.projectId, id);
  await S.until(async () => (await status(bob)).status === "up-to-date", 30_000, "bob up to date");
  await bob.call("carton.livePresence", { projectId: id, state: { activity: null, idle: true } });
  await bothList(10_000, "both listing each other after the join");
  done.add("both here");
});

for (let round = 1; round <= ROUNDS; round++) {
  test(`the host drops and comes back (round ${round}): both list each other again within a few seconds of both being up to date`, t, async () => {
    need("both here");
    const port = host.port;
    await host.stop();
    await S.until(async () => (await status(alice)).status === "offline" && (await status(bob)).status === "offline", 20_000, "both offline");
    // Offline, each side's teammate is gone from its panel (its connection is what showed them).
    await S.sleep(round * 700); // a different backoff state each round, so the two come back in either order
    host = await S.startHost(path.join(S.TMP, "host"), port);
    await S.until(async () => (await status(alice)).status === "up-to-date" && (await status(bob)).status === "up-to-date", 40_000, "both up to date");
    const seen = await bothList(5_000, `both listing each other after the host came back (round ${round})`);
    // and it stays so: no stale leave takes either away afterwards
    await S.sleep(2000);
    const after = await bothList(1, "still listing each other 2 s later");
    assert.deepEqual(after, seen);
  });
}
