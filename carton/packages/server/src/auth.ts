// Demo AuthProvider (§14): HMAC-SHA-256 invite tokens on WebCrypto, so the same code runs in Workers, browsers and
// Node. A token is `base64url(claims).base64url(hmac)`; the claims are the AuthContext (account, device credential,
// role, project, optional branch scope, expiry). The secret comes from the host's environment, never from code.

import type { AuthContext, AuthProvider, Role } from "@carton/core/plugins";

const enc = new TextEncoder();
const dec = new TextDecoder();
const ROLES: ReadonlySet<string> = new Set<Role>(["owner", "editor", "commenter", "viewer"]);

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function unb64url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(s.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (s.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function isContext(x: unknown): x is AuthContext {
  const c = x as AuthContext;
  return (
    !!c &&
    typeof c.account === "string" &&
    typeof c.credential === "string" &&
    typeof c.projectId === "string" &&
    ROLES.has(c.role) &&
    typeof c.expires === "number" &&
    (c.branches === undefined || (Array.isArray(c.branches) && c.branches.every((b) => typeof b === "string")))
  );
}

export function createHmacAuth({ secret, clock = Date.now }: { secret: string | Uint8Array; clock?: () => number }): AuthProvider {
  const raw = typeof secret === "string" ? enc.encode(secret) : secret;
  if (raw.length < 16) throw new Error("createHmacAuth: the secret must be at least 16 bytes");
  const key = crypto.subtle.importKey("raw", raw as Uint8Array<ArrayBuffer>, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  return {
    kind: "hmac",
    async issue(claims) {
      const { ttlMs, ...rest } = claims;
      const ctx: AuthContext = { ...rest, expires: clock() + ttlMs };
      const body = b64url(enc.encode(JSON.stringify(ctx)));
      const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await key, enc.encode(body)));
      return `${body}.${b64url(sig)}`;
    },
    async verify(token) {
      if (typeof token !== "string" || token.length > 8192) return null;
      const dot = token.indexOf(".");
      if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
      const body = token.slice(0, dot);
      const sig = unb64url(token.slice(dot + 1));
      // canonical only: a last character that differs in its unused bits decodes to the same MAC, but it is not the
      // token that was issued (the AuthProvider suite's tamper check)
      if (!sig || sig.length !== 32 || b64url(sig) !== token.slice(dot + 1)) return null;
      // WebCrypto's verify compares in constant time
      if (!(await crypto.subtle.verify("HMAC", await key, sig as Uint8Array<ArrayBuffer>, enc.encode(body)))) return null;
      const bytes = unb64url(body);
      if (!bytes) return null;
      let ctx: unknown;
      try {
        ctx = JSON.parse(dec.decode(bytes));
      } catch {
        return null;
      }
      if (!isContext(ctx) || ctx.expires < clock()) return null;
      return ctx;
    },
  };
}
