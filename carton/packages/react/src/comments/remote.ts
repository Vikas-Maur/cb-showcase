// The comments view model across a process boundary, like serveUi/remoteUi (remote.ts): in Cardboard the Carton and
// its Comments live in the library worker, the panel in the renderer. The worker runs
// `serveComments(commentsUi(comments, …), send)`, the renderer reads `remoteComments(send).ui`. Messages are plain
// structured-clone data (Electron IPC, a MessagePort, a WebSocket as JSON).
//
// Threads go once, then as deltas: the order of ids and only the threads whose view object changed (by identity), so
// a new reply costs one thread on the wire however many threads there are. The renderer keeps every other thread's
// object, so its list re-renders only what changed.

import type { CommentPerson, CommentsStatus, CommentsUi, ThreadView } from "./model.ts";

const METHODS = ["add", "reply", "edit", "resolve", "remove", "dismissNotice"] as const;
type Method = (typeof METHODS)[number];

export type CommentsServerMessage =
  | { t: "c-init"; me: CommentPerson; can: boolean; status: CommentsStatus; notice: string | null; threads: ThreadView[] }
  | { t: "c-threads"; order: string[]; changed: ThreadView[] }
  | { t: "c-state"; me: CommentPerson; can: boolean; status: CommentsStatus; notice: string | null }
  | { t: "c-ret"; id: number; ok: true }
  | { t: "c-ret"; id: number; ok: false; error: string };

export type CommentsClientMessage = { t: "c-hello" } | { t: "c-call"; id: number; method: Method; args: unknown[] };

/** Serve a comments view model to one client. Call `receive` with the client's messages; `close` stops it. */
export function serveComments(ui: CommentsUi, send: (m: CommentsServerMessage) => void): { receive(m: CommentsClientMessage): void; close(): void } {
  let sent = new Map<string, ThreadView>();
  let state = { me: ui.me(), can: ui.canComment(), status: ui.status(), notice: ui.notice() };
  let live = false;
  const push = () => {
    if (!live) return;
    const threads = ui.threads();
    const changed: ThreadView[] = [];
    const next = new Map<string, ThreadView>();
    for (const t of threads) {
      next.set(t.id, t);
      if (sent.get(t.id) !== t) changed.push(t);
    }
    const before = [...sent.keys()];
    if (changed.length || next.size !== sent.size || threads.some((t, i) => before[i] !== t.id)) send({ t: "c-threads", order: threads.map((t) => t.id), changed });
    sent = next;
    const s = { me: ui.me(), can: ui.canComment(), status: ui.status(), notice: ui.notice() };
    if (s.me.id !== state.me.id || s.me.name !== state.me.name || s.can !== state.can || s.status !== state.status || s.notice !== state.notice) {
      state = s;
      send({ t: "c-state", ...s });
    }
  };
  const off = ui.subscribe(push);
  return {
    receive(m) {
      if (m.t === "c-hello") {
        live = true;
        const threads = ui.threads();
        sent = new Map(threads.map((t) => [t.id, t]));
        state = { me: ui.me(), can: ui.canComment(), status: ui.status(), notice: ui.notice() };
        send({ t: "c-init", ...state, threads: [...threads] });
        return;
      }
      if (m.t === "c-call") {
        if (!(METHODS as readonly string[]).includes(m.method)) return send({ t: "c-ret", id: m.id, ok: false, error: `no method ${m.method}` });
        Promise.resolve()
          .then(() => (ui[m.method] as (...a: unknown[]) => unknown)(...m.args))
          .then(
            () => send({ t: "c-ret", id: m.id, ok: true }),
            (e: unknown) => send({ t: "c-ret", id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) }),
          );
      }
    },
    close() {
      live = false;
      off();
    },
  };
}

/** The renderer's side: a CommentsUi mirroring the served one. Call `receive` with the server's messages. */
export function remoteComments(send: (m: CommentsClientMessage) => void): { ui: CommentsUi; receive(m: CommentsServerMessage): void; ready: Promise<void> } {
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());
  let byId = new Map<string, ThreadView>();
  let threads: readonly ThreadView[] = [];
  let me: CommentPerson = { id: "", name: "" };
  let can = false;
  let status: CommentsStatus = { state: "connecting", waiting: 0 };
  let notice: string | null = null;
  let n = 0;
  const calls = new Map<number, { ok: () => void; fail: (e: Error) => void }>();
  let ready!: () => void;
  const readyP = new Promise<void>((r) => (ready = r));
  const call = (method: Method, ...args: unknown[]) =>
    new Promise<void>((ok, fail) => {
      const id = ++n;
      calls.set(id, { ok, fail });
      send({ t: "c-call", id, method, args });
    });
  send({ t: "c-hello" });
  const ui: CommentsUi = {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    threads: () => threads,
    me: () => me,
    canComment: () => can,
    status: () => status,
    notice: () => notice,
    dismissNotice: () => void call("dismissNotice"),
    add: (body, range) => call("add", body, range),
    reply: (threadId, body) => call("reply", threadId, body),
    edit: (id, body) => call("edit", id, body),
    resolve: (threadId, resolved) => call("resolve", threadId, resolved),
    remove: (id) => call("remove", id),
  };
  return {
    ui,
    ready: readyP,
    receive(m) {
      if (m.t === "c-init") {
        ({ me, can, status, notice } = m);
        byId = new Map(m.threads.map((t) => [t.id, t]));
        threads = m.threads;
        ready();
        notify();
      } else if (m.t === "c-threads") {
        for (const t of m.changed) byId.set(t.id, t);
        const next = m.order.map((id) => byId.get(id)!).filter(Boolean);
        byId = new Map(next.map((t) => [t.id, t]));
        threads = next;
        notify();
      } else if (m.t === "c-state") {
        ({ me, can, status, notice } = m);
        notify();
      } else if (m.t === "c-ret") {
        const c = calls.get(m.id);
        calls.delete(m.id);
        if (m.ok) c?.ok();
        else c?.fail(new Error(m.error));
      }
    },
  };
}
