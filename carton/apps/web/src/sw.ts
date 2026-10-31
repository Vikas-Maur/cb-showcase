// The Service Worker entry, served as /sw.js. Bundled on its own (esbuild: iife, platform browser; see
// scripts/build-sw.ts), so it stays small: the media reader, the HTTP blob store and the app-shell cache, nothing of
// the app itself. The build defines __CARTON_ASSETS__ (the shell's files); without it (tests) there is no shell cache.

import { installAppShell } from "./app-shell.ts";
import { installMediaWorker, type WorkerScope } from "./media-worker.ts";

declare const __CARTON_ASSETS__: string[] | undefined;

installMediaWorker(self as unknown as WorkerScope);
if (typeof __CARTON_ASSETS__ !== "undefined") installAppShell(self as unknown as Parameters<typeof installAppShell>[0], __CARTON_ASSETS__);
