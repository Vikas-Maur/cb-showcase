// The words for a cut whose sync is failing (Carton's `sync.error()` / `sync-error` events, REQ-8): what is wrong and
// what to do, shown in place of the sync status words. Without them an editor refused by its host (an older host than
// the document's schema, H-SV) would just say "Syncing" forever.

import type { SyncError } from "@carton/core";

/**
 * The code the app acts on. Stopgap until the transports' and sequencer's structured codes reach core's classifier
 * (hosts-plugins 9d52fc4, foundation-core): a browser that knows it is offline has a network problem, whatever the
 * failed connection was classified as (offline, core reads the transport's failure as `unauthorized`: REQ-9b).
 */
export function problemCode(e: SyncError, online: boolean = typeof navigator === "undefined" || navigator.onLine !== false): SyncError["code"] {
  return online ? e.code : "unreachable";
}

/** Whether to show it in place of the sync words: not for an unreachable host (they say "Offline: n edits waiting"). */
export function shownProblem(e: SyncError | null, online?: boolean): SyncError | null {
  return e && problemCode(e, online) !== "unreachable" ? e : null;
}

export function syncProblemWords(e: SyncError, online?: boolean): string {
  switch (problemCode(e, online)) {
    case "update-server":
      return "Can't sync: this project needs a newer server";
    case "unauthorized":
      return "Can't sync: this link no longer gives access";
    case "unreachable":
      return "Can't reach the server: edits wait here";
    case "unknown-cut":
      return "Can't sync: the server doesn't have this cut";
    case "too-large":
      return "Can't sync: this cut is over the server's limit";
    default:
      return `Can't sync: ${e.message}`;
  }
}
