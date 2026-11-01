// What the page and the media Service Worker say to each other, in a module of its own so the page bundle doesn't
// pull in the worker's code.

/** Page → worker: the session to read this project's media with. Sent at start, after each token refresh, and when
 * the worker asks. */
export interface SessionMessage {
  type: "carton-session";
  baseUrl: string;
  projectId: string;
  token: string;
}

/** Worker → page: "send me your session" (the worker restarted and forgot it), or "bytes of this media went to a
 * player before they failed verification" (reload it). */
export type WorkerMessage = { type: "carton-session-request" } | { type: "carton-media-bad"; hash: string };

/** The worker answers these paths; anything else goes to the network. */
export const MEDIA_PATH = /^\/media\/([0-9a-f]{64})$/;
