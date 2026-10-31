// A session with a Carton host through its HTTP API (@carton/host-http): join with an invite, refresh before the
// token expires, and the per-install key the device credential is derived from (§6.3). The install key is presented
// only to join and refresh, never on a connection, so a leaked session token can't claim this device. Runs in the
// page, the Service Worker's page side, and the Node scripts (the bot and the seed pass their own key store).

import type { AuthContext } from "@carton/core/plugins";

export interface KeyStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export function memoryKeys(): KeyStore {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v) };
}

/** Refresh this long before a token expires (a refresh is one small request). */
const EARLY_MS = 120_000;

const hex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");

async function post<T>(url: string, body: unknown, fetchFn: typeof fetch): Promise<T> {
  const r = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await r.text();
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {
    // not JSON: reported below
  }
  if (!r.ok) throw Object.assign(new Error((data as { error?: string } | null)?.error ?? `${r.status} ${r.statusText}`), { status: r.status });
  return data as T;
}

const slotKey = (projectId: string, slot?: string) => `carton.session.${projectId}${slot ? `.${slot}` : ""}`;

export class Session {
  readonly baseUrl: string;
  readonly projectId: string;
  #token: string;
  #context: AuthContext;
  #keys: KeyStore;
  #fetch: typeof fetch;
  #refreshing: Promise<string> | null = null;
  #listeners = new Set<(token: string) => void>();
  /** Where it is saved: the editor's and the watch page's sessions of one project are kept apart. */
  #slot: string;

  private constructor(baseUrl: string, projectId: string, token: string, context: AuthContext, keys: KeyStore, fetchFn: typeof fetch, slot: string) {
    this.#slot = slot;
    this.baseUrl = baseUrl;
    this.projectId = projectId;
    this.#token = token;
    this.#context = context;
    this.#keys = keys;
    this.#fetch = fetchFn;
  }

  /** This install's key (made once, kept in `keys`). */
  static installKey(keys: KeyStore): string {
    let k = keys.get("carton.installKey");
    if (!k) keys.set("carton.installKey", (k = hex(32)));
    return k;
  }

  /** Join with an invite as `account` (a person's or agent's name on this project). */
  static async join(o: { baseUrl: string; projectId: string; invite: string; account: string; keys: KeyStore; fetch?: typeof fetch; slot?: string }): Promise<Session> {
    const f = o.fetch ?? fetch.bind(globalThis);
    const r = await post<{ token: string; context: AuthContext }>(`${o.baseUrl}/api/projects/${o.projectId}/join`, { invite: o.invite, account: o.account, installKey: Session.installKey(o.keys) }, f);
    const s = new Session(o.baseUrl, o.projectId, r.token, r.context, o.keys, f, slotKey(o.projectId, o.slot));
    s.#save();
    return s;
  }

  /** The session this install saved for the project, refreshed if it is close to expiry; null when there is none. */
  static async resume(o: { baseUrl: string; projectId: string; keys: KeyStore; fetch?: typeof fetch; slot?: string }): Promise<Session | null> {
    const raw = o.keys.get(slotKey(o.projectId, o.slot));
    if (!raw) return null;
    try {
      const { token, context } = JSON.parse(raw) as { token: string; context: AuthContext };
      const s = new Session(o.baseUrl, o.projectId, token, context, o.keys, o.fetch ?? fetch.bind(globalThis), slotKey(o.projectId, o.slot));
      await s.token();
      return s;
    } catch {
      return null; // expired past its grace, or the host's key rotated: join again
    }
  }

  get context(): AuthContext {
    return this.#context;
  }
  get account(): string {
    return this.#context.account;
  }
  get role(): AuthContext["role"] {
    return this.#context.role;
  }
  /** Where this project's clients connect. */
  get wsUrl(): string {
    return `${this.baseUrl.replace(/^http/, "ws")}/api/projects/${this.projectId}/ws`;
  }

  /** A valid token: refreshed first when it expires within two minutes (one refresh at a time). */
  async token(): Promise<string> {
    if (this.#context.expires - Date.now() > EARLY_MS) return this.#token;
    this.#refreshing ??= this.#refresh().finally(() => (this.#refreshing = null));
    return this.#refreshing;
  }
  onToken(l: (token: string) => void): () => void {
    this.#listeners.add(l);
    return () => this.#listeners.delete(l);
  }
  async #refresh(): Promise<string> {
    const r = await post<{ token: string; context: AuthContext }>(`${this.baseUrl}/api/projects/${this.projectId}/refresh`, { token: this.#token, installKey: Session.installKey(this.#keys) }, this.#fetch);
    this.#token = r.token;
    this.#context = r.context;
    this.#save();
    for (const l of this.#listeners) l(r.token);
    return r.token;
  }
  #save(): void {
    this.#keys.set(this.#slot, JSON.stringify({ token: this.#token, context: this.#context }));
  }

  /** An authorized API call (JSON in and out). */
  async api<T>(path: string, body?: unknown): Promise<T> {
    const r = await this.#fetch(`${this.baseUrl}/api/projects/${this.projectId}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${await this.token()}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = (await r.json().catch(() => null)) as T & { error?: string };
    if (!r.ok) throw Object.assign(new Error(data?.error ?? `${r.status} ${r.statusText}`), { status: r.status });
    return data;
  }
  /** An invite link's token (owners only, `canInvite`). */
  async invite(role: AuthContext["role"], ttlMs?: number): Promise<string> {
    return (await this.api<{ invite: string }>("/invites", { role, ...(ttlMs ? { ttlMs } : {}) })).invite;
  }
}
