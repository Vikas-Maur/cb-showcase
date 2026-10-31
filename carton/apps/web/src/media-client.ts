// The page side of the media Service Worker (media-worker.ts): registers /sw.js, tells it the session (again after
// each token refresh, and whenever the worker asks after an idle restart), and gives the app `/media/<hash>` URLs to
// put on <video> elements. When the worker reports that bytes which failed verification already went to a player,
// every <video> showing that media is reloaded where it was: the element would otherwise keep playing what it got.

import { MEDIA_PATH, type SessionMessage, type WorkerMessage } from "./media-protocol.ts";

export interface MediaClientOptions {
  /** The host as this page reaches it; normally `location.origin`. */
  baseUrl: string;
  projectId: string;
  /** The current session token (the app refreshes it; call refreshToken() after it does). */
  token: () => Promise<string> | string;
  /** Default "/sw.js". */
  scriptUrl?: string;
  /** Reload <video> elements whose media went out bad (default true). onBad listeners are called either way. */
  reloadVideos?: boolean;
  /** How long `ready` waits for the worker to take over the page. Default 10 s. */
  timeoutMs?: number;
}

export interface MediaClient {
  /** The URL a <video> plays this media from. */
  url(hash: string): string;
  /** Resolves once the worker controls this page and has the session; rejects if that can't happen. */
  readonly ready: Promise<void>;
  /** Called with the hash of media whose bytes went out bad. Returns an unsubscribe function. */
  onBad(cb: (hash: string) => void): () => void;
  /** Sends the current token to the worker; call after every refresh. */
  refreshToken(): Promise<void>;
  close(): void;
}

/** The media hash a `/media/<hash>` URL plays, or null. */
export function mediaHashOf(src: string): string | null {
  if (!src) return null;
  try {
    return MEDIA_PATH.exec(new URL(src, location.href).pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

let reloads = 0;
const MAX_RELOADS = 3;
const RELOAD_WINDOW_MS = 60_000;

/**
 * Reloads a <video> at its current time, keeping play state and rate. It gets a new URL (a `reload` query the worker
 * ignores), so nothing the element or the browser's media buffers kept from the old response can be reused.
 */
export function reloadAt(video: HTMLVideoElement): Promise<void> {
  const src = video.currentSrc || video.src;
  if (!src) return Promise.resolve();
  const at = video.currentTime;
  const playing = !video.paused && !video.ended;
  const rate = video.playbackRate;
  const u = new URL(src, location.href);
  u.searchParams.set("reload", String(++reloads));
  return new Promise((resolve) => {
    const done = () => {
      video.removeEventListener("loadedmetadata", done);
      video.removeEventListener("error", done);
      if (video.error === null) {
        video.currentTime = at;
        video.playbackRate = rate;
        if (playing) video.play().catch(() => {});
      }
      resolve();
    };
    video.addEventListener("loadedmetadata", done);
    video.addEventListener("error", done);
    video.src = u.origin === location.origin ? u.pathname + u.search : u.href;
  });
}

export function startMedia(o: MediaClientOptions): MediaClient {
  const sw: ServiceWorkerContainer | undefined = typeof navigator !== "undefined" ? navigator.serviceWorker : undefined;
  const listeners = new Set<(hash: string) => void>();
  let closed = false;

  async function send(): Promise<void> {
    if (!sw || closed) return;
    const msg: SessionMessage = { type: "carton-session", baseUrl: o.baseUrl, projectId: o.projectId, token: await o.token() };
    const reg = await sw.ready;
    reg.active?.postMessage(msg);
    // Until the new worker claims the page, an older one may still be the controller and receive its requests.
    if (sw.controller && sw.controller !== reg.active) sw.controller.postMessage(msg);
  }

  const onMessage = (e: MessageEvent) => {
    const d = e.data as WorkerMessage | null;
    if (closed || !d) return;
    if (d.type === "carton-session-request") {
      void send().catch(() => {});
    } else if (d.type === "carton-media-bad" && typeof d.hash === "string") {
      for (const cb of listeners) cb(d.hash);
      if (o.reloadVideos !== false && typeof document !== "undefined") {
        for (const v of document.querySelectorAll("video")) if (mediaHashOf(v.currentSrc || v.src) === d.hash && mayReload(v)) void reloadAt(v);
      }
    }
  };

  // A copy that is bad on the host too fails every read, and each failure reports served-bad again: reloading every
  // time would loop. A few reloads a minute per element, then the element shows its error.
  const recent = new WeakMap<HTMLVideoElement, number[]>();
  function mayReload(v: HTMLVideoElement): boolean {
    const now = Date.now();
    const times = (recent.get(v) ?? []).filter((t) => now - t < RELOAD_WINDOW_MS);
    if (times.length >= MAX_RELOADS) return false;
    times.push(now);
    recent.set(v, times);
    return true;
  }

  const ready = (async () => {
    if (!sw) throw new Error("Service Workers are not available here (an insecure origin, or a private window)");
    sw.addEventListener("message", onMessage);
    // Messages the worker sent before this listener existed are delivered now, not dropped.
    sw.startMessages();
    // updateViaCache "none": a new sw.js is picked up on the next load, not after the HTTP cache lets go of the old one.
    await sw.register(o.scriptUrl ?? "/sw.js", { scope: "/", updateViaCache: "none" });
    await send();
    if (sw.controller) return;
    // The worker claims the page on activation, or when it gets the session (after a hard reload).
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        sw.removeEventListener("controllerchange", onChange);
        reject(new Error("the media Service Worker did not take over this page"));
      }, o.timeoutMs ?? 10_000);
      const onChange = () => {
        clearTimeout(timer);
        sw.removeEventListener("controllerchange", onChange);
        resolve();
      };
      sw.addEventListener("controllerchange", onChange);
    });
  })();
  ready.catch(() => {}); // the caller decides what a failure means; an unobserved one must not be an unhandled rejection

  return {
    url: (hash) => `/media/${hash}`,
    ready,
    onBad(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    refreshToken: () => ready.then(send),
    close() {
      closed = true;
      sw?.removeEventListener("message", onMessage);
    },
  };
}
