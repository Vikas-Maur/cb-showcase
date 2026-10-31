// The web player's media path (PLAN §11): a Service Worker answers `GET /media/<hash>` (and HEAD) from the project's
// media store through one MediaReader, so a <video> plays first and every leaf is verified as it completes, and the
// verified leaves stay in a range cache. Everything else (the API, signed blob URLs, the WebSocket, app files) is
// left to the network.
//
// - The page tells the worker its session (`carton-session`: baseUrl, projectId, token) when it starts and after each
//   token refresh. A browser stops an idle worker and starts it again on the next request, which forgets every
//   session, so a request from a page the worker doesn't know asks that page for it (`carton-session-request`) and
//   waits for the answer, up to `sessionWaitMs`, then 503.
// - Each page is mapped to its project by client id, so two tabs on two projects each read their own media scope.
// - When bytes that failed verification already went to a player (`served-bad`), every page is told
//   (`carton-media-bad`): breaking the response doesn't make the element drop what it has, so the page reloads it.
//
// This file takes the worker scope as an argument, so Node tests can drive it; sw.ts installs it on `self`.

import { MediaReader, MemoryLeafCache, serveMedia, webCryptoHasher, type ReaderEvent } from "@carton/media";
import { httpBlobStore } from "./http-blobs.ts";
import { MEDIA_PATH, type SessionMessage, type WorkerMessage } from "./media-protocol.ts";

/** The parts of ServiceWorkerGlobalScope this uses (the DOM typings this app compiles with have no worker scope). */
export interface WorkerClient {
  readonly id: string;
  postMessage(message: WorkerMessage): void;
}
export interface ExtendableEventLike {
  waitUntil(p: Promise<unknown>): void;
}
export interface FetchEventLike extends ExtendableEventLike {
  readonly request: Request;
  readonly clientId: string;
  respondWith(r: Promise<Response>): void;
}
export interface MessageEventLike extends ExtendableEventLike {
  readonly data: unknown;
  readonly source: { readonly id?: string } | null;
}
export interface WorkerScope {
  readonly location: { readonly origin: string };
  readonly clients: {
    claim(): Promise<void>;
    get(id: string): Promise<WorkerClient | undefined>;
    matchAll(opts?: { type?: "window" | "all"; includeUncontrolled?: boolean }): Promise<readonly WorkerClient[]>;
  };
  skipWaiting(): Promise<void>;
  addEventListener(type: "install" | "activate", fn: (e: ExtendableEventLike) => void): void;
  addEventListener(type: "message", fn: (e: MessageEventLike) => void): void;
  addEventListener(type: "fetch", fn: (e: FetchEventLike) => void): void;
}

export interface MediaWorkerOptions {
  /** How long a media request waits for its page's session before answering 503. Default 10 s. */
  sessionWaitMs?: number;
  /** Bytes of verified leaves kept in memory (shared by every project: leaves are named by content). Default 128 MiB. */
  cacheBytes?: number;
  fetch?: typeof fetch;
}

interface Project {
  baseUrl: string;
  projectId: string;
  token: string;
  reader: MediaReader;
}

// Pages and projects remembered; older ones are dropped first (a page that comes back is asked again).
const MAX_CLIENTS = 256;
const MAX_PROJECTS = 16;

const isSession = (d: unknown): d is SessionMessage => {
  const m = d as Partial<SessionMessage> | null;
  return m?.type === "carton-session" && typeof m.baseUrl === "string" && typeof m.projectId === "string" && typeof m.token === "string";
};

export function installMediaWorker(sw: WorkerScope, opts: MediaWorkerOptions = {}): void {
  const waitMs = opts.sessionWaitMs ?? 10_000;
  const cache = new MemoryLeafCache(opts.cacheBytes ?? 128 * 1024 * 1024);
  const hasher = webCryptoHasher();
  const projects = new Map<string, Project>();
  const clientProject = new Map<string, string>();
  // Requests waiting for a session: each re-checks when one arrives.
  const waiting = new Set<() => void>();

  const broadcast = async (msg: WorkerMessage): Promise<void> => {
    try {
      for (const c of await sw.clients.matchAll({ type: "window" })) c.postMessage(msg);
    } catch {
      // nobody to tell
    }
  };
  const onEvent = (e: ReaderEvent) => {
    if (e.type === "served-bad") void broadcast({ type: "carton-media-bad", hash: e.hash });
  };

  function remember<V>(m: Map<string, V>, key: string, value: V, max: number): void {
    m.delete(key);
    m.set(key, value);
    if (m.size > max) m.delete(m.keys().next().value!);
  }

  function project(s: SessionMessage): Project {
    const key = `${s.baseUrl}\n${s.projectId}`;
    let p = projects.get(key);
    if (p) {
      p.token = s.token;
      return p;
    }
    const store = httpBlobStore({ baseUrl: s.baseUrl, projectId: s.projectId, token: () => p!.token, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
    p = { baseUrl: s.baseUrl, projectId: s.projectId, token: s.token, reader: new MediaReader({ store, hasher, cache, contentType: () => "video/mp4", onEvent }) };
    remember(projects, key, p, MAX_PROJECTS);
    return p;
  }

  const find = (clientId: string): Project | undefined => {
    const key = clientProject.get(clientId);
    return key === undefined ? undefined : projects.get(key);
  };

  async function projectFor(clientId: string): Promise<Project | undefined> {
    const known = find(clientId);
    if (known) return known;
    // Ask the page that made the request; a request with no client (rare) asks every page.
    void (async () => {
      const c = clientId ? await sw.clients.get(clientId) : undefined;
      if (c) c.postMessage({ type: "carton-session-request" });
      else await broadcast({ type: "carton-session-request" });
    })().catch(() => {});
    return new Promise((resolve) => {
      const done = (p: Project | undefined) => {
        clearTimeout(timer);
        waiting.delete(check);
        resolve(p);
      };
      const check = () => {
        const p = find(clientId);
        if (p) done(p);
      };
      // No answer: with a single project there's only one store it can be in; with several, give up.
      const timer = setTimeout(() => done(projects.size === 1 ? projects.values().next().value : undefined), waitMs);
      waiting.add(check);
    });
  }

  async function respond(hash: string, e: FetchEventLike): Promise<Response> {
    const p = await projectFor(e.clientId);
    if (!p) return new Response("no Carton session for this page yet", { status: 503, headers: { "retry-after": "1" } });
    try {
      return await serveMedia(p.reader, hash, e.request);
    } catch (err) {
      // The manifest or the object's size couldn't be fetched (offline, expired session): the element retries.
      return new Response(String((err as Error)?.message ?? err), { status: 502 });
    }
  }

  sw.addEventListener("install", (e) => e.waitUntil(sw.skipWaiting()));
  // Take over pages that are already open, so the first load plays through the worker without a reload.
  sw.addEventListener("activate", (e) => e.waitUntil(sw.clients.claim()));

  sw.addEventListener("message", (e) => {
    if (!isSession(e.data)) return;
    const p = project(e.data);
    const id = e.source?.id;
    if (id) remember(clientProject, id, `${p.baseUrl}\n${p.projectId}`, MAX_CLIENTS);
    for (const check of [...waiting]) check();
    // A page opened with a hard reload isn't controlled by any worker until one claims it.
    e.waitUntil(sw.clients.claim().catch(() => {}));
  });

  sw.addEventListener("fetch", (e) => {
    const url = new URL(e.request.url);
    if (url.origin !== sw.location.origin) return;
    const m = MEDIA_PATH.exec(url.pathname);
    if (!m) return;
    e.respondWith(respond(m[1]!, e));
  });
}
