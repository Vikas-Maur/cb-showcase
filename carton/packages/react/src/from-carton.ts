// fromCarton(): the view model over a real Carton handle (@carton/core). Use it where the handle lives in the same
// process (the web client, Node, tests). In Cardboard the handle lives in the library worker: serve this view model
// from there with serveUi() and read it in the renderer with remoteUi() (remote.ts).
//
// What it does beyond renaming fields:
// - History is loaded once, kept oldest-first, and grows from the handle's events. Summaries are describe()'s first
//   line, computed lazily for the rows someone looks at (a 10k History never describes 10k versions).
// - A Director turn's versions become one checkpoint row with its edit count (§0.1: chat checkpoints are versions).
// - Pending commits show as provisional versions until confirmed (L5); the row keeps its id, so it doesn't remount.
// - Presence from sync events: peers per actor, idle after 30 s (§12), ghosts from drags.
// - Late conflicts addressed to you arrive as notices and become conflict cards.

import { actorKey, describe, groupOf, lcs, pathKey, shots as engineShots } from "@carton/core";
import type {
  Actor as CoreActor,
  Carton,
  CartonEvent,
  Choice,
  ConflictCard,
  CutRecord,
  Doc,
  Op,
  Rec,
  Schema,
  Shot as CoreShot,
  UndoEntry,
  Version as CoreVersion,
} from "@carton/core";
import { TopicHub } from "./hub.ts";
import type {
  Actor,
  CartonUi,
  Comparison,
  Conflict,
  ConflictChoice,
  Credits,
  Cut,
  FoldChange,
  FoldPlan,
  FoldResult,
  Ghost,
  HistoryFilter,
  HistorySource,
  Peer,
  Preview,
  Published,
  Shot,
  ShotDiff,
  SyncStatus,
  Topic,
  UndoTurn,
  Version,
  VersionKind,
} from "./model.ts";
import { diffSummary } from "./shots.ts";

export interface FromCartonOptions {
  /** The local person. The handle doesn't expose its actor, and "you" needs it. */
  me: CoreActor;
  /** Your undo group (§8). Default: `me.group`, else your actor key. */
  group?: string;
  /** Engine functions (default: @carton/core's). Tests may pass lighter ones. */
  engine?: { shots: typeof engineShots; lcs: typeof lcs; describe: typeof describe };
  /** Clip count and length of a state (Compare card). Default: the schema's timeline collection and end field. */
  measure?: (doc: Doc, schema: Schema) => { clips: number; length: number };
  /** The parts of a clip Credits lists, as record paths. Default: the whole clip, "Last change". */
  creditParts?: (itemId: string, schema: Schema) => { what: string; path: readonly string[] }[];
  /** A clip's display name for Credits. Default: the item id. */
  clipName?: (itemId: string) => string;
  /** Plain words for a card. Default: a generic description from the card's path and values. */
  describeCard?: (card: ConflictCard, schema: Schema) => { title: string; mine: string; theirs: string; reason?: string };
  /** "Keep both" for a card, as the host expresses it (Cardboard: a new track or `alternatives`); null: not offered. */
  keepBoth?: (card: ConflictCard) => Choice | null;
  /** The side a late conflict shows until picked. H5: head's value stays, so "theirs". */
  provisional?: ConflictChoice;
  /** The share link of a published cut. */
  shareUrl?: (cut: CutRecord) => string | undefined;
  /** Render a preview doc (§9 R2-16): called with the read-only doc, or null when the preview closes. */
  onPreview?: (p: { ref: string; label: string; doc: Readonly<Doc> } | null) => void;
  /** Versions loaded per log() call. */
  pageSize?: number;
  /** Describe at most this many versions at once (the rows on screen ask). */
  describeConcurrency?: number;
  /** Re-read the store every N ms (other processes may append). 0: only on events and refresh(). */
  pollMs?: number;
  clock?: () => number;
}

export interface CartonUiHandle extends CartonUi {
  readonly hub: TopicHub<Topic>;
  /** Re-read cuts, history tail, undo and published state (after another process wrote). */
  refresh(): Promise<void>;
  /** Show conflict cards a commit returned (the GUI's own commits), as late ones are shown. */
  reportConflicts(cards: readonly ConflictCard[], by?: CoreActor): void;
  /** Resolves when the first load finished. */
  readonly ready: Promise<void>;
  dispose(): void;
}

const IDLE_MS = 30_000;
const PENDING_PREFIX = "pending:";

/** Split a path key back into segments (`~1` → `/`, `~0` → `~`), the inverse of core's pathKey(). */
export function splitPathKey(key: string): string[] {
  return key.split("/").map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** A UI actor from a core actor. Keys follow core's actorKey(); a subagent's parent is its agent. */
export function toUiActor(a: CoreActor | null | undefined, me: CoreActor, myGroup: string): Actor {
  if (!a) return { key: "system/carton", kind: "system", name: "Carton" };
  const key = actorKey(a);
  const kind: Actor["kind"] = a.kind === "external" ? "agent" : a.kind;
  const isYou = key === actorKey(me) || (a.kind !== "human" && groupOf(a) === myGroup);
  const name = a.kind === "subagent" ? a.name ?? a.agentType ?? a.id : a.kind === "external" ? `${a.name ?? a.id} (terminal)` : a.name ?? a.id;
  const parent = a.kind === "subagent" ? actorKey({ kind: "agent", id: a.id }) : a.kind !== "human" && isYou ? actorKey(me) : undefined;
  return { key, kind, name, ...(parent ? { parent } : {}), ...(a.agentType ? { subagentType: a.agentType } : {}), ...(isYou ? { isYou } : {}) };
}

/** Ops that apply one side of a card at the head. The provisional side needs none. */
export function cardOps(card: ConflictCard, value: unknown): Op[] {
  if (card.kind === "compare" && card.ops) return [...card.ops];
  const path = splitPathKey(card.path);
  const last = path[path.length - 1] ?? "";
  if (last.startsWith("#") && value && typeof value === "object") {
    // A field group card ({field: value}) sets each field, as core's resolve() does with {value}.
    const parent = path.slice(0, -1);
    return Object.entries(value as Record<string, unknown>).map(([f, v]) => (v === undefined ? { op: "unset" as const, path: [...parent, f] } : { op: "set" as const, path: [...parent, f], value: v }));
  }
  if (path.length === 2) {
    // A whole record (delete vs edit, parent removed): take it, or remove it.
    if (value == null) return [{ op: "remove", path }];
    return [{ op: "remove", path }, { op: "insert", path, value }];
  }
  return [value === undefined ? { op: "unset", path } : { op: "set", path, value }];
}

const short = (v: unknown): string => {
  if (v === undefined || v === null) return "removed";
  if (typeof v === "string") return `“${v.length > 60 ? v.slice(0, 57) + "…" : v}”`;
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (typeof v === "object") {
    const e = Object.entries(v as Record<string, unknown>).filter(([, x]) => typeof x !== "object");
    return e.length ? e.slice(0, 3).map(([k, x]) => `${k} ${short(x)}`).join(", ") : "changed";
  }
  return String(v);
};

/** Generic plain words for a card: the record's label and each side's value. */
export function defaultDescribeCard(card: ConflictCard, schema: Schema): { title: string; mine: string; theirs: string; reason?: string } {
  const path = splitPathKey(card.path);
  const coll = schema.collections[path[0] ?? ""];
  const rec = (card.ours ?? card.theirs ?? card.base) as Rec | undefined;
  const label = coll ? (schema.label?.(path[0]!, path.length === 2 ? rec : undefined) ?? String(path[1])) : path[0] ?? card.path;
  const field = path.slice(2).join(" ").replace(/^#/, "");
  const title = coll ? `'${label}'${field ? ` ${field}` : ""}` : field || label;
  return { title, mine: short(card.ours), theirs: short(card.theirs), ...(card.reason ? { reason: card.reason } : {}) };
}

function defaultMeasure(doc: Doc, schema: Schema) {
  const tl = schema.timeline;
  if (!tl) return { clips: 0, length: 0 };
  const items = (doc[tl.collection] as Rec[] | undefined) ?? [];
  let end = 0;
  for (const it of items) end = Math.max(end, Number(it[tl.end]) || 0);
  return { clips: items.length, length: end };
}

const KIND: Record<string, VersionKind> = { edit: "edit", merge: "fold", revert: "undo", undo: "undo", "partial-revert": "fold", restore: "restore", rebalance: "edit", import: "import", external: "edit", root: "edit", fork: "edit" };

interface Row {
  core: CoreVersion | null;
  v: Version;
  /** The turn this version belongs to, for checkpoint grouping. */
  turnKey: string | null;
}

export function fromCarton(carton: Carton, opts: FromCartonOptions): CartonUiHandle {
  const hub = new TopicHub<Topic>();
  const clock = opts.clock ?? Date.now;
  const engine = opts.engine ?? { shots: engineShots, lcs, describe };
  const myGroup = opts.group ?? groupOf(opts.me);
  const schema = carton.schema;
  const actors = new Map<string, Actor>();
  const ui = (a: CoreActor | null | undefined): Actor => {
    const x = toUiActor(a, opts.me, myGroup);
    const known = actors.get(x.key);
    if (known && known.name === x.name && known.parent === x.parent) return known;
    actors.set(x.key, x);
    // A subagent's agent may never act itself: register it, so "Director › Explore" can be named.
    if (a?.kind === "subagent" && x.parent && !actors.has(x.parent)) actors.set(x.parent, { key: x.parent, kind: "agent", name: a.id === "director" ? "Director" : a.id, parent: actorKey(opts.me), isYou: x.isYou });
    return x;
  };
  const me = ui(opts.me);

  // ------------------------------------------------------------ history
  let cutId = carton.cut;
  let rows: Row[] = []; // oldest first
  let named: number[] = [], turns: number[] = [];
  const pos = new Map<string, number>();
  let revision = 0;
  let disposed = false;

  const reindex = () => {
    named = [];
    turns = [];
    pos.clear();
    rows.forEach((r, i) => {
      pos.set(r.v.id, i);
      if (r.v.name) named.push(i);
      if (r.v.kind === "turn") turns.push(i);
    });
    revision++;
  };

  const turnKeyOf = (a: CoreActor | null | undefined) => (a && a.kind !== "human" && a.turn ? `${a.chat ?? ""}/${a.turn}` : null);

  const toVersion = (c: CoreVersion, kindOverride?: VersionKind, turnEdits?: number): Version => {
    const id = c.change ?? `${c.ref.branchId}@${c.ref.seq}`;
    const prev = byId.get(id);
    const kind = kindOverride ?? KIND[c.kind] ?? "edit";
    const v: Version = {
      id,
      seq: c.ref.seq,
      ref: `${c.ref.branchId}@${c.ref.seq}`,
      at: c.at,
      author: ui(c.author),
      kind,
      summary: prev?.summary ?? (c.kind === "root" ? "Started the cut" : c.kind === "fork" ? "Made this cut" : ""),
      ...(prev?.details ? { details: prev.details } : {}),
      ...(c.name ? { name: c.name } : {}),
      ...(kind === "turn" ? { turn: { label: c.name ?? "", edits: turnEdits ?? 1 } } : {}),
    };
    return v;
  };
  // Summaries survive object replacement (a turn row growing, a rename).
  const byId = new Map<string, { summary: string; details?: readonly string[] }>();

  /** Rebuild the turn grouping of the newest rows after an append: only the last turn can change. */
  const regroupTail = () => {
    let i = rows.length - 1;
    while (i >= 0 && rows[i]!.v.provisional) i--;
    if (i < 0) return;
    const key = rows[i]!.turnKey;
    let j = i;
    if (key) while (j > 0 && rows[j - 1]!.turnKey === key) j--;
    for (let k = j; k <= i; k++) {
      const r = rows[k]!;
      if (!r.core) continue;
      const want: VersionKind = key && k === i ? "turn" : KIND[r.core.kind] ?? "edit";
      const edits = i - j + 1;
      if (r.v.kind !== want || (want === "turn" && r.v.turn?.edits !== edits)) r.v = toVersion(r.core, want, edits);
    }
  };

  const loadHistory = async () => {
    const page = opts.pageSize ?? 2000;
    const all: CoreVersion[] = [];
    let before: number | undefined;
    for (;;) {
      const got = await carton.log({ cut: cutId, limit: page, ...(before !== undefined ? { before } : {}) });
      all.push(...got);
      if (got.length < page) break;
      before = got[got.length - 1]!.ref.seq;
      if (before <= 0) break;
    }
    // A cut's History includes how it got there (as git log does): the versions of the cut it was made from, up to
    // the fork, and so on up the chain.
    let recs: CutRecord[] = [];
    try {
      recs = await carton.cuts();
    } catch {
      recs = [];
    }
    let fork = recs.find((c) => c.id === cutId)?.forkOf ?? null;
    for (let depth = 0; fork && depth < 8; depth++) {
      const at = fork.lastIndexOf("@");
      const parent = fork.slice(0, at), seq = Number(fork.slice(at + 1));
      if (!recs.some((c) => c.id === parent)) break;
      all.push(...(await carton.log({ cut: parent, before: seq + 1 })));
      fork = recs.find((c) => c.id === parent)?.forkOf ?? null;
    }
    all.reverse();
    const next: Row[] = [];
    let i = 0;
    while (i < all.length) {
      const key = turnKeyOf(all[i]!.author);
      let j = i;
      if (key) while (j + 1 < all.length && turnKeyOf(all[j + 1]!.author) === key) j++;
      for (let k = i; k <= j; k++) {
        const c = all[k]!;
        next.push({ core: c, turnKey: key, v: toVersion(c, key && k === j ? "turn" : undefined, j - i + 1) });
      }
      i = j + 1;
    }
    // Keep provisional rows still waiting.
    rows = [...next, ...rows.filter((r) => r.v.provisional && !next.some((n) => n.v.id === r.v.id))];
    reindex();
    hub.notify("history");
  };

  const appendConfirmed = (c: CoreVersion) => {
    const id = c.change ?? `${c.ref.branchId}@${c.ref.seq}`;
    if (rows.some((r) => r.core && r.v.id === id && r.core.ref.seq === c.ref.seq)) return;
    // A provisional row with this id becomes the confirmed one, in its confirmed place.
    rows = rows.filter((r) => !(r.v.provisional && r.v.id === id));
    const firstPending = rows.findIndex((r) => r.v.provisional);
    const row: Row = { core: c, turnKey: turnKeyOf(c.author), v: toVersion(c) };
    if (firstPending < 0) rows.push(row);
    else rows.splice(firstPending, 0, row);
    regroupTail();
    reindex();
    hub.notify("history");
  };

  // Lazy summaries: describe() only the versions a list shows, a few at a time.
  const queue: string[] = [];
  const queued = new Set<string>();
  let running = 0;
  const wantSummary = (v: Version) => {
    if (v.summary || v.provisional || queued.has(v.id) || byId.has(v.id)) return;
    queued.add(v.id);
    queue.push(v.id);
    pump();
  };
  const pump = () => {
    while (running < (opts.describeConcurrency ?? 2) && queue.length) {
      const id = queue.pop()!; // newest asks first: the top of the list is what people read
      running++;
      void summarize(id).finally(() => {
        running--;
        queued.delete(id);
        pump();
      });
    }
  };
  const summarize = async (id: string) => {
    const i = pos.get(id);
    const r = i === undefined ? undefined : rows[i];
    if (!r?.core || disposed) return;
    const seq = r.core.ref.seq;
    let lines: string[] = [];
    try {
      if (seq > 0) lines = (await carton.diff(`${r.core.ref.branchId}@${seq - 1}`, `${r.core.ref.branchId}@${seq}`)).describe;
    } catch {
      lines = [];
    }
    const summary = lines[0] ?? (r.v.kind === "fold" ? "Folded in" : r.v.kind === "undo" ? "Undid a change" : r.v.kind === "restore" ? "Restored a version" : "No visible change");
    byId.set(id, { summary, details: lines.slice(1) });
    const j = pos.get(id);
    if (j === undefined) return;
    const row = rows[j]!;
    row.v = { ...row.v, summary, ...(lines.length > 1 ? { details: lines.slice(1) } : {}) };
    revision++;
    hub.notify("history");
  };

  const view = (f: HistoryFilter) => (f === "named" ? named : f === "turns" ? turns : null);
  const history: HistorySource = {
    all: () => rows.map((r) => r.v),
    want: (ids) => {
      for (const id of ids) {
        const i = pos.get(id);
        if (i !== undefined) wantSummary(rows[i]!.v);
      }
    },
    revision: () => revision,
    count: (f) => (f === "all" ? rows.length : view(f)!.length),
    at: (f, i) => {
      const vw = view(f);
      const len = vw ? vw.length : rows.length;
      if (i < 0 || i >= len) return undefined;
      const r = rows[vw ? vw[len - 1 - i]! : len - 1 - i];
      if (r) wantSummary(r.v);
      return r?.v;
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
  };

  // ------------------------------------------------------------ cuts, published, undo
  let cuts: readonly Cut[] = [];
  let records: CutRecord[] = [];
  let published: Published | null = null;
  let undo: UndoTurn | null = null;
  const heads = new Map<string, number>();

  const ownerName = (owner: string) => actors.get(owner)?.name ?? owner;
  const refreshCuts = async () => {
    records = await carton.cuts();
    const visible = records.filter((c) => c.kind !== "published");
    const nameCount = new Map<string, number>();
    for (const c of visible) nameCount.set(c.name, (nameCount.get(c.name) ?? 0) + 1);
    const mine = new Set([opts.me.id, opts.me.name, actorKey(opts.me)].filter(Boolean) as string[]);
    const out: Cut[] = [];
    for (const c of visible) {
      const head = (await carton.log({ cut: c.id, limit: 1 }))[0];
      heads.set(c.id, head?.ref.seq ?? 0);
      const shared = (nameCount.get(c.name) ?? 0) > 1;
      const label = shared && !mine.has(c.owner) ? `${ownerName(c.owner)}'s ${c.name}` : c.name;
      const prev = cuts.find((x) => x.id === c.id);
      const next: Cut = {
        id: c.id,
        name: c.name,
        label,
        current: c.id === carton.cut,
        readOnly: !!c.tracking,
        kind: c.kind === "variant" ? "cut" : c.kind === "published" ? "cut" : c.kind,
        head: head ? `${c.id}@${head.ref.seq}` : `${c.id}@0`,
        updatedAt: head?.at ?? c.at ?? 0,
        shared: c.sequencer.kind !== "local",
      };
      out.push(prev && sameCut(prev, next) ? prev : next);
    }
    if (out.length !== cuts.length || out.some((c, i) => c !== cuts[i])) {
      cuts = out;
      hub.notify("cuts");
    }
    // Published cut: the newest cut of kind "published"; newer edits = versions on its source since.
    const pubs = records.filter((c) => c.kind === "published" && c.forkOf).sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
    const p = pubs[0];
    let next: Published | null = null;
    if (p) {
      const at = p.forkOf!.lastIndexOf("@");
      const src = p.forkOf!.slice(0, at), seq = Number(p.forkOf!.slice(at + 1));
      const srcCut = records.find((c) => c.id === src);
      const versionName = rows.find((r) => r.core?.ref.branchId === src && r.core.ref.seq === seq)?.v.name;
      const url = opts.shareUrl?.(p);
      next = { cutId: src, cutName: srcCut?.name ?? p.name, ref: p.forkOf!, at: p.at ?? 0, newerEdits: Math.max(0, (heads.get(src) ?? seq) - seq), ...(versionName ? { versionName } : {}), ...(url ? { url } : {}) };
    }
    if (!samePublished(published, next)) {
      published = next;
      hub.notify("published");
    }
  };

  const refreshUndo = async () => {
    let stack: UndoEntry[] = [];
    try {
      stack = await carton.undoStack(myGroup);
    } catch {
      stack = [];
    }
    const top = stack[0];
    let next: UndoTurn | null = null;
    if (top) {
      // An agent turn is undone as one (History.undo): count its entries.
      let edits = 1;
      if (top.author.turn) for (edits = 0; edits < stack.length && stack[edits]!.author.turn === top.author.turn; edits++);
      const label = top.label.replace(/^Undo\s+(?:[^:]+:\s*)?/, "");
      next = { id: top.changeId, author: ui(top.author), label, at: top.at, edits };
    }
    if (next?.id !== undo?.id || next?.edits !== undo?.edits || next?.label !== undo?.label) {
      undo = next;
      hub.notify("undo");
    }
  };

  // ------------------------------------------------------------ sync, presence, conflicts, preview
  let sync: SyncStatus = carton.sync ? mapSync(carton.sync.status, 0) : { kind: "local" };
  const peerMap = new Map<string, { peer: Peer; seen: number; ghosts: Ghost[] }>();
  let peers: readonly Peer[] = [];
  let ghosts: readonly Ghost[] = [];
  let conflicts: readonly Conflict[] = [];
  const cards = new Map<string, ConflictCard>();
  let preview: Preview | null = null;

  const publishPeers = () => {
    const next = [...peerMap.values()].map((x) => x.peer);
    if (next.length !== peers.length || next.some((p, i) => p !== peers[i])) {
      peers = next;
      hub.notify("peers");
    }
  };
  const publishGhosts = () => {
    ghosts = [...peerMap.values()].flatMap((x) => x.ghosts);
    hub.notify("ghosts");
  };
  const idleTimer = setInterval(() => {
    const now = clock();
    let changed = false;
    for (const x of peerMap.values()) {
      const idle = now - x.seen > IDLE_MS;
      if (idle !== x.peer.idle) {
        x.peer = { ...x.peer, idle };
        changed = true;
      }
    }
    if (changed) publishPeers();
  }, 5_000);
  (idleTimer as { unref?: () => void }).unref?.();

  const addCards = (list: readonly ConflictCard[], by?: CoreActor) => {
    const describeCard = opts.describeCard ?? defaultDescribeCard;
    const next = [...conflicts];
    for (const card of list) {
      if (cards.has(card.path)) continue;
      cards.set(card.path, card);
      const w = describeCard(card, schema);
      next.unshift({
        id: card.path,
        title: w.title,
        mine: { author: me, summary: w.mine },
        theirs: { author: by ? ui(by) : { key: "system/someone", kind: "human", name: "Someone" }, summary: w.theirs },
        canKeepBoth: !!opts.keepBoth?.(card),
        ...(w.reason ? { reason: w.reason } : {}),
        provisional: opts.provisional ?? "theirs",
      });
    }
    if (next.length !== conflicts.length) {
      conflicts = next;
      hub.notify("conflicts");
    }
  };

  const onEvent = (e: CartonEvent) => {
    if (disposed) return;
    switch (e.type) {
      case "change": {
        if (e.branchId !== cutId) {
          void refreshCuts();
          break;
        }
        const c = e.change;
        appendConfirmed({ ref: { branchId: e.branchId, seq: e.seq, pending: [] }, hash: "", change: c.id, author: c.author, at: c.at, kind: c.kind ?? (c.mergeOf ? "merge" : "edit"), ...(c.name ? { name: c.name } : {}) });
        heads.set(e.branchId, e.seq);
        scheduleRefresh();
        break;
      }
      case "pending": {
        if (e.branchId !== cutId || pos.has(e.id)) break;
        rows.push({ core: null, turnKey: null, v: { id: e.id, seq: null, ref: `${PENDING_PREFIX}${e.id}`, at: clock(), author: me, kind: "edit", summary: "Your edit", provisional: true } });
        reindex();
        hub.notify("history");
        break;
      }
      case "sync": {
        const next = mapSync(e.status, e.waiting);
        if (next.kind !== sync.kind || ("waiting" in next && "waiting" in sync && next.waiting !== sync.waiting)) {
          sync = next;
          hub.notify("sync");
        }
        break;
      }
      case "presence": {
        const key = actorKey(e.actor);
        if (key === actorKey(opts.me)) break;
        const state = e.state as { ghosts?: { item: string; track: string; start: number; end: number; label?: string }[]; activity?: string } | null;
        if (!state) {
          if (peerMap.delete(key)) {
            publishPeers();
            publishGhosts();
          }
          break;
        }
        const prev = peerMap.get(key);
        const actor = ui(e.actor);
        const activity = typeof state.activity === "string" ? state.activity : undefined;
        const peer = prev && prev.peer.actor === actor && !prev.peer.idle && prev.peer.activity === activity ? prev.peer : { actor, cutId, idle: false, ...(activity ? { activity } : {}) };
        const g = (state.ghosts ?? []).map((x) => ({ actorKey: key, itemId: x.item, trackId: x.track, start: x.start, end: x.end, ...(x.label ? { label: x.label } : {}) }));
        peerMap.set(key, { peer, seen: clock(), ghosts: g });
        if (peer !== prev?.peer) publishPeers();
        if (g.length || prev?.ghosts.length) publishGhosts();
        break;
      }
      case "notice": {
        const n = e.notice;
        if ((n.to === actorKey(opts.me) || n.to === myGroup) && n.cards?.length) addCards(n.cards, n.by);
        break;
      }
      default:
        break;
    }
  };
  const off = carton.on(onEvent);

  // Refreshing cuts and undo after a burst of changes: once, after it settles.
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleRefresh = () => {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refreshCuts();
      void refreshUndo();
    }, 50);
  };

  const refresh = async () => {
    if (carton.cut !== cutId) cutId = carton.cut;
    await loadHistory();
    await refreshCuts();
    await refreshUndo();
  };
  const ready = refresh();
  const poll = opts.pollMs ? setInterval(() => void refresh(), opts.pollMs) : null;
  (poll as { unref?: () => void } | null)?.unref?.();

  // ------------------------------------------------------------ reads
  const versionAt = (ref: string) => rows.find((r) => r.v.ref === ref)?.v;
  const diffCache = new Map<string, Promise<ShotDiff>>();
  const shotDiff = (a: string, b: string): Promise<ShotDiff> => {
    const key = `${a}|${b}`;
    let p = diffCache.get(key);
    if (!p) {
      p = (async () => {
        const [da, db] = await Promise.all([carton.checkout(a), carton.checkout(b)]);
        const intern = new Map<string, number>();
        const A = engine.shots(da, schema, intern), B = engine.shots(db, schema, intern);
        const matches = engine.lcs(A.map((s) => s.sig), B.map((s) => s.sig));
        const label = (doc: Doc) => (s: CoreShot): Shot => ({ start: s.start, end: s.end, sig: s.sig, ...(topLabel(doc, s) ? { label: topLabel(doc, s)! } : {}) });
        return {
          a: A.map(label(da)),
          b: B.map(label(db)),
          matches,
          aLabel: versionAt(a)?.name ?? a,
          bLabel: versionAt(b)?.name ?? (cuts.find((c) => c.head === b) ? "Current" : b),
        };
      })();
      diffCache.set(key, p);
      // Keep a few: Compare and Watch the changes ask for the same pair.
      if (diffCache.size > 4) diffCache.delete(diffCache.keys().next().value!);
      p.catch(() => diffCache.delete(key));
    }
    return p;
  };
  // The name of the topmost clip that starts at or before the shot's start: what an editor calls the shot.
  const topLabel = (doc: Doc, s: CoreShot): string | undefined => {
    const tl = schema.timeline;
    if (!tl) return undefined;
    const items = (doc[tl.collection] as Rec[] | undefined) ?? [];
    let best: Rec | undefined;
    for (const it of items) {
      const st = Number(it[tl.start]), en = Number(it[tl.end]);
      if (st <= s.start + 1e-6 && en >= s.end - 1e-6) best = it;
    }
    return best ? (schema.label?.(tl.collection, best) ?? (typeof best.name === "string" ? best.name : undefined)) : undefined;
  };

  const handle: CartonUiHandle = {
    hub,
    ready,
    subscribe: (topic, fn) => hub.subscribe(topic, fn),
    sync: () => sync,
    cuts: () => cuts,
    history: () => history,
    peers: () => peers,
    ghosts: () => ghosts,
    conflicts: () => conflicts,
    undoTurn: () => undo,
    published: () => published,
    preview: () => preview,
    me: () => me,
    actor: (key) => actors.get(key),

    async compare(a, b) {
      const [d, da, db] = await Promise.all([shotDiff(a, b), carton.checkout(a), carton.checkout(b)]);
      const measure = opts.measure ?? defaultMeasure;
      const side = (ref: string, doc: Doc, label: string) => {
        const v = versionAt(ref);
        const m = measure(doc, schema);
        return { label: v?.name ?? label, ref, at: v?.at ?? clock(), author: v?.author ?? me, clipCount: m.clips, length: m.length };
      };
      const c: Comparison = { a: side(a, da, d.aLabel), b: side(b, db, d.bLabel), diff: diffSummary(d) };
      return c;
    },

    async credits(itemId) {
      const tl = schema.timeline;
      const parts = opts.creditParts?.(itemId, schema) ?? [{ what: "Last change", path: [tl?.collection ?? "items", itemId] }];
      const lines = [];
      for (const p of parts) {
        const a = await carton.credits(p.path);
        if (a) lines.push({ what: p.what, author: ui(a) });
      }
      const c: Credits = { clip: opts.clipName?.(itemId) ?? itemId, lines };
      return c;
    },

    shotDiff,

    async planFold(fromId, intoId, o) {
      const from = cuts.find((c) => c.id === fromId) ?? fallbackCut(fromId), into = cuts.find((c) => c.id === intoId) ?? fallbackCut(intoId);
      const r = await carton.fold(fromId, { into: intoId, check: true, ...(o?.allCards ? { missingBase: "all-cards" as const } : {}) });
      const base = { from, into, changes: [] as FoldChange[], conflicts: [] as Conflict[], warnings: [] as string[] };
      if (r.status === "up-to-date") return base;
      if (r.status === "missing-base") return { ...base, missingBase: r.dialog.text };
      if (r.status === "rejected") throw new Error(r.reason);
      const cardList: ConflictCard[] = r.status === "conflicts" || r.status === "compare" ? r.cards : [];
      const describeCard = opts.describeCard ?? defaultDescribeCard;
      const fromHead = (await carton.log({ cut: fromId, limit: 1 }))[0];
      const cardsOut: Conflict[] = cardList.map((card) => {
        const w = describeCard(card, schema);
        return {
          id: card.path,
          title: w.title,
          mine: { author: me, summary: w.mine },
          theirs: { author: ui(fromHead?.author), summary: w.theirs },
          canKeepBoth: !!opts.keepBoth?.(card),
          ...(w.reason ? { reason: w.reason } : {}),
          provisional: "mine",
        };
      });
      const preview = r.preview;
      if (!preview) return { ...base, conflicts: cardsOut, partial: false };
      // One row per record the fold touches, so leaving one out (partial accept) is keyed by its record path.
      const intoDoc = (await carton.head(intoId)).doc;
      const groups = new Map<string, Op[]>();
      for (const op of preview.ops) {
        if (op.op === "remap") continue;
        const p = op.path;
        const key = schema.collections[String(p[0])] ? pathKey(p.slice(0, 2)) : pathKey(p.slice(0, 1));
        let g = groups.get(key);
        if (!g) groups.set(key, (g = []));
        g.push(op);
      }
      const changes: FoldChange[] = [];
      for (const [key, ops] of groups) {
        const words = engine.describe(ops, intoDoc, schema);
        const who = schema.collections[splitPathKey(key)[0]!] ? await carton.credits(splitPathKey(key), { cut: fromId }) : fromHead?.author ?? null;
        changes.push({ id: key, summary: words.join("; ") || key, author: ui(who), at: fromHead?.at ?? clock() });
      }
      // A remap (ripple) can't be left out on its own: it moves many records at once.
      const hasRemap = preview.ops.some((op) => op.op === "remap");
      return {
        ...base,
        changes,
        conflicts: cardsOut,
        warnings: preview.warnings.map((w) => String((w as { text?: unknown }).text ?? w.kind)),
        ...(hasRemap ? { partial: false } : {}),
      };
    },

    async switchCut(id) {
      await carton.switchTo(id);
      cutId = id;
      rows = [];
      reindex();
      hub.notify("history");
      await refresh();
    },
    async newCut(name, fromRef) {
      const rec = await carton.fork(name, { from: fromRef });
      await handle.switchCut(rec.id);
      return cuts.find((c) => c.id === rec.id) ?? fallbackCut(rec.id);
    },
    async renameCut(id, name) {
      // Not in core's contract yet: use it when the handle has it.
      const rename = (carton as unknown as { renameCut?: (cut: string, name: string) => Promise<void> }).renameCut;
      if (!rename) throw new Error("Renaming a cut isn't available yet");
      await rename.call(carton, id, name);
      await refreshCuts();
    },
    async fold(fromId, intoId, o) {
      const choices: Record<string, Choice> = {};
      for (const [path, ch] of Object.entries(o.choices)) choices[path] = ch === "mine" ? "ours" : ch === "theirs" ? "theirs" : opts.keepBoth?.(cardsFor(path)) ?? "ours";
      const common = { into: intoId, choices, ...(o.allCards ? { missingBase: "all-cards" as const } : {}) };
      const r = o.leaveOut.length ? await carton.foldSome(fromId, { ...common, reject: [...o.leaveOut] }) : await carton.fold(fromId, common);
      await refresh();
      if (r.status === "confirmed" || r.status === "pending" || r.status === "up-to-date") return { ok: true };
      if (r.status === "rejected") return { ok: false, error: r.reason };
      if (r.status === "missing-base") return { ok: false, error: r.dialog.text };
      // New cards (someone folded or edited meanwhile): show them, nothing is decided for the person.
      const describeCard = opts.describeCard ?? defaultDescribeCard;
      const fresh: Conflict[] = r.cards.map((card) => {
        const w = describeCard(card, schema);
        return { id: card.path, title: w.title, mine: { author: me, summary: w.mine }, theirs: { author: me, summary: w.theirs }, canKeepBoth: !!opts.keepBoth?.(card), ...(w.reason ? { reason: w.reason } : {}), provisional: "mine" };
      });
      return { ok: false, conflicts: fresh };
    },
    async resolve(id, choice) {
      const card = cards.get(id);
      const shown = conflicts.find((c) => c.id === id)?.provisional ?? "theirs";
      if (card && choice !== shown) {
        const value = choice === "mine" ? card.ours : choice === "theirs" ? card.theirs : opts.keepBoth?.(card);
        const v = typeof value === "object" && value && "value" in (value as object) && choice === "both" ? (value as { value: unknown }).value : value;
        const r = await carton.commit({ ops: cardOps(card, v), author: opts.me });
        if (r.status === "rejected") throw new Error(r.reason);
      }
      cards.delete(id);
      conflicts = conflicts.filter((c) => c.id !== id);
      hub.notify("conflicts");
    },
    async restore(ref) {
      await carton.restore(ref, { author: opts.me });
    },
    async nameVersion(id, name) {
      const i = pos.get(id);
      const r = i === undefined ? undefined : rows[i];
      if (!r?.core) return;
      await carton.name(r.v.ref, name);
      r.core = { ...r.core, name };
      r.v = { ...r.v, name, ...(r.v.turn ? { turn: { ...r.v.turn, label: name } } : {}) };
      reindex();
      hub.notify("history");
    },
    async undo(turnId) {
      if (undo?.id !== turnId) return { ok: false, error: "Something changed. Try again." };
      const r = await carton.undo(myGroup);
      await refreshUndo();
      if (r.status === "confirmed" || r.status === "pending") return { ok: true };
      if (r.status === "conflicts") {
        addCards(r.cards);
        return { ok: false, conflicts };
      }
      return { ok: false, error: r.status === "rejected" ? r.reason : "Couldn't undo" };
    },
    async publish(id) {
      const src = cuts.find((c) => c.id === id);
      await carton.fork(`${src?.name ?? "Cut"} (published)`, { from: src?.head ?? id, kind: "published" });
      await refreshCuts();
    },
    openPreview(ref, label) {
      preview = ref ? { ref, label: label ?? ref } : null;
      hub.notify("preview");
      if (!opts.onPreview) return;
      if (!ref) opts.onPreview(null);
      else void carton.preview(ref).then((p) => preview?.ref === ref && opts.onPreview!({ ref, label: label ?? ref, doc: p.doc }));
    },

    blockEdit() {
      if (!preview || preview.blockedEdit) return;
      preview = { ...preview, blockedEdit: true };
      hub.notify("preview");
    },

    refresh,
    reportConflicts: (list, by) => addCards(list, by),
    dispose() {
      disposed = true;
      off();
      clearInterval(idleTimer);
      if (poll) clearInterval(poll);
      if (refreshTimer) clearTimeout(refreshTimer);
    },
  };

  const cardsFor = (path: string): ConflictCard => cards.get(path) ?? { kind: "field", path, base: undefined, ours: undefined, theirs: undefined };
  const fallbackCut = (id: string): Cut => ({ id, name: id, label: id, current: id === carton.cut, readOnly: false, kind: "cut", head: `${id}@0`, updatedAt: 0 });
  return handle;
}

function mapSync(status: string, waiting: number): SyncStatus {
  if (status === "offline" || status === "stopped") return { kind: "offline", waiting };
  if (status === "up-to-date" && waiting === 0) return { kind: "upToDate" };
  return { kind: "syncing", waiting };
}

function sameCut(a: Cut, b: Cut): boolean {
  return a.name === b.name && a.label === b.label && a.current === b.current && a.readOnly === b.readOnly && a.kind === b.kind && a.head === b.head && a.updatedAt === b.updatedAt && a.shared === b.shared;
}

function samePublished(a: Published | null, b: Published | null): boolean {
  if (!a || !b) return a === b;
  return a.cutId === b.cutId && a.ref === b.ref && a.newerEdits === b.newerEdits && a.versionName === b.versionName && a.at === b.at && a.url === b.url;
}
