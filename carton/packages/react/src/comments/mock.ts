// A comments view model in memory, for galleries and tests: the same rules as @carton/comments (authors edit and
// delete their own, anyone who may comment resolves), placements given by the caller.

import type { CommentPerson, CommentView, CommentsStatus, CommentsUi, ThreadPlacement, ThreadView } from "./model.ts";

export interface MockComments extends CommentsUi {
  /** Set where a thread sits now. */
  setPlacement(threadId: string, p: ThreadPlacement | null): void;
  setStatus(s: CommentsStatus): void;
  setNotice(text: string | null): void;
  /** Mark a comment as waiting for the server, or not. */
  setPending(id: string, pending: boolean): void;
  /** Calls made, for tests: ["add", body, range], ["reply", id, body]… */
  readonly calls: unknown[][];
}

export const mockPeople = {
  alice: { id: "alice", name: "Alice Chen" },
  bob: { id: "bob", name: "Bob Okafor" },
  cora: { id: "cora", name: "Cora Lind" },
} satisfies Record<string, CommentPerson>;

export function createMockComments(opts: { me?: CommentPerson; canComment?: boolean; seed?: boolean; now?: number } = {}): MockComments {
  const me = opts.me ?? mockPeople.alice;
  const now = opts.now ?? Date.now();
  const listeners = new Set<() => void>();
  const calls: unknown[][] = [];
  let n = 0;
  let threads: ThreadView[] = [];
  let status: CommentsStatus = { state: "up-to-date", waiting: 0 };
  let notice: string | null = null;
  const emit = () => listeners.forEach((l) => l());
  const view = (author: CommentPerson, body: string, at: number, extra: Partial<CommentView> = {}): CommentView => ({ id: `m${++n}`, author, body, at, mine: author.id === me.id, ...extra });
  const replace = (id: string, f: (t: ThreadView) => ThreadView) => {
    threads = threads.map((t) => (t.id === id ? f(t) : t));
    emit();
  };
  const findThread = (commentId: string) => threads.find((t) => t.id === commentId || t.replies.some((r) => r.id === commentId));
  const mapComment = (id: string, f: (c: CommentView) => CommentView) => {
    const t = findThread(id);
    if (!t) throw new Error("no such comment");
    replace(t.id, (x) => (x.id === id ? { ...x, root: f(x.root) } : { ...x, replies: x.replies.map((r) => (r.id === id ? f(r) : r)) }));
  };
  const own = (id: string) => {
    const t = findThread(id);
    const c = t?.id === id ? t.root : t?.replies.find((r) => r.id === id);
    if (!c?.mine) throw new Error("only its author can change a comment");
  };

  if (opts.seed !== false) {
    const mk = (author: CommentPerson, body: string, ago: number, placement: ThreadPlacement | null, extra: Partial<ThreadView> = {}, replies: CommentView[] = []): ThreadView => {
      const root = view(author, body, now - ago * 60_000);
      return { id: root.id, root, replies, placement, made: { cut: "main", seq: 12 }, ...extra };
    };
    threads = [
      mk(mockPeople.bob, "The music comes in too early here: wait for the line to finish.", 50, { status: "exact", range: [12.4, 12.4] }, {}, [view(me, "Agreed, moving it after “all of it”.", now - 30 * 60_000)]),
      mk(mockPeople.cora, "Can we hold on this shot a little longer?", 40, { status: "moved", range: [31, 34.5] }),
      mk(me, "Logo looks soft at this size.", 25, { status: "outdated", range: [47.2, 47.2], why: "changed" }),
      mk(mockPeople.bob, "Overall: the intro drags; aim for 20 s.", 20, { status: "general", range: null }),
      mk(mockPeople.cora, "Typo in the lower third.", 90, { status: "exact", range: [18, 21] }, { resolved: { by: me, at: now - 10 * 60_000 } }),
    ];
  }

  return {
    calls,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    threads: () => threads,
    me: () => me,
    canComment: () => opts.canComment ?? true,
    status: () => status,
    notice: () => notice,
    dismissNotice() {
      notice = null;
      emit();
    },
    async add(body, range) {
      calls.push(["add", body, range]);
      const root = view(me, body, Date.now(), { pending: true });
      threads = [...threads, { id: root.id, root, replies: [], placement: range ? { status: "exact", range } : { status: "general", range: null }, made: { cut: "main", seq: 12 } }];
      emit();
    },
    async reply(threadId, body) {
      calls.push(["reply", threadId, body]);
      replace(threadId, (t) => ({ ...t, replies: [...t.replies, view(me, body, Date.now())] }));
    },
    async edit(id, body) {
      calls.push(["edit", id, body]);
      own(id);
      mapComment(id, (c) => ({ ...c, body, editedAt: Date.now() }));
    },
    async resolve(threadId, resolved) {
      calls.push(["resolve", threadId, resolved]);
      replace(threadId, (t) => {
        const { resolved: _, ...rest } = t;
        return resolved ? { ...rest, resolved: { by: me, at: Date.now() } } : rest;
      });
    },
    async remove(id) {
      calls.push(["remove", id]);
      own(id);
      mapComment(id, (c) => ({ ...c, body: "", deleted: true }));
    },
    setPlacement(threadId, p) {
      replace(threadId, (t) => ({ ...t, placement: p }));
    },
    setStatus(s) {
      status = s;
      emit();
    },
    setNotice(text) {
      notice = text;
      emit();
    },
    setPending(id, pending) {
      mapComment(id, (c) => {
        const { pending: _, ...rest } = c;
        return pending ? { ...rest, pending: true } : rest;
      });
    },
  };
}
