// `commentsUi()`: the comments view model over a `@carton/comments` handle (structurally: @carton/react takes no
// dependency on it). Threads are placed on the version shown whenever comments change or the document moves on
// (`versions`: a Carton's `on`), one placement run at a time, time-sliced so a big project never blocks a frame, and
// incremental in @carton/comments itself. View objects keep their identity while their comment, its pending flag and
// its placement stay the same.

import type { CommentPerson, CommentView, CommentsStatus, CommentsSyncState, CommentsUi, ThreadPlacement, ThreadView } from "./model.ts";

/** A comment as `@carton/comments` gives it. */
export interface SourceComment {
  readonly id: string;
  readonly replyTo?: string;
  readonly author: CommentPerson;
  readonly body: string;
  readonly anchor?: { readonly cut: string; readonly seq: number };
  readonly at: number;
  readonly editedAt?: number;
  readonly resolved?: { readonly by: CommentPerson; readonly at: number };
  readonly deleted?: true;
}

/** What `commentsUi` needs of a `@carton/comments` `Comments` handle. */
export interface CommentsSource {
  threads(): readonly { readonly root: SourceComment; readonly replies: readonly SourceComment[] }[];
  isPending(id: string): boolean;
  me(): CommentPerson;
  syncStatus(): { readonly state: string; readonly error?: string } | null;
  on(listener: (e: { type: string; reason?: string; refused?: string }) => void): () => void;
  add(input: { body: string; range?: readonly [number, number] }): Promise<unknown>;
  reply(threadId: string, body: string): Promise<unknown>;
  edit(id: string, body: string): Promise<unknown>;
  resolve(id: string, resolved?: boolean): Promise<unknown>;
  remove(id: string): Promise<unknown>;
  placements(opts?: { budgetMs?: number }): Promise<ReadonlyMap<string, ThreadPlacement>>;
}

export interface CommentsUiOptions {
  /** Something that says when the version shown changed (a Carton: `carton.on`); threads are placed again then. */
  versions?: { on(listener: () => void): () => void };
  /** May this session comment (its role)? Default: yes. */
  canComment?: () => boolean;
  /** Time slice for placing threads (ms, default 8). */
  budgetMs?: number;
  /** Words for refusals ("viewers can read comments but not write them" comes from the server as is). */
  refusedWords?: (reason: string) => string;
}

export type CommentsUiHandle = CommentsUi & { close(): void; /** Placed after the latest change (tests). */ settled(): Promise<void> };

const SYNC_STATES: ReadonlySet<string> = new Set(["offline", "connecting", "catching-up", "up-to-date", "unsupported", "stopped"]);

export function commentsUi(source: CommentsSource, opts: CommentsUiOptions = {}): CommentsUiHandle {
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const l of [...listeners]) l();
  };
  let threads: readonly ThreadView[] = [];
  let status: CommentsStatus = { state: "local", waiting: 0 };
  let notice: string | null = null;
  let placements: ReadonlyMap<string, ThreadPlacement> = new Map();
  const views = new WeakMap<SourceComment, { pending: boolean; mine: boolean; view: CommentView }>();
  const threadCache = new Map<string, { root: SourceComment; replies: readonly CommentView[]; placement: ThreadPlacement | null; rootView: CommentView; view: ThreadView }>();
  let closed = false;

  const viewOf = (c: SourceComment, meId: string): CommentView => {
    const pending = source.isPending(c.id);
    const mine = c.author.id === meId;
    const v = views.get(c);
    if (v && v.pending === pending && v.mine === mine) return v.view;
    const view: CommentView = {
      id: c.id,
      author: c.author,
      body: c.body,
      at: c.at,
      ...(c.editedAt !== undefined ? { editedAt: c.editedAt } : {}),
      ...(c.deleted ? { deleted: true } : {}),
      ...(pending ? { pending: true } : {}),
      mine,
    };
    views.set(c, { pending, mine, view });
    return view;
  };

  const rebuild = () => {
    const meId = source.me().id;
    const out: ThreadView[] = [];
    const seen = new Set<string>();
    let waiting = 0;
    for (const t of source.threads()) {
      const rootView = viewOf(t.root, meId);
      if (rootView.pending) waiting++;
      const replyViews = t.replies.map((r) => {
        const v = viewOf(r, meId);
        if (v.pending) waiting++;
        return v;
      });
      const placement = placements.get(t.root.id) ?? null;
      const prev = threadCache.get(t.root.id);
      seen.add(t.root.id);
      if (prev && prev.root === t.root && prev.rootView === rootView && prev.placement === placement && prev.replies.length === replyViews.length && prev.replies.every((r, i) => r === replyViews[i])) {
        out.push(prev.view);
        continue;
      }
      const view: ThreadView = {
        id: t.root.id,
        root: rootView,
        replies: replyViews,
        ...(t.root.resolved ? { resolved: t.root.resolved } : {}),
        placement,
        made: t.root.anchor ? { cut: t.root.anchor.cut, seq: t.root.anchor.seq } : null,
      };
      threadCache.set(t.root.id, { root: t.root, replies: replyViews, placement, rootView, view });
      out.push(view);
    }
    for (const id of [...threadCache.keys()]) if (!seen.has(id)) threadCache.delete(id);
    const changed = out.length !== threads.length || out.some((t, i) => t !== threads[i]);
    if (changed) threads = out;
    const s = source.syncStatus();
    const state: CommentsSyncState = !s ? "local" : SYNC_STATES.has(s.state) ? (s.state as CommentsSyncState) : "offline";
    const next: CommentsStatus = { state, waiting, ...(s?.error ? { error: s.error } : {}) };
    const statusChanged = next.state !== status.state || next.waiting !== status.waiting || next.error !== status.error;
    if (statusChanged) status = next;
    if (changed || statusChanged) notify();
  };

  // one placement run at a time; a change during a run asks for one more
  let running: Promise<void> | null = null;
  let again = false;
  const place = (): Promise<void> => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        try {
          placements = await source.placements({ budgetMs: opts.budgetMs ?? 8 });
        } catch {
          // a version this replica can't read right now (closing, a cut gone): keep the last placements
        }
        if (closed) return;
        rebuild();
      } while (again);
    })().finally(() => (running = null));
    return running;
  };

  const offSource = source.on((e) => {
    if (closed) return;
    if (e.type === "refused") {
      notice = opts.refusedWords ? opts.refusedWords(e.reason ?? "") : (e.reason ?? "refused");
      notify();
    }
    rebuild();
    if (e.type === "change") void place();
  });
  const offVersions = opts.versions?.on(() => !closed && void place());
  rebuild();
  void place();

  return {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    threads: () => threads,
    me: () => source.me(),
    canComment: () => opts.canComment?.() ?? true,
    status: () => status,
    notice: () => notice,
    dismissNotice() {
      if (notice === null) return;
      notice = null;
      notify();
    },
    async add(body, range) {
      await source.add(range ? { body, range } : { body });
    },
    async reply(threadId, body) {
      await source.reply(threadId, body);
    },
    async edit(id, body) {
      await source.edit(id, body);
    },
    async resolve(threadId, resolved) {
      await source.resolve(threadId, resolved);
    },
    async remove(id) {
      await source.remove(id);
    },
    close() {
      closed = true;
      offSource();
      offVersions?.();
      listeners.clear();
    },
    async settled() {
      while (running) await running;
    },
  };
}
