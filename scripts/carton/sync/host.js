// A Carton host's HTTP API (@carton/host-http), as the Windows app uses it: join with an invite, refresh a session,
// make an invite, and read or write the project's share descriptor in its media scope. Web-standard fetch only, so it
// runs in the library worker, main and cb alike. The link format is the web client's (carton/apps/web), so a project
// shared from the app can be joined in a browser and the other way round:
//   <host>/#join=<projectId>.<invite>
// The invite rides in the fragment, so it never reaches a server log.

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
/** The first owner's invite, made with the host's admin token (the host operator has it; never stored by the app). */
export const adminInvite = async ({ host, projectId, adminToken, role = "owner", fetchFn }) =>
  (await call(`${origin(host)}/api/admin/projects/${encodeURIComponent(projectId)}/invites`, { token: adminToken, body: { role }, fetchFn })).invite;

/**
 * A short-lived signed URL for one key of the project's media scope, moved onto the origin this computer reaches the
 * host by (as host-blobs.js does): the signature covers the path and query, not the origin, and a host behind a proxy
 * signs with its own listen address.
 */
const sign = async ({ host, projectId, token, key, method, fetchFn }) => {
  const u = new URL((await call(api(host, projectId, "/blobs/sign"), { token, body: { key, method, expiresIn: 300 }, fetchFn })).url, origin(host));
  const b = new URL(origin(host));
  u.protocol = b.protocol;
  u.host = b.host;
  return u.toString();
};

export async function putBlob({ host, projectId, token, key, bytes, contentType = "application/octet-stream", fetchFn = fetch }) {
  const url = await sign({ host, projectId, token, key, method: "PUT", fetchFn });
  const r = await fetchFn(url, { method: "PUT", headers: { "content-type": contentType }, body: bytes });
  if (!r.ok) throw new Error(`The host refused the upload of ${key} (${r.status})`);
}
export async function getBlob({ host, projectId, token, key, fetchFn = fetch }) {
  const url = await sign({ host, projectId, token, key, method: "GET", fetchFn });
  const r = await fetchFn(url);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`The host refused the download of ${key} (${r.status})`);
  return new Uint8Array(await r.arrayBuffer());
}

/**
 * What a joiner needs beyond the token (the web client's format, `carton/apps/web/src/descriptor.ts`): the shared cut
 * as the host knows it after the hand-off, its state at seq 0 and that state's hash (Carton checks it before storing
 * anything), and the media records (T0) by id.
 */
export function descriptor({ projectId, name, cut, doc0, rootHash, media = {} }) {
  return { v: 1, projectId, name, cut, doc0, rootHash, media };
}
export function parseDescriptor(text) {
  const d = JSON.parse(text);
  if (d?.v !== 1 || typeof d.projectId !== "string" || !d.cut?.id || d.cut.sequencer?.kind !== "server" || typeof d.rootHash !== "string" || !d.doc0) throw new Error("This project's share data is unreadable");
  return d;
}
