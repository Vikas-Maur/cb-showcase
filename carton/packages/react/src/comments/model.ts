// The comments view model the Comments panel and the timeline markers read (PLAN §9 anchors, C6 timecoded comments).
// Like CartonUi it is narrow and immutable: every getter returns the same object until that piece really changes, so
// a list of 1,000 threads re-renders only the thread that changed. `commentsUi()` (from-comments.ts) builds it over a
// `@carton/comments` handle; `createMockComments()` (mock.ts) makes one for galleries and tests. Owner: comments.

/** Who wrote a comment: the person, and the agent that wrote it for them, if any. */
export interface CommentPerson {
  readonly id: string;
  readonly name: string;
  readonly agent?: string;
}

export interface CommentView {
  readonly id: string;
  readonly author: CommentPerson;
  readonly body: string;
  readonly at: number;
  readonly editedAt?: number;
  readonly deleted?: boolean;
  /** Not on the server yet (written offline, or the project isn't shared). */
  readonly pending?: boolean;
  /** Written by this person: they may edit and delete it. */
  readonly mine: boolean;
}

/** How a thread sits on the version shown (`@carton/comments` Placement). */
export type PlacementStatus = "exact" | "moved" | "outdated" | "removed" | "general";

export interface ThreadPlacement {
  readonly status: PlacementStatus;
  /** Seconds on the version shown; for `removed`, where it was; null for a comment on the whole version. */
  readonly range: readonly [number, number] | null;
  /** For `outdated`: the picture there changed, or the moment was trimmed away. */
  readonly why?: "changed" | "trimmed";
}

export interface ThreadView {
  /** The thread's first comment's id. */
  readonly id: string;
  readonly root: CommentView;
  readonly replies: readonly CommentView[];
  readonly resolved?: { readonly by: CommentPerson; readonly at: number };
  /** Where it sits now; null until placed. */
  readonly placement: ThreadPlacement | null;
  /** The version it was made on. */
  readonly made: { readonly cut: string; readonly seq: number } | null;
}

export type CommentsSyncState = "local" | "offline" | "connecting" | "catching-up" | "up-to-date" | "unsupported" | "stopped";

export interface CommentsStatus {
  readonly state: CommentsSyncState;
  /** Comments and edits waiting for the server. */
  readonly waiting: number;
  readonly error?: string;
}

export interface CommentsUi {
  subscribe(onChange: () => void): () => void;
  /** Threads, oldest first. Same array until something changes. */
  threads(): readonly ThreadView[];
  me(): CommentPerson;
  /** This session may write comments (owners, editors and commenters; not viewers). */
  canComment(): boolean;
  status(): CommentsStatus;
  /** The last thing the server refused, in words, until dismissed. */
  notice(): string | null;
  dismissNotice(): void;
  /** A new thread at `range` (seconds; a moment when start equals end), or on the whole version (null). */
  add(body: string, range: readonly [number, number] | null): Promise<void>;
  reply(threadId: string, body: string): Promise<void>;
  edit(id: string, body: string): Promise<void>;
  resolve(threadId: string, resolved: boolean): Promise<void>;
  remove(id: string): Promise<void>;
}
