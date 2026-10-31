// The words for a cut whose sync is failing (Carton's `sync.error()` / `sync-error` events, REQ-8): what is wrong and
// what to do, shown in place of the sync status words. Without them an editor refused by its host (an older host than
// the document's schema, H-SV) would just say "Syncing" forever.

import type { SyncError } from "@carton/core";

/** Whether to show it in place of the sync words: not for an unreachable host (they say "Offline: n edits waiting"). */
export function shownProblem(e: SyncError | null): SyncError | null {
  return e && e.code !== "unreachable" ? e : null;
}

export function syncProblemWords(e: SyncError): string {
  switch (e.code) {
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
