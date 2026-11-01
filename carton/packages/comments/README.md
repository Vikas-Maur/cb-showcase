# @carton/comments

Timecoded comments for Carton (PLAN §1 C6, §9, §14). A comment is pinned to the **version** it was made on and to a
**place** on the timeline. On a later version it is placed again:

| Status | Meaning | Shown as |
|---|---|---|
| `exact` | same place, and it still shows what the comment was made on | the timecode |
| `moved` | it shows the same thing somewhere else (a ripple, a moved or split clip) | "Moved" |
| `outdated` | the picture or sound there changed, or the moment was trimmed away (`why`) | "May be outdated" |
| `removed` | every clip it was on is gone | "Clip removed" |
| `general` | a comment on the whole version | "Whole version" |

**Comments are not versions.** Adding, editing, resolving, replying or deleting never makes a change, never meets an
edit in a fold, never shows in History and never moves a cut's head. They live in their own tables and travel as
their own messages.

No runtime dependencies besides `@carton/core`. Runs in Node, Electron, browsers and Workers.

## Use

```ts
import { Comments } from "@carton/comments";

const comments = await Comments.open({
  carton,                                   // an open Carton: anchors are made on its versions
  sync: { transport, url, token },          // optional: the same as Carton.open's sync, to share comments
  anchor: { media: "mediaItemId" },         // Cardboard: follow a clip by its media when nothing else finds it
});

const c = await comments.add({ body: "Music comes in too early", range: [12.4, 12.4] });
await comments.reply(c.id, "Moved it after the line");
await comments.resolve(c.id);
const where = await comments.placements({ budgetMs: 8 }); // thread id -> { status, range, items, why? }
comments.on((e) => { /* "change" | "refused" | "sync" */ });
```

- `add({ body, range?, cut?, version?, agent? })`: a thread on the head of the current cut (or `cut`), or on an older
  `version: { cut, seq }`. No `range`: on the whole version. `agent` names an agent writing for the person
  ("Director").
- `edit` and `remove` are the author's only; anyone who may comment resolves and reopens. The same rules run here
  first (`CommentError`), then on the server.
- The author is `carton.identity()` (the person set at share or join), else the generic "You".
- `cut: () => string`: the cut this session names to the host; a watch or review link names its Published cut.
- `placements()` / `placeOn(target)` place every thread; see Performance.
- `settled()`, `refresh()` (another process, such as `cb`, wrote to carton.db), `close()`.

The UI is in `@carton/react`: `CommentsPanel`, `CommentMarkers`, `commentsUi(comments, { versions: carton })`.

## Anchors

An anchor keeps the version (`cut`, `seq`, full state hash), the range in seconds, the visible items under the range
(top first, at most 16) each with the **source-media timecode** it showed there, and the range's **shot signature**.
The signature follows the shot diff's definition (core `shots()`, "Watch the changes"): the visible layers by the
host's stacking rank, each by its attributes minus the host's ignored and edge fields, its speed, the source time it
shows, and the edge windows (fades, transitions) inside the range; never the output position. Pieces of a split clip
that continue each other read as one layer.

Placing an anchor on a later version needs only that version's document, never the old one:

1. Follow its items: by the **split lineage** between the two versions (`intent.lineage` of the changes between them),
   else by id, else by **media** (the same media showing the same source time, nearest the old place). The piece that
   still shows the anchored source time gives the new place.
2. Compare the range's signature there with the anchored one: equal is `exact` or `moved`, different is `outdated`.

So a comment made on a version this replica doesn't hold (a teammate's unshared cut, a state below a joiner's
keyframe) is placed all the same.

## Plug-ins (PLAN §3.1)

- **`CommentStore`**: where comments are kept. `cartonCommentStore(carton.store)` (the default) keeps three tables in
  the project's own Store beside its history (carton.db on desktop, IndexedDB in a browser): `comments`,
  `comments_pending`, `comments_meta`. `memoryCommentStore()` for tests. Pending patches are compare-and-set rows, so
  the app and `cb` can both write comments to one carton.db.
- **`CommentSync`**: how they are shared. Its own connection through the project's `Transport` to the project's host,
  with the project's token. Nothing in the document sync changes.
- **Server half**: `@carton/comments/server` (`createCommentRoom({ storage })`): pure rules over the sequencer's
  `SequencerStorage`, so every host (Durable Object, Node) carries comments the same way. `@carton/server` routes the
  two message kinds to it.
- **`LineageSource`**: split lineage between versions; by default from the Carton (its store's change rows).

## Protocol

| Message | Direction | What |
|---|---|---|
| `comments {branchId, since}` | client → host | subscribe to the project's comment stream, and read the rows after `since` |
| `comments {rows, head, more?, reply?, reset?}` | host → client | a page of rows (`more` until caught up), or others' changes as they happen |
| `comment {branchId, n, id, patch}` | client → host | one comment's pending patch: `{add?, body?, resolved?, deleted?, at, author}` |
| `commentAnswer {n, id, row?, refused?, reason?, retryMs?}` | host → client | the row as stored, or why not |

A comment's edits made before the server answered merge into one patch, so a project that was never shared sends one
patch per comment when it is. A retried patch is stored once. The read position advances only past rows the client
has certainly seen. A host from before comments answers "unknown message type": the client says `unsupported` and
keeps its comments.

## Server rules (PLAN §14)

- owners, editors and **commenters** comment, reply and resolve; **viewers** read only;
- a session scoped to some cuts (a Published cut's **watch link**) reads only comments on those cuts, and with a
  commenting role (a review link) comments only there; it learns nothing of other cuts' comments;
- only a comment's **author** edits or deletes it; the author is the session's account, never what a client claims;
- per connection a token bucket like presence's (10 at once, 2 per second); at most 100,000 comments per project; a
  comment at most 64 KB; pages at most 500 rows and 512 KB;
- storage: `comments`, `comment_log` (one row per comment, at the seq of its latest change), `comment_meta`. A change
  writes 3 rows.

## Performance

Placing is incremental. A version's `TimelineIndex` reuses every unchanged record's layer (History shares record
objects between versions) and hashes an item's content only when a signature needs it. `placeOn` compares the new
version with the one placed last (an identity check per item) and places again only threads a changed item could
move: one it follows or sits on, a change overlapping where it sits, a clip of its media. A property test checks that
this always equals placing from scratch. With `budgetMs` it yields between threads, so a big project never blocks a
frame. `bench/reanchor.ts` measures 1,000 comments on 10,000 items.

## Limits

- A fold or a `.cbproj` import carries no split lineage across cuts; such clips are followed by id and media.
- The signature is per range: a change far from the commented moment doesn't mark it, except a change of the
  commented clip's look (its attributes are one value).
- Full-history `.cbproj` exports copy the comment tables as they are.
