// The Service Worker entry, served as /sw.js. Bundled on its own (esbuild: iife, platform browser; see
// scripts/build-sw.ts), so it stays small: the media reader, the HTTP blob store and nothing of the app.

import { installMediaWorker, type WorkerScope } from "./media-worker.ts";

installMediaWorker(self as unknown as WorkerScope);
