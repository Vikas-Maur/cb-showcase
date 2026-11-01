// Share to a host with open creation (the free web demo's host, OPEN_CREATE): the Share form needs only the host's
// address and the person's name, no owner invite or admin token. Cardboard 1.4.0's real library worker, patched,
// against server-node on 127.0.0.1 with open creation on; a host without it still asks for the token. Cardboard's
// bundles are not in git: CARDBOARD_PRISTINE names them; without them the test skips.
//   CARDBOARD_PRISTINE=… node --test scripts/carton/test/sync/open-share.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const S = require("./support.js");

const t = { skip: S.noBuild, timeout: S.TEST_MS };
let b, open, closed, alice, id;

test.before(async () => {
  if (S.noBuild) return;
  b = await S.build();
  open = await S.startHost(path.join(S.TMP, "open-host"), 0, { CARTON_TEST_OPEN_CREATE: "1" });
  closed = await S.startHost(path.join(S.TMP, "closed-host"));
  alice = await S.computer("alice-open", b);
  S.seed(alice, b);
  await alice.startWorker();
  id = (await alice.call("projects.list"))[0].id;
}, { timeout: S.SETUP_MS });
test.after(async () => {
  alice?.kill();
  S.killHelpers();
  await open?.stop().catch(() => {});
  await closed?.stop().catch(() => {});
}, { timeout: S.STOP_MS });

test("an open host takes a share with no token: the person is the project's owner and can invite", t, async () => {
  // what the Share form asks first: this host needs no token, the other one does
  assert.equal((await alice.call("carton.liveHostInfo", { host: open.origin })).openCreate, true);
  assert.equal((await alice.call("carton.liveHostInfo", { host: closed.origin })).openCreate, false);
  // a host without open creation still refuses a share with no token, in words
  await assert.rejects(alice.call("carton.liveShare", { projectId: id, host: closed.origin, name: "Alice", withMedia: false }), /needs an owner invite or its admin token/);
  const r = await alice.call("carton.liveShare", { projectId: id, host: open.origin, name: "Alice", withMedia: false });
  assert.equal(r.status, "shared", JSON.stringify(r));
  const st = await S.until(async () => { const s = await alice.call("carton.liveStatus", { projectId: id }); return s.status === "up-to-date" && s; }, 20_000, "alice up to date");
  assert.equal(st.role, "owner");
  assert.equal(st.name, "Alice");
  const inv = await alice.call("carton.liveInvite", { projectId: id, role: "editor" });
  assert.match(inv.link, /#join=/);
  // the project id is claimed now: nobody else can make it again on that host and become its owner
  const again = await fetch(`${open.origin}/api/projects/${encodeURIComponent(id)}/create`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "mallory", installKey: "x".repeat(32) }) });
  assert.equal(again.status, 409);
});
