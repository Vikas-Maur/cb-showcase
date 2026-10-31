// What the host refused, for the sync status. A host can refuse this client outright at `hello` (an older host than the
// document's schema: "…update the server", H-SV), and then nothing syncs: without this the editor would just sit at
// "Syncing". Carton doesn't pass the sync client's `error` events on (request REQ-8 to foundation-core), so the app
// watches the messages of the transport it gives Carton: a host `error` sets the problem, a later welcome or ack clears it.

import type { Transport, TransportConnection } from "@carton/core/plugins";

export interface HostProblems {
  readonly transport: Transport;
  /** The host's last refusal, or null once it answered again. */
  current(): string | null;
  subscribe(l: (problem: string | null) => void): () => void;
}

export function watchHostErrors(inner: Transport): HostProblems {
  let problem: string | null = null;
  const listeners = new Set<(p: string | null) => void>();
  const set = (p: string | null) => {
    if (p === problem) return;
    problem = p;
    for (const l of listeners) l(p);
  };
  const transport: Transport = {
    async connect(url, opts): Promise<TransportConnection> {
      const conn = await inner.connect(url, opts);
      conn.onMessage((m) => {
        const msg = m as { type: string; reason?: unknown };
        if (msg.type === "error") set(typeof msg.reason === "string" ? msg.reason : "the server refused this client");
        // a welcome (it answered a hello) or an ack (it took an edit) means the cut syncs again; other replies don't
        // (a history answer still comes after a refused hello)
        else if (msg.type === "hello" || msg.type === "ack") set(null);
      });
      return conn;
    },
  };
  return {
    transport,
    current: () => problem,
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

/** The words for the sync status: what's wrong and what to do, from the host's reason. */
export function problemWords(reason: string): string {
  return /update the server|newer than this server/i.test(reason) ? `Can't sync: this project needs a newer server (${reason})` : `Can't sync: ${reason}`;
}
