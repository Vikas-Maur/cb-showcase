// The invite service (hosts-plugins), and the AuthProvider suite run on the demo createHmacAuth.
import { test } from "node:test";
import assert from "node:assert/strict";
import { authProviderSuite } from "@carton/conformance";
import { createHmacAuth } from "../src/auth.ts";
import { createInviteService, AuthError, deviceId, newInstallKey, tokenFromRequest, offersCartonProtocol, b64url, fromB64url, canPush, canInvite } from "../src/invites.ts";

const SECRET = "0123456789abcdef0123456789abcdef-test-only";
let clock = Date.UTC(2026, 9, 31, 12, 0, 0);
const make = (o: { sessionTtlMs?: number; grantTtlMs?: number } = {}) => {
  const auth = createHmacAuth({ secret: SECRET, clock: () => clock });
  return { auth, svc: createInviteService({ auth, secret: SECRET, clock: () => clock, ...o }) };
};
const headers = (h: Record<string, string>) => new Headers(h);

authProviderSuite("hmac (createHmacAuth)", async () => createHmacAuth({ secret: SECRET, clock: () => clock }), { advanceClock: (ms) => { clock += ms; } });

test("invite -> join gives a session whose credential is account/deviceId", async () => {
  const { auth, svc } = make();
  const key = newInstallKey();
  const j = await svc.join(await svc.createInvite("proj-1", "editor"), "alice", key);
  assert.equal(j.context.credential, `alice/${await deviceId(key)}`);
  assert.equal(j.context.role, "editor");
  assert.equal(j.context.projectId, "proj-1");
  assert.ok(canPush(j.context) && !canInvite(j.context));
  assert.deepEqual(await auth.verify(j.session), j.context);
});

test("the same install key rejoining gets the same credential (rid bindings survive a re-invite)", async () => {
  const { svc } = make();
  const key = newInstallKey();
  const a = await svc.join(await svc.createInvite("p", "editor"), "bob", key);
  const b = await svc.join(await svc.createInvite("p", "editor"), "bob", key);
  assert.equal(a.context.credential, b.context.credential);
  const other = await svc.join(await svc.createInvite("p", "editor"), "bob", newInstallKey());
  assert.notEqual(other.context.credential, a.context.credential);
});

test("viewers and commenters get sessions that can't push", async () => {
  const { svc } = make();
  for (const role of ["viewer", "commenter"] as const) assert.equal(canPush((await svc.join(await svc.createInvite("p", role), "v", newInstallKey())).context), false);
});

test("invites, grants and sessions can't stand in for each other", async () => {
  const { auth, svc } = make();
  const invite = await svc.createInvite("p", "editor");
  assert.equal(await auth.verify(invite), null, "an invite is not a session");
  const j = await svc.join(invite, "alice", newInstallKey());
  assert.equal(await auth.verify(j.grant), null, "a grant is not a session");
  await assert.rejects(svc.join(j.session, "mallory", newInstallKey()), /not an invite/);
  await assert.rejects(svc.join(j.grant, "mallory", newInstallKey()), /not an invite/);
  await assert.rejects(svc.refresh(invite, newInstallKey()), /not a grant/);
});

test("tampered invites are refused", async () => {
  const { svc } = make();
  const invite = await svc.createInvite("p", "viewer");
  const [pfx, body, mac] = [invite.slice(0, 4), invite.slice(4, invite.lastIndexOf(".")), invite.slice(invite.lastIndexOf(".") + 1)];
  const c = JSON.parse(new TextDecoder().decode(fromB64url(body)));
  c.role = "owner";
  await assert.rejects(svc.join(`${pfx}${b64url(new TextEncoder().encode(JSON.stringify(c)))}.${mac}`, "eve", newInstallKey()), /bad signature/);
  const other = createInviteService({ auth: createHmacAuth({ secret: SECRET }), secret: "another-secret-another-secret-12345" });
  await assert.rejects(other.join(invite, "eve", newInstallKey()), /bad signature/);
});

test("refresh: a week offline, the grant and install key give a fresh session with the same credential", async () => {
  const { auth, svc } = make({ sessionTtlMs: 60_000, grantTtlMs: 30 * 24 * 3600_000 });
  const key = newInstallKey();
  const j = await svc.join(await svc.createInvite("p", "editor"), "alice", key);
  clock += 7 * 24 * 3600_000;
  assert.equal(await auth.verify(j.session), null, "the session expired");
  await assert.rejects(svc.refresh(j.grant, newInstallKey()), /does not match/);
  const r = await svc.refresh(j.grant, key);
  assert.equal(r.context.credential, j.context.credential);
  assert.ok(await auth.verify(r.session));
  clock += 60 * 24 * 3600_000;
  await assert.rejects(svc.refresh(r.grant, key), /grant expired/);
  clock -= 67 * 24 * 3600_000;
});

test("expired invites, bad ids, short install keys and weak secrets are refused", async () => {
  const { svc } = make();
  const inv = await svc.createInvite("p", "editor", 1000);
  clock += 5000;
  await assert.rejects(svc.join(inv, "alice", newInstallKey()), /invite expired/);
  clock -= 5000;
  await assert.rejects(svc.createInvite("../etc", "editor"), (e: AuthError) => e.status === 400);
  await assert.rejects(svc.join(await svc.createInvite("p", "editor"), "a/b", newInstallKey()), /account/);
  await assert.rejects(svc.join(await svc.createInvite("p", "editor"), "alice", "short"), /install key/);
  for (const bad of ["", "ci1.", "ci1..", "ci1.%%.AA", "ci1." + "A".repeat(3000) + ".A"]) await assert.rejects(svc.join(bad, "a", newInstallKey()), AuthError);
  assert.throws(() => createInviteService({ auth: createHmacAuth({ secret: SECRET }), secret: "short" }), /32 bytes/);
  assert.throws(() => createInviteService({ auth: { kind: "x", verify: async () => null }, secret: SECRET }), /issue/);
});

test("tokens ride in Authorization or the WebSocket subprotocol list, and are valid subprotocol tokens", async () => {
  assert.equal(tokenFromRequest(headers({ authorization: "Bearer abc.def" })), "abc.def");
  const h = headers({ "sec-websocket-protocol": "carton.v1, carton.auth.abc.def" });
  assert.equal(tokenFromRequest(h), "abc.def");
  assert.equal(offersCartonProtocol(h), true);
  assert.equal(tokenFromRequest(headers({})), null);
  assert.equal(offersCartonProtocol(headers({ "sec-websocket-protocol": "x" })), false);
  const { svc } = make();
  const j = await svc.join(await svc.createInvite("p", "editor"), "alice", newInstallKey());
  assert.match("carton.auth." + j.session, /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/);
});
