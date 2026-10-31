// The view model across a process boundary. In Cardboard the Carton handle lives in the library worker (PLAN §3) and
// the components live in the renderer: the worker runs serveUi(fromCarton(carton, …), send) and the renderer reads
// remoteUi(send).ui. Messages are plain structured-clone data, so any channel carries them: Electron IPC, a
// MessagePort, a Worker's postMessage, a WebSocket (as JSON).
//
// Bandwidth stays small on purpose: small topics are sent whole when they change; History is sent once and then as
// deltas (the positions whose version object changed, found by identity), so a new version costs one row on the wire
// however long History is. Summaries are described only for the rows the renderer shows: it asks with "want".

import { TopicHub } from "./hub.ts";
import type {
  Actor,
  CartonUi,
  Conflict,
  Cut,
  Ghost,
  HistoryFilter,
  HistorySource,
  Peer,
  Preview,
  Published,
  SyncStatus,
  Topic,
  UndoTurn,
  Version,
} from "./model.ts";

type SmallTopic = Exclude<Topic, "history">;
const SMALL: readonly SmallTopic[] = ["sync", "cuts", "peers", "ghosts", "conflicts", "undo", "published", "preview"];

/** Async methods the client may call on the served view model. */
const METHODS = [
  "compare", "credits", "shotDiff", "planFold", "switchCut", "newCut", "renameCut", "fold",
  "resolve", "foldRest", "restore", "nameVersion", "undo", "publish", "openPreview", "blockEdit",
] as const;
type Method = (typeof METHODS)[number];

export type ServerMessage =
  | { t: "init"; me: Actor; actors: Actor[]; topics: Record<SmallTopic, unknown>; history: Version[]; can: { renameCut: boolean } }
  | { t: "topic"; topic: SmallTopic; value: unknown; actors?: Actor[] }
  | { t: "history"; length: number; rows: [number, Version][]; actors?: Actor[] }
  | { t: "ret"; id: number; ok: true; value: unknown }
  | { t: "ret"; id: number; ok: false; error: string };

export type ClientMessage =
  | { t: "hello" }
  | { t: "call"; id: number; method: Method; args: unknown[] }
  | { t: "want"; ids: string[] };

const read = (ui: CartonUi, t: SmallTopic): unknown =>
  t === "sync" ? ui.sync() : t === "cuts" ? ui.cuts() : t === "peers" ? ui.peers() : t === "ghosts" ? ui.ghosts() : t === "conflicts" ? ui.conflicts() : t === "undo" ? ui.undoTurn() : t === "published" ? ui.published() : ui.preview();

/** Every actor a value mentions, so the client can name subagents' agents. */
function actorsIn(value: unknown, out: Set<string>, list: Actor[], ui: CartonUi, depth = 0) {
  if (!value || typeof value !== "object" || depth > 4) return;
  if (Array.isArray(value)) {
    for (const v of value) actorsIn(v, out, list, ui, depth + 1);
    return;
  }
  const o = value as Record<string, unknown>;
  if (typeof o.key === "string" && typeof o.kind === "string" && typeof o.name === "string") {
    let a: Actor | undefined = o as unknown as Actor;
    while (a && !out.has(a.key)) {
      out.add(a.key);
      list.push(a);
      a = a.parent ? ui.actor(a.parent) : undefined;
    }
    return;
  }
  for (const v of Object.values(o)) if (v && typeof v === "object") actorsIn(v, out, list, ui, depth + 1);
}

/**
 * Serve a view model to one client. `send` posts a message to it; call `receive` with each message it sends back.
 * One server per client (each keeps what it has sent).
 */
export function serveUi(ui: CartonUi, send: (m: ServerMessage) => void): { receive(m: ClientMessage): void; close(): void } {
  const sentActors = new Set<string>();
  let sent: Version[] = [];
  let open = false;
  const offs: (() => void)[] = [];

  const newActors = (value: unknown): Actor[] | undefined => {
    const list: Actor[] = [];
    actorsIn(value, sentActors, list, ui);
    return list.length ? list : undefined;
  };
  const snapshot = (): readonly Version[] => {
    const h = ui.history();
    if (h.all) return h.all();
    const n = h.count("all"), out: Version[] = new Array(n);
    for (let i = 0; i < n; i++) out[n - 1 - i] = h.at("all", i)!;
    return out;
  };
  // Compare with what was sent, by identity, from the first row that can have changed: after an append that is the
  // tail only (HistorySource.firstChangedSince), so a new version costs O(rows after it), not O(History).
  let sentRev = -1;
  const pushHistory = () => {
    const h = ui.history();
    const length = h.count("all");
    let from = 0;
    let tail: readonly Version[];
    if (h.firstChangedSince && h.slice && sentRev >= 0) {
      // Read only from the first row that can have changed: an append copies the tail, never the whole History.
      from = Math.min(h.firstChangedSince(sentRev), length, sent.length);
      tail = h.slice(from);
    } else tail = snapshot();
    sentRev = h.revision();
    const rows: [number, Version][] = [];
    for (let k = 0; k < tail.length; k++) if (tail[k] !== sent[from + k]) rows.push([from + k, tail[k]!]);
    if (!rows.length && length === sent.length) return;
    for (const [i, v] of rows) sent[i] = v;
    sent.length = length;
    const actors = newActors(rows.map((r) => r[1]));
    send({ t: "history", length, rows, ...(actors ? { actors } : {}) });
  };

  const start = () => {
    if (open) return;
    open = true;
    const topics = {} as Record<SmallTopic, unknown>;
    for (const t of SMALL) topics[t] = read(ui, t);
    sent = snapshot().slice();
    sentRev = ui.history().revision();
    const actors: Actor[] = [];
    actorsIn([ui.me(), topics, sent], sentActors, actors, ui);
    send({ t: "init", me: ui.me(), actors, topics, history: sent, can: { renameCut: typeof ui.renameCut === "function" } });
    for (const t of SMALL)
      offs.push(
        ui.subscribe(t, () => {
          const value = read(ui, t);
          const a = newActors(value);
          send({ t: "topic", topic: t, value, ...(a ? { actors: a } : {}) });
        }),
      );
    offs.push(ui.subscribe("history", pushHistory));
  };

  return {
    receive(m) {
      if (m.t === "hello") {
        // A reload of the renderer starts over: send everything again.
        if (open) {
          for (const off of offs.splice(0)) off();
          open = false;
          sentActors.clear();
        }
        start();
      } else if (m.t === "want") ui.history().want?.(m.ids);
      else if (m.t === "call") {
        if (!(METHODS as readonly string[]).includes(m.method)) {
          send({ t: "ret", id: m.id, ok: false, error: `unknown method ${m.method}` });
          return;
        }
        const fn = (ui as unknown as Record<Method, (...a: unknown[]) => unknown>)[m.method];
        Promise.resolve()
          .then(() => fn.apply(ui, m.args))
          .then(
            (value) => send({ t: "ret", id: m.id, ok: true, value: value ?? null }),
            (e: unknown) => send({ t: "ret", id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) }),
          );
      }
    },
    close() {
      for (const off of offs.splice(0)) off();
      open = false;
    },
  };
}

/** The renderer side: a CartonUi that mirrors a served one. Send `{t:"hello"}` happens on creation. */
export function remoteUi(send: (m: ClientMessage) => void): { ui: CartonUi; receive(m: ServerMessage): void; ready: Promise<void> } {
  const hub = new TopicHub<Topic>();
  const actors = new Map<string, Actor>();
  const topics: Record<SmallTopic, unknown> = { sync: { kind: "local" }, cuts: [], peers: [], ghosts: [], conflicts: [], undo: null, published: null, preview: null };
  let me: Actor = { key: "human/unknown", kind: "human", name: "You", isYou: true };
  // Changed in place: memoized rows keep their objects, and the indexes are kept incrementally.
  let rows: Version[] = [];
  let named: number[] = [], turns: number[] = [];
  const pos = new Map<string, number>();
  let revision = 0;
  let nextId = 1;
  const calls = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
  let markReady!: () => void;
  const ready = new Promise<void>((r) => (markReady = r));

  /** Re-index rows[start..] (O(rows after start)): an append re-indexes the tail only. */
  const reindexFrom = (start: number) => {
    while (named.length && named[named.length - 1]! >= start) named.pop();
    while (turns.length && turns[turns.length - 1]! >= start) turns.pop();
    for (let i = start; i < rows.length; i++) {
      const v = rows[i]!;
      pos.set(v.id, i);
      if (v.name) named.push(i);
      if (v.kind === "turn") turns.push(i);
    }
    revision++;
  };

  // "want" for rows with no summary yet, batched per microtask.
  const wanted = new Set<string>();
  let wantScheduled = false;
  const want = (v: Version) => {
    if (v.summary || v.provisional || wanted.has(v.id)) return;
    wanted.add(v.id);
    if (wantScheduled) return;
    wantScheduled = true;
    queueMicrotask(() => {
      wantScheduled = false;
      const ids = [...wanted].filter((id) => !rows[pos.get(id) ?? -1]?.summary);
      if (ids.length) send({ t: "want", ids });
    });
  };

  const view = (f: HistoryFilter) => (f === "named" ? named : f === "turns" ? turns : null);
  const history: HistorySource = {
    all: () => rows,
    revision: () => revision,
    count: (f) => (f === "all" ? rows.length : view(f)!.length),
    at: (f, i) => {
      const vw = view(f);
      const len = vw ? vw.length : rows.length;
      if (i < 0 || i >= len) return undefined;
      const v = rows[vw ? vw[len - 1 - i]! : len - 1 - i];
      if (v) want(v);
      return v;
    },
    indexOf: (f, id) => {
      const p = pos.get(id);
      if (p === undefined) return -1;
      const vw = view(f);
      if (!vw) return rows.length - 1 - p;
      let lo = 0, hi = vw.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (vw[mid] === p) return vw.length - 1 - mid;
        if (vw[mid]! < p) lo = mid + 1;
        else hi = mid - 1;
      }
      return -1;
    },
    want: (ids) => send({ t: "want", ids: [...ids] }),
    slice: (from) => rows.slice(Math.max(0, from)),
  };

  const call = <T>(method: Method, ...args: unknown[]): Promise<T> =>
    new Promise<T>((ok, fail) => {
      const id = nextId++;
      calls.set(id, { ok: ok as (v: unknown) => void, fail });
      send({ t: "call", id, method, args });
    });
  const learn = (list?: Actor[]) => {
    if (list) for (const a of list) actors.set(a.key, a);
  };

  const ui: CartonUi = {
    subscribe: (t, fn) => hub.subscribe(t, fn),
    sync: () => topics.sync as SyncStatus,
    cuts: () => topics.cuts as readonly Cut[],
    history: () => history,
    peers: () => topics.peers as readonly Peer[],
    ghosts: () => topics.ghosts as readonly Ghost[],
    conflicts: () => topics.conflicts as readonly Conflict[],
    undoTurn: () => topics.undo as UndoTurn | null,
    published: () => topics.published as Published | null,
    preview: () => topics.preview as Preview | null,
    me: () => me,
    actor: (k) => actors.get(k),
    compare: (a, b) => call("compare", a, b),
    credits: (id) => call("credits", id),
    shotDiff: (a, b) => call("shotDiff", a, b),
    planFold: (f, i, o) => call("planFold", f, i, o),
    switchCut: (id) => call("switchCut", id),
    newCut: (n, r) => call("newCut", n, r),
    fold: (f, i, o) => call("fold", f, i, o),
    resolve: (id, c) => call("resolve", id, c),
    foldRest: (id) => call("foldRest", id),
    restore: (r) => call("restore", r),
    nameVersion: (id, n) => call("nameVersion", id, n),
    undo: (id) => call("undo", id),
    publish: (id) => call("publish", id),
    openPreview: (r, l) => void call("openPreview", r, l),
    blockEdit: () => void call("blockEdit"),
  };

  const receive = (m: ServerMessage) => {
    switch (m.t) {
      case "init":
        me = m.me;
        learn(m.actors);
        for (const t of SMALL) topics[t] = m.topics[t];
        rows = m.history;
        pos.clear();
        named = [];
        turns = [];
        reindexFrom(0);
        if (m.can.renameCut) ui.renameCut = (id, n) => call("renameCut", id, n);
        else delete ui.renameCut;
        for (const t of [...SMALL, "history" as const]) hub.notify(t);
        markReady();
        break;
      case "topic":
        learn(m.actors);
        topics[m.topic] = m.value;
        hub.notify(m.topic);
        break;
      case "history": {
        learn(m.actors);
        let from = Math.min(rows.length, m.length);
        // Rows past the new length are gone: forget their ids (unless the same id moved to a kept row).
        for (let i = m.length; i < rows.length; i++) if (pos.get(rows[i]!.id) === i) pos.delete(rows[i]!.id);
        rows.length = m.length;
        for (const [i, v] of m.rows) {
          const old = rows[i];
          if (old && old.id !== v.id && pos.get(old.id) === i) pos.delete(old.id);
          rows[i] = v;
          from = Math.min(from, i);
        }
        reindexFrom(from);
        hub.notify("history");
        break;
      }
      case "ret": {
        const c = calls.get(m.id);
        if (!c) break;
        calls.delete(m.id);
        if (m.ok) c.ok(m.value);
        else c.fail(new Error(m.error));
        break;
      }
    }
  };
  send({ t: "hello" });
  return { ui, receive, ready };
}
