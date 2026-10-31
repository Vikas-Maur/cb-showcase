# @carton/react

Headless hooks and components for Carton: History, Cuts, Fold in, conflict cards, Compare, Credits, Undo turn, the
published cut, live presence, the sync status words, and Watch the changes. The words are Carton's (PLAN §0.1):
version, cut, fold in, conflict card, published cut, compare, credits, never git's.

`react` (18 or 19) is a peer dependency, and everything also runs under `preact/compat`. The tests run every component
on both.

## Use it

In one process (a web client, Node, tests):

```ts
import { CartonProvider, HistoryPanel, CutsMenu, SyncStatusWords, fromCarton } from "@carton/react";
import { injectCardboardSkin } from "@carton/react/skin/cardboard";

const ui = fromCarton(carton, { me: actor, onPreview: (p) => showReadOnly(p?.doc) });
injectCardboardSkin(document);               // or style the unstyled components yourself
root.setAttribute("data-carton-skin", "cardboard");
createRoot(root).render(h(CartonProvider, { ui }, h(HistoryPanel), h(CutsMenu), h(SyncStatusWords)));
```

Across processes (Cardboard: the handle lives in the library worker, the components in the renderer):

```ts
// worker
const server = serveUi(fromCarton(carton, { me }), (msg) => port.postMessage(msg));
port.onmessage = (e) => server.receive(e.data);
// renderer
const { ui, receive } = remoteUi((msg) => port.postMessage(msg));
port.onmessage = (e) => receive(e.data);
```

Messages are plain structured-clone data. Small state travels whole when it changes. History is sent once, then as
the rows whose version changed, so a new version is one row on the wire however long History is.

To try the components before Carton is wired: `createMockUi()` from `@carton/react/mock`.

## In Cardboard: a Preact root

Our Windows build mounts the components in their own Preact root (esbuild aliases `react`/`react-dom` to
`preact/compat`). It doesn't reach into Cardboard's React:
- Cardboard 1.4.0's React 19.2.3 is bundled in a hashed chunk with mangled exports. Using it would mean patching that
  chunk: one more minified anchor that breaks with each version.
- A separate root can't disturb Cardboard's editor. Presence, ghosts and sync bursts never schedule renders in its
  tree, and an error in ours can't unmount it.

Cardboard's own team, which has the source, would use React directly with no change.

## Components

| Component | What it shows |
|---|---|
| `HistoryPanel` | Versions, newest first, virtualized. Named versions, Director turns as checkpoints, who and when down to the subagent, "Waiting to sync" on provisional ones (L5). Preview, Compare with current, name, new cut from here, Restore |
| `CutsMenu` | Switch cuts, new cut from here, rename, fold into Main. Someone else's cuts are read-only and named by owner ("Bob's Main cut") |
| `FoldInDialog` | What folding in brings, in plain words. Leave changes out (fold in some of it), pick on conflict cards first, "You can fold in the rest later". §13's missing-base text when the copy builds on a version you don't have |
| `ConflictCard`, `ConflictList` | Both edits, who made each and which one shows now. Keep mine / Keep theirs / Keep both |
| `CompareCard` | Time, author, clip count, length, and "N shots / X s of Y s differ" |
| `CreditsPopover` | Who last changed each part of a clip ("Director › Explore") |
| `UndoTurnButton` | "Undo Director: tighter intro": the whole turn |
| `PublishedStatus` | What the share link shows, and "Newer edits exist" |
| `PresenceAvatars`, `GhostLayer` | People, each with their agents and subagents; ghosts of remote drags over your timeline |
| `SyncStatusWords` | Syncing · Up to date · Offline: N edits waiting |
| `WatchTheChanges` | The shot diff laid out like a side-by-side text diff, with Play changes and an aligned Before/After toggle |
| `PreviewBanner` | "Previewing …", read-only, with "Return to current to edit" (§9 R2-16) |

The components carry roles, keyboard handling and class names, and no colours. `skin/cardboard` styles them to look
native in Cardboard: it reads Cardboard's CSS variables (`--popover`, `--surface-raised`, `--font-sans`…), with 1.4.0's
values as fallbacks.

## Performance, by design

- **Narrow subscriptions.** The view model is split into topics, and each component subscribes only to what it shows.
  Every value keeps its identity until it changes. A ghost moving at 20 Hz never wakes History; a new version never
  wakes the avatars; a burst of confirmations costs one render (notifications coalesce per microtask).
- **History for 10k+ versions.** A fixed-row virtual list renders only the rows on screen. Rows are memoized by their
  version object, so a new version renders one row. Summaries are described only for rows someone reads.
- **60 fps playback.** Play changes runs outside React: each animation frame moves the playhead and calls your
  `onFrame(side, time)`. React hears only when the change on screen changes. Ghosts move their elements directly too.

Measure it with `npm run bench` (needs Playwright and Chromium: `CARTON_PLAYWRIGHT`, `CARTON_CHROMIUM`). Sizes:
`node bench/size.mjs`.

## Gallery

`npm run gallery` builds `gallery/dist/index.html` (React) and `preact.html` (Preact) on mock data, plain esbuild,
opened from disk. `npm run screens` screenshots every section in headless Chromium.

## Tests

`npm test` runs the logic tests, the component tests on React, the component tests again on `preact/compat`
(`test/preact-alias.ts`), and the adapter tests on a real `Carton.open` with store-memory.

## Not yet checked on the target

- The renderer patch that mounts these components is the windows agent's (`scripts/patch-carton*.js`). Look,
  keyboard and frame rate need a check inside the real Windows app.
- Frame-rate numbers come from headless Chromium on a shared ARM box. Re-measure on the laptop before quoting them.
