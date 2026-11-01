// Timecoded comments (@carton/comments; REQ-C3 in the comments notes). The editor opens `Comments` on its Carton
// with the project's own transport, URL and token; the watch page, which holds no Carton (two read-only followers),
// gives Comments a read-only stand-in over the version it follows. The panel and markers are @carton/react's.

import { Comments, type CommentsCarton } from "@carton/comments";
import { hashDoc, type Carton, type Doc, type Schema, type StateRef } from "@carton/core";
import type { Transport, TransportConnection } from "@carton/core/plugins";
import { commentsUi, type CommentsSource, type CommentsUiHandle } from "@carton/react";
import { createMemoryStore } from "@carton/store-memory";

/**
 * A transport that connects only while `online()`: the editor's "Go offline" stops the document sync, and comments
 * follow it (no comment goes up while the person chose to be offline; they wait in the store). `drop()` closes the
 * connections open now; the comment sync retries, and is refused until `online()` again.
 */
export function gatedTransport(inner: Transport, online: () => boolean): { transport: Transport; drop(): void } {
  const open = new Set<TransportConnection>();
  return {
    transport: {
      async connect(url, opts) {
        if (!online()) throw Object.assign(new Error("offline (chosen here)"), { code: "unreachable" });
        const c = await inner.connect(url, opts);
        if (!online()) {
          c.close();
          throw Object.assign(new Error("offline (chosen here)"), { code: "unreachable" });
        }
        open.add(c);
        c.onClose(() => open.delete(c));
        return c;
      },
    },
    drop() {
      for (const c of [...open]) c.close();
      open.clear();
    },
  };
}

/** A version on screen other than the head: a History preview, as `{cut, seq}` and its document. */
export interface ShownVersion {
  cut: string;
  seq: number;
  doc: Doc;
}

/**
 * Comments as the panel and markers use them, on the version on screen: while a preview of an earlier version is
 * shown, threads are placed on it, and a new comment is pinned to it (its time and clip are the preview's), not to the
 * head. Without a preview, the Comments handle as is.
 */
export function onScreen(comments: Comments, schema: Schema, shown: () => ShownVersion | null): CommentsSource {
  const hashes = new WeakMap<Doc, string>();
  const hash = (doc: Doc) => hashes.get(doc) ?? (hashes.set(doc, hashDoc(doc, schema)), hashes.get(doc)!);
  return {
    threads: () => comments.threads(),
    isPending: (id) => comments.isPending(id),
    me: () => comments.me(),
    syncStatus: () => comments.syncStatus(),
    on: (l) => comments.on(l),
    add: (input) => {
      const v = shown();
      return comments.add(v ? { ...input, version: { cut: v.cut, seq: v.seq } } : input);
    },
    reply: (id, body) => comments.reply(id, body),
    edit: (id, body) => comments.edit(id, body),
    resolve: (id, resolved) => comments.resolve(id, resolved),
    remove: (id) => comments.remove(id),
    placements: (opts) => {
      const v = shown();
      return v ? comments.placeOn({ cut: v.cut, seq: v.seq, hash: hash(v.doc), doc: v.doc }, opts) : comments.placements(opts);
    },
  };
}

/** The editor's comments: on its Carton, shared through the project's host, placed again whenever the head shown moves. */
export async function openEditorComments(o: {
  carton: Carton;
  /** Shares comments; none in a tab that doesn't hold this person's push lock (its comments wait in the store). */
  sync: { transport: Transport; url: string; token: () => Promise<string> } | null;
  /** Fires when the version on screen changed (LiveDoc: once per frame at most, not on presence; a preview opened or closed). */
  versions: { on(listener: () => void): () => void };
  /** The preview on screen, if any: comments are placed on it and new ones pinned to it. */
  shown?: () => ShownVersion | null;
  canComment: () => boolean;
}): Promise<{ comments: Comments; ui: CommentsUiHandle }> {
  const comments = await Comments.open({
    carton: o.carton,
    ...(o.sync ? { sync: o.sync } : {}),
    anchor: { media: "mediaItemId" },
    cut: () => o.carton.cut,
  });
  const source = o.shown ? onScreen(comments, o.carton.schema, o.shown) : comments;
  return { comments, ui: commentsUi(source, { versions: o.versions, canComment: o.canComment }) };
}

/**
 * What Comments needs of a Carton, over the one version a watch page follows: its document, nothing to write, no
 * history (no lineage: threads are followed by id and media). Comments are kept in memory: a watch link reads only.
 */
export class FollowedVersion {
  readonly #listeners = new Set<() => void>();
  #ref: StateRef;
  #doc: Doc;
  readonly carton: CommentsCarton;
  readonly cut: string;
  readonly schema: Schema;

  constructor(cut: string, schema: Schema, seq: number, doc: Doc) {
    this.cut = cut;
    this.schema = schema;
    this.#doc = doc;
    this.#ref = { branchId: cut, seq, hash: hashDoc(doc, schema) };
    const self = this;
    this.carton = {
      store: createMemoryStore(),
      schema,
      cut,
      cuts: async () => [],
      head: async () => ({ ref: self.#ref, doc: self.#doc }),
      checkout: async () => {
        throw new Error("a watch page holds only the version it shows");
      },
      identity: () => null,
    };
  }

  /** The followed cut moved (or its document arrived again). */
  show(seq: number, doc: Doc): void {
    if (doc === this.#doc && seq === this.#ref.seq) return;
    this.#doc = doc;
    this.#ref = { branchId: this.cut, seq, hash: hashDoc(doc, this.schema) };
    for (const l of [...this.#listeners]) l();
  }

  on(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

/** A watch page's comments: its Published cut's only (the host's rule for a scoped link), read only. */
export async function openWatchComments(o: { version: FollowedVersion; sync: { transport: Transport; url: string; token: () => Promise<string> } }): Promise<{ comments: Comments; ui: CommentsUiHandle }> {
  const comments = await Comments.open({
    carton: o.version.carton,
    sync: o.sync,
    anchor: { media: "mediaItemId" },
    cut: () => o.version.cut,
    lineage: { lineage: async () => null },
  });
  return { comments, ui: commentsUi(comments, { versions: o.version, canComment: () => false }) };
}
