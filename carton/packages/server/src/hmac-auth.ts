// Demo AuthProvider (PLAN §3.1, §6.3, §14): stateless HMAC-SHA256 tokens, WebCrypto only, so the same code runs
// in a Worker, in Node and in a browser-side test. Cardboard's accounts replace it in production. Written by
// hosts-plugins (the hosts are its callers); exported from `@carton/server` as the contract places it.
//
// Two token kinds, both `ct1.<base64url(JSON claims)>.<base64url(HMAC)>`:
// - invite:  {typ:"invite", prj, role, exp}. The share link. It names no account or device.
// - session: {typ:"session", prj, role, acc, dev, exp}. Issued by `join` to one device.
//
// The device credential (§6.3) is `acc/dev`. `dev` is a hash of the per-install key, which the client presents
// only to `join` and `refresh`, never on a connection. So a leaked session token expires, a leaked invite can't
// claim someone else's device (the attacker would need that install's key), and a device that rejoins with the same
// install key gets the same credential back: the sequencer's replica-id bindings, and so its pending changes,
// survive a re-invite. Revocation is by key rotation (`kid`), as the tokens are stateless.

import type { AuthContext, AuthProvider, Role } from "@carton/core/plugins";

const ROLES: readonly Role[] = ["owner", "editor", "commenter", "viewer"];

export interface InviteClaims {
  v: 1;
  typ: "invite";
  kid: string;
  prj: string;
  role: Role;
  // the cuts the sessions it makes are scoped to (a Published cut's watch link: its viewers read that cut only)
  brs?: string[];
  iat: number; // seconds
  exp: number;
}

export interface SessionClaims {
  v: 1;
  typ: "session";
  kid: string;
  prj: string;
  role: Role;
  acc: string;
  // the device credential replica ids are bound to (§6.3): `acc/<device id>` for joined devices
  crd: string;
  // set for joined devices: the hash of the install key that `refresh` checks
  dev?: string;
  brs?: string[];
  iat: number;
  exp: number;
}

export interface HmacAuthOptions {
  // The signing secret, at least 32 bytes. It comes from the environment (wrangler secret, .dev.vars, an env var),
  // never from code. `keys` + `currentKid` instead allow rotation: every kid in `keys` verifies, new tokens use the
  // current one.
  secret?: string | Uint8Array;
  keys?: Record<string, string | Uint8Array>;
  currentKid?: string;
  sessionTtlMs?: number;
  inviteTtlMs?: number;
  // how long after its expiry a session can still be refreshed by the device that holds its install key
  refreshGraceMs?: number;
  clockSkewMs?: number;
  clock?: () => number; // ms
}

export class AuthError extends Error {
  readonly status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

const PREFIX = "ct1.";
const MAX_TOKEN = 2048;
const MIN_SECRET_BYTES = 32;
const ID_RE = /^[A-Za-z0-9._~-]{1,128}$/;
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new AuthError("bad token encoding");
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// The device id for an install key: what a session carries instead of the key itself.
export async function deviceId(installKey: string): Promise<string> {
  if (typeof installKey !== "string" || installKey.length < 16 || installKey.length > 512)
    throw new AuthError("install key must be 16-512 characters", 400);
  const h = await crypto.subtle.digest("SHA-256", enc.encode("carton-device.v1\0" + installKey));
  return b64url(new Uint8Array(h, 0, 18)); // 144 bits: unguessable, and short enough to read in logs
}

// A fresh random install key, for clients (stored in the OS keychain or app data, §14).
export function newInstallKey(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

// A fresh random signing secret, for `carton-auth`-style setup scripts.
export function newSecret(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

export class HmacAuth implements AuthProvider {
  readonly kind = "hmac-demo";
  readonly #keys = new Map<string, ReturnType<typeof crypto.subtle.importKey>>();
  readonly #currentKid: string;
  readonly #sessionTtl: number;
  readonly #inviteTtl: number;
  readonly #grace: number;
  readonly #skew: number;
  readonly #now: () => number;

  constructor(opts: HmacAuthOptions) {
    const keys = opts.keys ?? (opts.secret !== undefined ? { k1: opts.secret } : {});
    const currentKid = opts.currentKid ?? (opts.keys ? "" : "k1");
    for (const [kid, secret] of Object.entries(keys)) {
      if (!ID_RE.test(kid)) throw new Error(`bad key id ${JSON.stringify(kid)}`);
      const raw = typeof secret === "string" ? enc.encode(secret) : secret;
      if (raw.length < MIN_SECRET_BYTES) throw new Error(`secret for key ${kid} is shorter than ${MIN_SECRET_BYTES} bytes`);
      this.#keys.set(kid, crypto.subtle.importKey("raw", raw as Uint8Array<ArrayBuffer>, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]));
    }
    if (!this.#keys.has(currentKid)) throw new Error(`currentKid ${JSON.stringify(currentKid)} has no key`);
    this.#currentKid = currentKid;
    const sec = (ms: number | undefined, d: number) => (ms === undefined ? d : Math.floor(ms / 1000));
    this.#sessionTtl = sec(opts.sessionTtlMs, 24 * 3600);
    this.#inviteTtl = sec(opts.inviteTtlMs, 7 * 24 * 3600);
    this.#grace = sec(opts.refreshGraceMs, 30 * 24 * 3600);
    this.#skew = sec(opts.clockSkewMs, 60);
    this.#now = opts.clock ?? Date.now;
  }

  #sec(): number {
    return Math.floor(this.#now() / 1000);
  }

  async #sign(claims: InviteClaims | SessionClaims): Promise<string> {
    const body = PREFIX + b64url(enc.encode(JSON.stringify(claims)));
    const key = await this.#keys.get(claims.kid)!;
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
    return body + "." + b64url(mac);
  }

  // Checks the signature (constant time, through subtle.verify) before it trusts a single claim.
  async #open(token: string, allowExpiredSec = 0): Promise<InviteClaims | SessionClaims> {
    if (typeof token !== "string" || token.length > MAX_TOKEN || !token.startsWith(PREFIX)) throw new AuthError("bad token");
    const dot = token.lastIndexOf(".");
    if (dot <= PREFIX.length) throw new AuthError("bad token");
    const body = token.slice(0, dot);
    let claims: InviteClaims | SessionClaims;
    try {
      claims = JSON.parse(dec.decode(fromB64url(body.slice(PREFIX.length))));
    } catch {
      throw new AuthError("bad token");
    }
    const keyP = typeof claims?.kid === "string" ? this.#keys.get(claims.kid) : undefined;
    if (!keyP) throw new AuthError("unknown signing key");
    const ok = await crypto.subtle.verify("HMAC", await keyP, fromB64url(token.slice(dot + 1)) as Uint8Array<ArrayBuffer>, enc.encode(body));
    if (!ok) throw new AuthError("bad signature");
    const now = this.#sec();
    if (claims.v !== 1 || !Number.isInteger(claims.exp) || !Number.isInteger(claims.iat)) throw new AuthError("bad token");
    if (claims.iat > now + this.#skew) throw new AuthError("token from the future");
    if (claims.exp + this.#skew + allowExpiredSec < now) throw new AuthError("token expired");
    if (!ROLES.includes(claims.role) || typeof claims.prj !== "string" || !ID_RE.test(claims.prj)) throw new AuthError("bad token");
    return claims;
  }

  // An invite link's token. Only an owner's session may ask a host for one (see `canInvite`). `branches` scopes the
  // sessions it makes to those cuts: writers may push only there, and viewers and commenters may read only there (a
  // Published cut's share link must not show the edit behind it).
  async createInvite(project: string, role: Role, ttlMs?: number, branches?: readonly string[]): Promise<string> {
    if (!ID_RE.test(project)) throw new AuthError("bad project id", 400);
    if (!ROLES.includes(role)) throw new AuthError("bad role", 400);
    if (branches !== undefined && (!Array.isArray(branches) || !branches.length || branches.length > 64 || branches.some((b) => typeof b !== "string" || !ID_RE.test(b)))) throw new AuthError("bad branches", 400);
    const iat = this.#sec();
    const ttl = ttlMs === undefined ? this.#inviteTtl : Math.floor(ttlMs / 1000);
    const claims: InviteClaims = { v: 1, typ: "invite", kid: this.#currentKid, prj: project, role, iat, exp: iat + ttl };
    if (branches) claims.brs = [...branches];
    return this.#sign(claims);
  }

  // AuthProvider.issue: a session for claims the caller already trusts (a server-side mint, tests, Cardboard's API
  // bridging its own accounts). It binds no install key, so `refresh` refuses it.
  async issue(claims: Omit<AuthContext, "expires"> & { ttlMs: number }): Promise<string> {
    if (!ID_RE.test(claims.projectId)) throw new AuthError("bad project id", 400);
    if (!ID_RE.test(claims.account)) throw new AuthError("bad account id", 400);
    if (!ROLES.includes(claims.role)) throw new AuthError("bad role", 400);
    if (typeof claims.credential !== "string" || !claims.credential || claims.credential.length > 300) throw new AuthError("bad credential", 400);
    const iat = this.#sec();
    const c: SessionClaims = { v: 1, typ: "session", kid: this.#currentKid, prj: claims.projectId, role: claims.role, acc: claims.account, crd: claims.credential, iat, exp: iat + Math.floor(claims.ttlMs / 1000) };
    if (claims.branches) c.brs = [...claims.branches];
    return this.#sign(c);
  }

  // Exchanges an invite for a session bound to this device. `account` is self-declared in the demo (L1-style);
  // the credential is still unforgeable because `dev` needs the install key.
  async join(invite: string, account: string, installKey: string): Promise<{ token: string; context: AuthContext }> {
    const c = await this.#open(invite);
    if (c.typ !== "invite") throw new AuthError("not an invite");
    if (typeof account !== "string" || !ID_RE.test(account)) throw new AuthError("bad account id", 400);
    if (c.brs !== undefined && (!Array.isArray(c.brs) || c.brs.some((b) => typeof b !== "string"))) throw new AuthError("bad token");
    return this.#issue(c.prj, c.role, account, await deviceId(installKey), c.brs);
  }

  // A new session for the same device and role. Works up to `refreshGraceSec` after expiry, for a device that
  // was offline, but only with the install key, so a stolen expired token is worthless.
  async refresh(session: string, installKey: string): Promise<{ token: string; context: AuthContext }> {
    const c = await this.#open(session, this.#grace);
    if (c.typ !== "session") throw new AuthError("not a session");
    if (!c.dev || (await deviceId(installKey)) !== c.dev) throw new AuthError("install key does not match this session's device");
    return this.#issue(c.prj, c.role, c.acc, c.dev, c.brs);
  }

  async #issue(project: string, role: Role, account: string, dev: string, branches?: string[]): Promise<{ token: string; context: AuthContext }> {
    const iat = this.#sec();
    const claims: SessionClaims = { v: 1, typ: "session", kid: this.#currentKid, prj: project, role, acc: account, crd: `${account}/${dev}`, dev, iat, exp: iat + this.#sessionTtl };
    if (branches) claims.brs = branches;
    return { token: await this.#sign(claims), context: contextOf(claims) };
  }

  // AuthProvider.verify: null for anything this provider didn't issue, a tampered or expired token, or an invite.
  // The host then checks `projectId` against the project the request is for.
  async verify(token: string): Promise<AuthContext | null> {
    try {
      return await this.check(token);
    } catch {
      return null;
    }
  }

  // `verify` with the reason, for HTTP answers (401 or 403) and logs.
  async check(token: string, project?: string): Promise<AuthContext> {
    const c = await this.#open(token);
    if (c.typ !== "session") throw new AuthError("not a session token");
    if (typeof c.acc !== "string" || !ID_RE.test(c.acc) || typeof c.crd !== "string" || !c.crd) throw new AuthError("bad token");
    if (c.brs !== undefined && (!Array.isArray(c.brs) || c.brs.some((b) => typeof b !== "string"))) throw new AuthError("bad token");
    if (project !== undefined && c.prj !== project) throw new AuthError("token is for another project", 403);
    return contextOf(c);
  }
}

function contextOf(c: SessionClaims): AuthContext {
  const ctx: AuthContext = { account: c.acc, credential: c.crd, role: c.role, projectId: c.prj, expires: c.exp * 1000 };
  if (c.brs) ctx.branches = [...c.brs];
  return ctx;
}

export function createHmacAuth(opts: HmacAuthOptions): HmacAuth {
  return new HmacAuth(opts);
}

export const canPush = (ctx: AuthContext): boolean => ctx.role === "owner" || ctx.role === "editor";
export const canInvite = (ctx: AuthContext): boolean => ctx.role === "owner";

// Browsers can't set headers on a WebSocket, so the session token rides in the subprotocol list as
// `carton.auth.<token>` next to `carton.v1` (every base64url and `.` character is a valid token char, RFC 7230).
// The host must answer with `carton.v1` only, never echo the token.
export const WS_PROTOCOL = "carton.v1";
export const WS_AUTH_PREFIX = "carton.auth.";

// The bearer token of a request: `Authorization: Bearer …` (Node clients, API calls), else the subprotocol.
export function tokenFromRequest(headers: { get(name: string): string | null }): string | null {
  const auth = headers.get("authorization");
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  const protos = headers.get("sec-websocket-protocol");
  if (protos) for (const p of protos.split(",")) {
    const t = p.trim();
    if (t.startsWith(WS_AUTH_PREFIX)) return t.slice(WS_AUTH_PREFIX.length);
  }
  return null;
}

// Whether the client offered our protocol (hosts answer with WS_PROTOCOL when it did).
export function offersCartonProtocol(headers: { get(name: string): string | null }): boolean {
  const protos = headers.get("sec-websocket-protocol");
  return !!protos && protos.split(",").some((p) => p.trim() === WS_PROTOCOL);
}
