// An in-process SequencerHost and its Transport, for tests and single-process setups: the same sequencer core a real
// host runs, with messages structured-cloned and delivered on the microtask queue, in order, at most once. A test can
// drop a connection (`host.drop`) to exercise reconnects and lost acks.

import type { AuthProvider, BlobStore, SequencerHost, SequencerStorage, Transport, TransportConnection } from "@carton/core/plugins";
import type { sync } from "@carton/core";
import { createSequencer, type ConnectionState, type HostConnection, type Sequencer, type SequencerOptions } from "./sequencer.ts";

export interface InProcessHost extends SequencerHost {
  readonly sequencer: Sequencer;
  readonly transport: Transport;
  /** Break one connection, or every connection, as a dropped link would: both sides see it close. */
  drop(connId?: string): void;
  readonly connections: number;
}

let hosts = 0;

export function createInProcessHost(opts: Omit<SequencerOptions, "storage" | "auth"> & { storage: SequencerStorage; auth: AuthProvider; blobs?: BlobStore; name?: string }): InProcessHost {
  const url = `inproc://${opts.name ?? `host-${++hosts}`}`;
  const sequencer = createSequencer(opts);
  const live = new Map<string, { server: HostConnection; client: ClientSide }>();
  let closed = false;
  let n = 0;

  interface ClientSide {
    open: boolean;
    listeners: ((m: sync.ServerMessage) => void)[];
    closers: ((why: string) => void)[];
  }

  function shut(id: string, why: string) {
    const pair = live.get(id);
    if (!pair) return;
    live.delete(id);
    sequencer.disconnect(pair.server);
    if (!pair.client.open) return;
    pair.client.open = false;
    queueMicrotask(() => {
      for (const f of pair.client.closers.splice(0)) f(why);
    });
  }

  const transport: Transport = {
    async connect(target, { token, signal }) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      if (closed || target !== url) throw new Error(`no host at ${target}`);
      const auth = await opts.auth.verify(token);
      if (!auth) throw new Error("unauthorized");
      const id = `${url}#${++n}`;
      const client: ClientSide = { open: true, listeners: [], closers: [] };
      const state: ConnectionState = { subs: [], deadEpoch: -1 };
      const server: HostConnection = {
        id,
        auth,
        state,
        send(msg) {
          if (!client.open) return;
          const copy = structuredClone(msg);
          queueMicrotask(() => {
            if (client.open) for (const f of client.listeners) f(copy);
          });
        },
      };
      live.set(id, { server, client });
      sequencer.attach(server);
      const conn: TransportConnection = {
        get open() {
          return client.open;
        },
        send(msg) {
          if (!client.open) return;
          const copy = structuredClone(msg);
          queueMicrotask(() => {
            if (live.has(id)) void sequencer.handle(server, copy);
          });
        },
        onMessage(f) {
          client.listeners.push(f);
        },
        onClose(f) {
          client.closers.push(f);
        },
        close() {
          shut(id, "closed");
        },
      };
      return conn;
    },
  };

  return {
    kind: "in-process",
    url,
    sequencer,
    transport,
    drop(connId) {
      for (const id of connId ? [connId] : [...live.keys()]) shut(id, "dropped");
    },
    get connections() {
      return live.size;
    },
    async close() {
      closed = true;
      for (const id of [...live.keys()]) shut(id, "host closed");
    },
  };
}
