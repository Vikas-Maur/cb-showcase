// The page browser-media.test.ts opens: starts the media client with the session in the URL fragment, puts a <video>
// on /media/<hash>, and leaves what happened in `window.__media` for the test to read.

import { mediaHashOf, reloadAt, startMedia } from "../../src/media-client.ts";

interface Out {
  bad: string[];
  done?: boolean;
  error?: string;
  controlled?: boolean;
  loaded?: { readyState: number; duration: number; width: number; height: number; src: string };
}

const out: Out = { bad: [] };
const w = window as unknown as { __media: Out; __video?: HTMLVideoElement; __reloadAt: typeof reloadAt; __hashOf: typeof mediaHashOf };
w.__media = out;
w.__reloadAt = reloadAt;
w.__hashOf = mediaHashOf;

const params = new URLSearchParams(location.hash.slice(1));
const media = startMedia({ baseUrl: location.origin, projectId: params.get("p")!, token: () => params.get("t")! });
media.onBad((hash) => out.bad.push(hash));

(async () => {
  await media.ready;
  out.controlled = navigator.serviceWorker.controller !== null;
  const v = document.createElement("video");
  v.muted = true;
  v.preload = "auto";
  document.body.append(v);
  w.__video = v;
  await new Promise<void>((resolve, reject) => {
    v.addEventListener("loadeddata", () => resolve(), { once: true });
    v.addEventListener("error", () => reject(new Error(`video error ${v.error?.code}: ${v.error?.message}`)), { once: true });
    v.src = media.url(params.get("h")!);
  });
  out.loaded = { readyState: v.readyState, duration: v.duration, width: v.videoWidth, height: v.videoHeight, src: v.currentSrc };
})()
  .catch((e) => (out.error = String(e)))
  .finally(() => (out.done = true));
