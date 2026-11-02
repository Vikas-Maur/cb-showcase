// A Carton host's HTTP API (@carton/host-http), as the Windows app uses it: join with an invite, refresh a session,
// make an invite, and read or write the project's share descriptor in its media scope. Web-standard fetch only, so it
// runs in the library worker, main and cb alike. The link format is the web client's (carton/apps/web), so a project
// shared from the app can be joined in a browser and the other way round:
//   <host>/#join=<projectId>.<invite>
// The invite rides in the fragment, so it never reaches a server log.

import { hostMediaBlobs } from "@carton/host-http/client";

export const DESCRIPTOR_KEY = "carton/project.json";

/** `http(s)://host[:port][/…]#join=<projectId>.<invite>` → its parts, or null. */
export function parseInviteLink(link) {
  let u;
  try { u = new URL(String(link).trim()); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const m = /^#join=([A-Za-z0-9_~-]{1,128})\.(.+)$/.exec(u.hash);
  return m ? { host: u.origin, projectId: m[1], invite: m[2] } : null;
}
export const inviteLink = (host, projectId, invite) => `${origin(host)}/#join=${projectId}.${invite}`;
export const origin = (host) => new URL(String(host)).origin;
export const wsUrl = (host, projectId) => `${origin(host).replace(/^http/, "ws")}/api/projects/${encodeURIComponent(projectId)}/ws`;

/** An account id the demo auth accepts (letters, digits, `._~-`), from a person's name. */
export const accountId = (name) => String(name ?? "").normalize("NFKD").replace(/[^\w.~-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "editor";

async function call(url, { method = "POST", body, token, fetchFn = fetch } = {}) {
  const headers = { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const r = await fetchFn(url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON: reported below */ }
  if (!r.ok) throw Object.assign(new Error(hostError(r.status, data?.error)), { status: r.status });
  return data;
}
// What a person reads when the host says no.
function hostError(status, said) {
  if (status === 401) return "The host didn't accept the invite or session" + (said ? ` (${said})` : "");
  if (status === 403) return "This invite doesn't allow that" + (said ? ` (${said})` : "");
  if (status === 501) return "This host doesn't issue invite links";
  if (status === 409) return "This project is already shared on that host: ask its owner for an invite";
  if (status === 429) return said ?? "This host takes no more new projects from your network today";
  return `The host answered ${status}` + (said ? `: ${said}` : "");
}

const api = (host, projectId, rest) => `${origin(host)}/api/projects/${encodeURIComponent(projectId)}${rest}`;

/** Exchange an invite for a session bound to this install (its key is shown only here and to refresh). */
export const join = ({ host, projectId, invite, account, installKey, fetchFn }) =>
  call(api(host, projectId, "/join"), { body: { invite, account, installKey }, fetchFn });
export const refresh = ({ host, projectId, token, installKey, fetchFn }) =>
  call(api(host, projectId, "/refresh"), { body: { token, installKey }, fetchFn });
/** An invite link's token (owners only). */
export const createInvite = async ({ host, projectId, token, role, ttlMs, fetchFn }) =>
  (await call(api(host, projectId, "/invites"), { token, body: { role, ...(ttlMs ? { ttlMs } : {}) }, fetchFn })).invite;
/**
 * What a host allows: `openCreate` (anyone may share a project there, no token needed) and the largest upload. A host
 * from before open creation has no such route: it takes a token, as before.
 */
export async function hostInfo({ host, fetchFn = fetch }) {
  try {
    const r = await fetchFn(`${origin(host)}/api/host`, { method: "GET" });
    if (!r.ok) return { openCreate: false, maxUploadBytes: null };
    const d = await r.json();
    return { openCreate: d?.openCreate === true, maxUploadBytes: typeof d?.maxUploadBytes === "number" ? d.maxUploadBytes : null };
  } catch (e) {
    throw Object.assign(new Error(`Couldn't reach ${origin(host)}: check the address`), { cause: e });
  }
}
/** A new project on an open host, with this install as its first owner (no invite, no token). */
export const createProject = ({ host, projectId, account, installKey, fetchFn }) =>
  call(api(host, projectId, "/create"), { body: { account, installKey }, fetchFn });
/** The first owner's invite, made with the host's admin token (the host operator has it; never stored by the app). */
export const adminInvite = async ({ host, projectId, adminToken, role = "owner", fetchFn }) =>
  (await call(`${origin(host)}/api/admin/projects/${encodeURIComponent(projectId)}/invites`, { token: adminToken, body: { role }, fetchFn })).invite;

/**
 * The project's media scope on the host, as a BlobStore: hosts-plugins' client over the HTTP media API
 * (`@carton/host-http/client`: resumable multipart uploads, signed URLs for small objects and ranged reads, the §11
 * repair report). `token` is a string or a function returning a fresh one. Signed URLs are moved onto the origin this
 * computer reaches the host by: the signature covers the path and query, not the origin, and a host behind a reverse
 * proxy signs with its own listen address (e2e-qa S5-2, still open on the host side).
 */
export function mediaStore({ host, projectId, token, fetchFn = (u, i) => fetch(u, i) }) {
  const pub = origin(host);
  return hostMediaBlobs({ origin: pub, projectId, token, fetch: (u, i) => fetchFn(ontoOrigin(pub, u), i) });
}

/**
 * A signed media URL (`/blob/…`) on `origin`, the one this computer reaches the host by: scheme, host and port. The
 * whole origin, never the host alone: a host behind TLS termination signs http://<same host>, which must not go out as
 * plain http (review round 3 #6). Anything else is left as it is.
 */
export function ontoOrigin(origin, u) {
  const pub = new URL(origin), url = new URL(String(u instanceof Request ? u.url : u));
  if (!url.pathname.startsWith("/blob/") || url.origin === pub.origin) return u;
  url.protocol = pub.protocol;
  url.hostname = pub.hostname;
  url.port = pub.port;
  return url.toString();
}

export const putBlob = ({ host, projectId, token, key, bytes, contentType = "application/octet-stream", fetchFn }) =>
  mediaStore({ host, projectId, token, fetchFn }).put(key, bytes, { contentType });
export const getBlob = ({ host, projectId, token, key, fetchFn }) => mediaStore({ host, projectId, token, fetchFn }).get(key);

/**
 * What a joiner needs beyond the token (the web client's format, `carton/apps/web/src/descriptor.ts`): the shared cut
 * as the host knows it after the hand-off, its state at seq 0 and that state's hash (Carton checks it before storing
 * anything), and the media records (T0) by id. `by`: who made the cut when it is a fork (Carton keeps it beside the
 * cut's record, so a joiner's "Made this cut" names them too); the web client shares Main only and has none. A joiner
 * from before it ignores it.
 */
export function descriptor({ projectId, name, cut, doc0, rootHash, media = {}, by = null }) {
  return { v: 1, projectId, name, cut, doc0, rootHash, media, ...(by ? { by } : {}) };
}
export function parseDescriptor(text) {
  const d = JSON.parse(text);
  if (d?.v !== 1 || typeof d.projectId !== "string" || !d.cut?.id || d.cut.sequencer?.kind !== "server" || typeof d.rootHash !== "string" || !d.doc0) throw new Error("This project's share data is unreadable");
  return d;
}
