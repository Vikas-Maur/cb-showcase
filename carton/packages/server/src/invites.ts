// Invite links and device-bound sessions for the demo (PLAN §6.3, §14), on top of any AuthProvider that can `issue`
// (the demo's createHmacAuth; Cardboard's accounts later). Written by hosts-plugins: both hosts serve these routes.
//
// - An invite is the share link: `{project, role, expiry}`, HMAC-signed. It names no account or device.
// - `join(invite, account, installKey)` gives the device a session (the provider's token, short-lived, sent on every
//   connection) and a grant (long-lived, only for `refresh`). The session's credential is `account/deviceId`, where
//   deviceId hashes the per-install key (§14: kept in the OS keychain or app data). Replica ids are bound to that
//   credential (§6.3), so a device that is re-invited, or refreshes after a week offline, gets the same credential
//   and its pending changes are still accepted.
// - The install key itself is sent only to `join` and `refresh`, never on a connection, and a grant is useless
//   without it: a leaked session expires within its TTL, a leaked invite can't claim someone else's device.
// Invites and grants are signed with a key derived from the secret under their own labels, so neither can pass as
// the other or as a session token.

import type { AuthContext, AuthProvider, Role } from "@carton/core/plugins";

const ROLES: readonly Role[] = ["owner", "editor", "commenter", "viewer"];
const ID_RE = /^[A-Za-z0-9._~-]{1,128}$/;
const MAX_TOKEN = 2048;
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

export class AuthError extends Error {
  readonly status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

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

// The device id for an install key: what a credential carries instead of the key itself.
export async function deviceId(installKey: string): Promise<string> {
  if (typeof installKey !== "string" || installKey.length < 16 || installKey.length > 512)
    throw new AuthError("install key must be 16-512 characters", 400);
  const h = await crypto.subtle.digest("SHA-256", enc.encode("carton-device.v1\0" + installKey));
  return b64url(new Uint8Array(h, 0, 18)); // 144 bits: unguessable, short enough to read in logs
}

// A fresh random install key, for clients.
export function newInstallKey(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

interface InviteClaims {
  typ: "invite";
  prj: string;
  role: Role;
  exp: number; // ms
}

interface GrantClaims {
  typ: "grant";
  prj: string;
  role: Role;
  acc: string;
  dev: string;
  brs?: string[];
  exp: number;
}

export interface Joined {
  // the provider's token: what a connection presents
  session: string;
  // the refresh token: kept with the install key, exchanged with it for a new session
  grant: string;
  context: AuthContext;
}

export interface InviteServiceOptions {
  // Issues and verifies the session tokens.
  auth: AuthProvider;
  // Signs invites and grants: at least 32 bytes, from the environment, never from code.
  secret: string | Uint8Array;
  sessionTtlMs?: number;
  inviteTtlMs?: number;
  grantTtlMs?: number;
  clock?: () => number;
}

export interface InviteService {
  createInvite(project: string, role: Role, ttlMs?: number): Promise<string>;
  join(invite: string, account: string, installKey: string): Promise<Joined>;
  refresh(grant: string, installKey: string): Promise<Joined>;
}

export function createInviteService(opts: InviteServiceOptions): InviteService {
  const issue = opts.auth.issue?.bind(opts.auth);
  if (!issue) throw new Error("createInviteService: the AuthProvider must be able to issue tokens");
  const raw = typeof opts.secret === "string" ? enc.encode(opts.secret) : opts.secret;
  if (raw.length < 32) throw new Error("createInviteService: the secret must be at least 32 bytes");
  const now = opts.clock ?? Date.now;
  const sessionTtl = opts.sessionTtlMs ?? 24 * 3600_000;
  const inviteTtl = opts.inviteTtlMs ?? 7 * 24 * 3600_000;
  const grantTtl = opts.grantTtlMs ?? 90 * 24 * 3600_000;

  const master = crypto.subtle.importKey("raw", raw as Uint8Array<ArrayBuffer>, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const derive = async (label: string) =>
    crypto.subtle.importKey("raw", await crypto.subtle.sign("HMAC", await master, enc.encode(label)), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  const keys = { invite: derive("carton-invite.v1"), grant: derive("carton-grant.v1") };
  const prefix = { invite: "ci1.", grant: "cg1." } as const;

  async function sign(c: InviteClaims | GrantClaims): Promise<string> {
    const body = prefix[c.typ] + b64url(enc.encode(JSON.stringify(c)));
    return body + "." + b64url(new Uint8Array(await crypto.subtle.sign("HMAC", await keys[c.typ], enc.encode(body))));
  }

  // The signature is checked (constant time, subtle.verify) before a single claim is read.
  async function open<T extends InviteClaims | GrantClaims>(token: string, typ: T["typ"]): Promise<T> {
    if (typeof token !== "string" || token.length > MAX_TOKEN || !token.startsWith(prefix[typ])) throw new AuthError(`not ${typ === "invite" ? "an invite" : "a grant"}`);
    const dot = token.lastIndexOf(".");
    if (dot <= prefix[typ].length) throw new AuthError("bad token");
    const body = token.slice(0, dot);
    let mac: Uint8Array;
    try {
      mac = fromB64url(token.slice(dot + 1));
    } catch {
      throw new AuthError("bad token");
    }
    if (!(await crypto.subtle.verify("HMAC", await keys[typ], mac as Uint8Array<ArrayBuffer>, enc.encode(body)))) throw new AuthError("bad signature");
    let c: T;
    try {
      c = JSON.parse(dec.decode(fromB64url(body.slice(prefix[typ].length))));
    } catch {
      throw new AuthError("bad token");
    }
    if (c.typ !== typ || !ROLES.includes(c.role) || !ID_RE.test(c.prj) || !Number.isFinite(c.exp)) throw new AuthError("bad token");
    if (c.exp < now()) throw new AuthError(`${typ} expired`);
    return c;
  }

  async function issueFor(c: GrantClaims): Promise<Joined> {
    const claims: Omit<AuthContext, "expires"> = { account: c.acc, credential: `${c.acc}/${c.dev}`, role: c.role, projectId: c.prj };
    if (c.brs) claims.branches = c.brs;
    const session = await issue!({ ...claims, ttlMs: sessionTtl });
    const context = await opts.auth.verify(session);
    if (!context) throw new Error("the AuthProvider refused a token it just issued");
    return { session, grant: await sign({ ...c, exp: now() + grantTtl }), context };
  }

  return {
    async createInvite(project, role, ttlMs = inviteTtl) {
      if (!ID_RE.test(project)) throw new AuthError("bad project id", 400);
      if (!ROLES.includes(role)) throw new AuthError("bad role", 400);
      return sign({ typ: "invite", prj: project, role, exp: now() + ttlMs });
    },
    async join(invite, account, installKey) {
      const c = await open<InviteClaims>(invite, "invite");
      if (typeof account !== "string" || !ID_RE.test(account)) throw new AuthError("bad account id", 400);
      return issueFor({ typ: "grant", prj: c.prj, role: c.role, acc: account, dev: await deviceId(installKey), exp: 0 });
    },
    async refresh(grant, installKey) {
      const c = await open<GrantClaims>(grant, "grant");
      if ((await deviceId(installKey)) !== c.dev) throw new AuthError("install key does not match this grant's device");
      return issueFor(c);
    },
  };
}

export const canPush = (ctx: AuthContext): boolean => ctx.role === "owner" || ctx.role === "editor";
export const canInvite = (ctx: AuthContext): boolean => ctx.role === "owner";

// Browsers can't set headers on a WebSocket, so the session token rides in the subprotocol list as
// `carton.auth.<token>` next to `carton.v1` (base64url and `.` are valid token characters, RFC 7230). The host
// answers with `carton.v1` only, never echoing the token.
export const WS_PROTOCOL = "carton.v1";
export const WS_AUTH_PREFIX = "carton.auth.";

// The bearer token of a request: `Authorization: Bearer …` (Node clients, API calls), else the subprotocol.
export function tokenFromRequest(headers: { get(name: string): string | null }): string | null {
  const auth = headers.get("authorization");
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  const protos = headers.get("sec-websocket-protocol");
  if (protos)
    for (const p of protos.split(",")) {
      const t = p.trim();
      if (t.startsWith(WS_AUTH_PREFIX)) return t.slice(WS_AUTH_PREFIX.length);
    }
  return null;
}

export function offersCartonProtocol(headers: { get(name: string): string | null }): boolean {
  const protos = headers.get("sec-websocket-protocol");
  return !!protos && protos.split(",").some((p) => p.trim() === WS_PROTOCOL);
}
