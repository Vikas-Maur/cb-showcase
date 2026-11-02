import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmacAuth, HmacAuth, AuthError, deviceId, newInstallKey, newSecret, tokenFromRequest, offersCartonProtocol, b64url, fromB64url, canPush } from "../src/hmac-auth.ts";
import { authProviderSuite } from "@carton/conformance";

const SECRET = "0123456789abcdef0123456789abcdef-test-only";
let clock = Date.UTC(2026, 9, 31, 12, 0, 0);
const auth = (o: Partial<ConstructorParameters<typeof HmacAuth>[0]> = {}) => createHmacAuth({ secret: SECRET, clock: () => clock, ...o });
const headers = (h: Record<string, string>) => new Headers(h);
const claimsOf = (token: string) => JSON.parse(new TextDecoder().decode(fromB64url(token.split(".")[1]!)));

authProviderSuite("hmac-demo", async () => auth(), { advanceClock: (ms) => { clock += ms; } });

test("invite -> join -> verify gives the device credential and the role", async () => {
  const a = auth();
  const invite = await a.createInvite("proj-1", "editor");
  const key = newInstallKey();
  const { token, context } = await a.join(invite, "alice", key);
  assert.equal(context.credential, `alice/${await deviceId(key)}`);
  assert.equal(context.role, "editor");
  assert.equal(context.projectId, "proj-1");
  assert.equal(canPush(context), true);
  assert.deepEqual(await a.verify(token), context);
});

test("the same install key rejoining gets the same credential (rid bindings survive a re-invite)", async () => {
  const a = auth();
  const key = newInstallKey();
  const s1 = await a.join(await a.createInvite("p", "editor"), "bob", key);
  const s2 = await a.join(await a.createInvite("p", "editor"), "bob", key);
  assert.equal(s1.context.credential, s2.context.credential);
  const other = await a.join(await a.createInvite("p", "editor"), "bob", newInstallKey());
  assert.notEqual(other.context.credential, s1.context.credential);
});

test("viewers and commenters verify but can't push", async () => {
  const a = auth();
  for (const role of ["viewer", "commenter"] as const) {
    const { token } = await a.join(await a.createInvite("p", role), "v", newInstallKey());
    const ctx = await a.verify(token);
    assert.equal(ctx?.role, role);
    assert.equal(canPush(ctx!), false);
  }
});

test("check() names the project mismatch (403); verify() leaves the project check to the host", async () => {
  const a = auth();
  const { token } = await a.join(await a.createInvite("p1", "owner"), "alice", newInstallKey());
  await assert.rejects(a.check(token, "p2"), (e: AuthError) => e.status === 403);
  assert.equal((await a.verify(token))?.projectId, "p1");
});

test("an invite is not a session, and a session is not an invite", async () => {
  const a = auth();
  const invite = await a.createInvite("p", "editor");
  assert.equal(await a.verify(invite), null);
  const { token } = await a.join(invite, "alice", newInstallKey());
  await assert.rejects(a.join(token, "mallory", newInstallKey()), /not an invite/);
});

test("tampering with any claim breaks the signature", async () => {
  const a = auth();
  const { token } = await a.join(await a.createInvite("p", "viewer"), "eve", newInstallKey());
  const [pfx, , mac] = token.split(".");
  const claims = claimsOf(token);
  claims.role = "owner";
  const forged = `${pfx}.${b64url(new TextEncoder().encode(JSON.stringify(claims)))}.${mac}`;
  await assert.rejects(a.check(forged), /bad signature/);
  assert.equal(await a.verify(forged), null);
  const b = createHmacAuth({ secret: "another-secret-another-secret-123", clock: () => clock });
  assert.equal(await b.verify(token), null);
});

test("expiry, clock skew and garbage tokens", async () => {
  const a = auth({ sessionTtlMs: 60_000 });
  const { token } = await a.join(await a.createInvite("p", "editor"), "alice", newInstallKey());
  clock += 200_000; // past the 60 s TTL plus the 60 s skew allowance
  await assert.rejects(a.check(token), /expired/);
  assert.equal(await a.verify(token), null);
  clock -= 200_000;
  for (const bad of ["", "ct1.", "ct1..", "xx1.e30.AA", "ct1.%%%.AA", "ct1." + "A".repeat(3000) + ".A", null as unknown as string])
    assert.equal(await a.verify(bad), null, String(bad).slice(0, 12));
  const future = createHmacAuth({ secret: SECRET, clock: () => clock + 3600_000 });
  const t2 = (await future.join(await future.createInvite("p", "editor"), "alice", newInstallKey())).token;
  await assert.rejects(a.check(t2), /future/);
});

test("refresh: expired sessions renew only with the device's install key, within the grace period", async () => {
  const a = auth({ sessionTtlMs: 60_000, refreshGraceMs: 3600_000 });
  const key = newInstallKey();
  const s = await a.join(await a.createInvite("p", "editor"), "alice", key);
  clock += 600_000; // 10 minutes later: expired, inside the grace
  await assert.rejects(a.refresh(s.token, newInstallKey()), /does not match/);
  const r = await a.refresh(s.token, key);
  assert.equal(r.context.credential, s.context.credential);
  assert.ok(r.context.expires > clock);
  clock += 7200_000; // past the grace
  await assert.rejects(a.refresh(s.token, key), /expired/);
  clock -= 7800_000;
});

test("issue(): a trusted server-side mint, scoped to branches, and not refreshable", async () => {
  const a = auth();
  const token = await a.issue({ account: "director", credential: "director/cloud-1", role: "editor", projectId: "p", branches: ["b1"], ttlMs: 3600_000 });
  const ctx = await a.verify(token);
  assert.deepEqual(ctx, { account: "director", credential: "director/cloud-1", role: "editor", projectId: "p", branches: ["b1"], expires: clock + 3600_000 - (clock % 1000) });
  await assert.rejects(a.refresh(token, newInstallKey()), /does not match/);
});

test("key rotation: old kids still verify, new tokens use the current kid", async () => {
  const old = auth();
  const { token } = await old.join(await old.createInvite("p", "editor"), "alice", newInstallKey());
  const rotated = createHmacAuth({ keys: { k1: SECRET, k2: newSecret() + newSecret() }, currentKid: "k2", clock: () => clock });
  assert.equal((await rotated.verify(token))?.account, "alice");
  assert.equal(claimsOf(await rotated.createInvite("p", "viewer")).kid, "k2");
  const dropped = createHmacAuth({ keys: { k2: "x".repeat(40) }, currentKid: "k2", clock: () => clock });
  await assert.rejects(dropped.check(token), /unknown signing key/);
});

test("constructor refuses short secrets and unknown current kids", () => {
  assert.throws(() => createHmacAuth({ secret: "short" }), /shorter/);
  assert.throws(() => createHmacAuth({ keys: { k1: SECRET }, currentKid: "k9" }), /no key/);
  assert.throws(() => createHmacAuth({}), /no key/);
});

test("ids are restricted to a safe charset", async () => {
  const a = auth();
  await assert.rejects(a.createInvite("../etc", "editor"), /project/);
  await assert.rejects(a.join(await a.createInvite("p", "editor"), "a/b", newInstallKey()), /account/);
  await assert.rejects(a.join(await a.createInvite("p", "editor"), "alice", "short"), /install key/);
});

test("tokens ride in Authorization or the WebSocket subprotocol list", async () => {
  assert.equal(tokenFromRequest(headers({ authorization: "Bearer ct1.a.b" })), "ct1.a.b");
  const h = headers({ "sec-websocket-protocol": "carton.v1, carton.auth.ct1.a.b" });
  assert.equal(tokenFromRequest(h), "ct1.a.b");
  assert.equal(offersCartonProtocol(h), true);
  assert.equal(tokenFromRequest(headers({})), null);
  assert.equal(offersCartonProtocol(headers({ "sec-websocket-protocol": "x" })), false);
  // a real token is a valid RFC 7230 token, so a browser accepts it as a subprotocol
  const a = auth();
  const { token } = await a.join(await a.createInvite("p", "editor"), "alice", newInstallKey());
  assert.match("carton.auth." + token, /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/);
});

test("only the MAC's canonical encoding verifies: a token differing in the last character's unused bits is refused", async () => {
  const a = auth();
  const { token } = await a.join(await a.createInvite("p", "viewer"), "eve", newInstallKey());
  const mac = token.slice(token.lastIndexOf(".") + 1);
  assert.equal(mac.length, 43, "32 bytes: the last character carries 4 bits and 2 unused ones");
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const forged = token.slice(0, -1) + ALPHABET[ALPHABET.indexOf(mac.at(-1)!) ^ 1];
  assert.notEqual(forged, token);
  assert.deepEqual(fromB64url(forged.slice(forged.lastIndexOf(".") + 1)), fromB64url(mac), "it decodes to the same MAC");
  assert.equal(await a.verify(forged), null);
  await assert.rejects(a.check(forged), /bad signature/);
});
