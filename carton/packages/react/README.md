# @carton/react

Headless hooks and components for Carton: History, Cuts, Fold in, conflict cards, the Changes view with Play and
Before, Credits, Undo turn, the published cut, live presence and the sync status words. The words are Carton's (PLAN
§0.1): version, cut, fold in, conflict card, published cut, changes, credits, never git's.

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
| `HistoryPanel` | Versions, newest first, virtualized, by day (sticky headers; a long History folds older days). A cut bar (the cut's menu, a filter: All versions, Named versions, Agent turns, Your changes, Only “clip” with its credits, shown as a removable chip). Rows of who, what and when (always am/pm; the newest reads Now): an agent's prompt in quotes with its own mark, a name in bold, your run of changes as one row ("You · 6 changes ›"), the history's start as one row, an agent working as a live row with its line, "Not sent yet" on a provisional one (L5), "Viewing ✕" on the one the editor shows. A click or Enter opens its card; only Play views. Row menu: Play its changes, Compare with your edit, Name, New cut, Restore…; on a teammate's cut no Restore and no Undo this turn (PLAN 6.2). The cut bar's `cuts` slot takes the host's `CutsMenu` (docs/carton-ux DESIGN §6.1). Compare with your edit (the row's menu, a card's See them, Shift+click or Shift+↑↓ on a second version) opens the Changes view in place of the list. `play`: the host's player, for the card's Play and Before and the Changes view's |
| `VersionCard` | A version's card, inline under its row: "Your edit has N changes since this · See them" (an older version), the change map, its first four changes then "and N more", Play all, Restore… (asked in the card, with how many later changes it undoes) or Undo this turn, New cut from this version. Only an open card asks what changed (DESIGN §5.2) |
| `ChangeRow`, `ChangeList`, `ChangeMap` | The one way a change is shown (DESIGN §5.1): time in the edit, the kind of clip in the timeline's colours with what happened, the sentence, who and when when the list mixes authors, ▶. The map: a tick per change on the edit's length. Play moves their progress and playhead outside React (`setChangeProgress`, `moveMapPlayhead`). Shared by History, the Changes view and Fold in |
| `CutsMenu` | Which cut you're on and every cut: a colour dot for each but Main (`cutColor`), who changed it last and when, teammates' cuts under "From teammates" marked View only. New cut from your edit, one "Fold in changes from a cut…" however many cuts, Rename, and "Agents work on the cut you're on." While an agent's turn holds the timeline a switch opens in place with "Switch when it finishes" (queued: `switchWhenDone`, run once at the turn's end, dropped by a switch by hand) and "Switch now". Scrolls past 8 cuts, a search past 12. `openCutsMenu(ui)` opens it with focus in it from elsewhere (the title bar's cut chip) |
| `TeammateCutActions` | On a teammate's cut: "Fold into Main cut…" and "New cut from it" (no Restore); the cut bar shows Viewing ✕ back to your cut |
| `FoldInDialog` | "Fold in changes": From and Into pickers, one line on what happens ("Main cut gets what changed on “30s cut” since it was made from Main cut at 12:20 pm."), every change as a change row (time in the edit, the kind of clip, the sentence, who) with a tick box, a lock on a project setting that can't be left out, "Left out on Oct 30" on what an earlier partial fold left out (those come in together), a conflict as an inline pick between the two cuts, and the counted button ("Fold in 3 changes": what History will count; "Fold in the rest"). The nothing-to-fold state, and §13's missing-base text when the copy builds on a version you don't have |
| `ConflictCard`, `ConflictList` | What each side did to which clip, in words ("“Interview B”: you and Claude Code both moved it"; "Moved it to start at 0:20"), and which side the timeline shows. Sides as a radio group that only picks; See it views a side (`view({ kind: "conflict" })`, or the host's deprecated `onPreview`); one Keep that names the pick; the line during the other side's agent turn, and "Pick again" when its values changed. With `onPick` (the Fold dialog): the pre-redesign card, until the dialog's own pick rows |
| `ConflictStack` | One card at a time with "1/2 ›"; "Not now" folds it into the "N conflicts to pick" pill and sends it to the back. Waits as the pill while the host folds it or the stage shows anything else; the pill brings your edit back |
| `ChangesView` | Everything between two points, in words (docs/carton-ux DESIGN §5.4): "Changes since 12:20 pm" / "From Director's “Add captions to the interview” to your edit now", the change map, every change in timeline order (virtual past 50), Play all, Before while playing, and Restore this version… with what it undoes said first. ← History (Esc) |
| `usePlayChanges`, `PlayAllButton`, `BeforeButton` | Play and Before over any list of changes (the Changes view, a version's card): ▶ on a change plays its spot ±1 s, Play all every spot in order, one row lit at a time; on your edit when the newer side is the cut's newest version, else viewing it. Before: hold (or B) to view the older side at the same moment, a click latches it. `PlayHost` is the host's player: `onFrame`, `seek`, `prefetch` (load Before's side ahead), `length` |
| `CreditsPopover` | Who last changed each part of a clip ("Director › Explore") |
| `UndoTurnButton` | "Undo Director: tighter intro": the whole turn |
| `PublishedStatus` | What the share link shows, and "Newer edits exist" |
| `PresenceAvatars`, `GhostLayer` | People, each with their agents and subagents; ghosts of remote drags over your timeline |
| `SyncStatusWords` | Syncing · Up to date · Offline: N edits waiting |
| `ViewingFrame` | Viewing on the stage (UX redesign PLAN 1.1): a 2 px frame round it, the one label in a tab on its corner only when History's list isn't on screen, ✕ and Esc back (`useEscapeBack`: the host's own Esc first), one pulse per edit tried (`pulse`), viewing and the return announced once |
| `PreviewBanner` | Deprecated (the app uses `ViewingFrame`): "You're looking at …", with "Back to my edit" (§9 R2-16). Kept one release for the gallery |

The components carry roles, keyboard handling and class names, and no colours. `skin/cardboard` styles them to look
native in Cardboard: it reads Cardboard's CSS variables (`--popover`, `--surface-raised`, `--font-sans`…), with 1.4.0's
values as fallbacks.

## The UX redesign's view model (docs/carton-ux, PLAN workstream 0)

What the redesigned History, Changes view, cuts and Fold, and conflict cards read. The mock implements all of it with the
mockups' story (Main cut today, a 0:38 edit), so components can be built before the engine is wired.

| Read or call | What it gives |
|---|---|
| `changes(a, b)` | Every change from `a` to `b` as change rows (`Change`: `text`, `kind` add/remove/change, `clip` kind, `itemId`, `at`/`end` in seconds, `author`, `when`), in timeline order. One per change as core's `countChanges` counts them, so `.length` is the count every other place shows. Kept per pair of versions. Never reads a shot diff |
| `changesIn(versionId)` | What one History row did (a turn: all of it, from before its first version): the version card's rows |
| `viewing()`, `view(target)` | What the stage shows when it isn't your edit, with one label for the chip, the frame and the row ("Director's “Add captions…”", "Before …", "Claude Code's move of “Interview B”", "Leo's Main cut"). `view` loads first and rejects with "Couldn't load this version. Try again."; `view(null)` is back. `openPreview` stays as a deprecated alias |
| `undoTurnOf(versionId)` | Takes out one agent turn, any turn; later edits stay; a clash is a conflict card |
| `working()` | An agent's in-app turn holding the timeline: `{ actor, label, edits, since }` |
| `clipVersions(itemId)`, filter `{ item }` | The versions that touched one clip, from the per-version index core keeps at save (no diff at 10k versions). Filters also take `"mine"` |
| `versionLabel(v)`, `clock(at)` | The one label for a version (its name, an agent's prompt cut to 24 characters, or "your edit from 12:41 pm") and the one clock (always am/pm, "yesterday at 4:10 pm") |
| `groupHistory(…, { group: true })` | Day rows plus a person's run of edits as one group row, an agent turn as one row, the start of History as one "Project created" row, the newest flagged `now` |

Version rows carry `changes` (how many), `leftOut` (a partial fold's), `base` (where their changes start), `run` (the
turn they're part of) and `start`. Every sentence comes from core's `changeList` (one table, DESIGN §8).

A conflict card's sides carry their change sentence about the card's clip (`ConflictSide.text`: "Moved it to start at
0:20"), a verb phrase for its title (`did`: "moved it") and a noun for the viewing label (`what`: "move"); the card
carries the clip's name (`clip`) and, when the host can say, what Keep both makes (`both`). `cardSentences(card, schema,
doc, valueWords)` reads them from one of core's cards; `conflictWords(conflict, nameOf)` is everything a card says (title,
lead, side names, Keep names, viewing labels), so the card, `view()`'s label and the pick's toast (`keptText`) agree.
`summary` stays core's describeCard.

## Performance, by design

- **Narrow subscriptions.** The view model is split into topics, and each component subscribes only to what it shows.
  Every value keeps its identity until it changes. A ghost moving at 20 Hz never wakes History; a new version never
  wakes the avatars; a burst of confirmations costs one render (notifications coalesce per microtask).
- **History for 10k+ versions.** A fixed-row virtual list renders only the rows on screen. Rows are memoized by their
  version object, so a new version renders one row. Summaries are described only for rows someone reads.
- **60 fps playback.** Play runs outside React (`SpanPlayer`): each animation frame moves the lit row's progress line
  and the change map's playhead by transform and calls your `onFrame(time)`. React hears only when the lit row or
  play/pause changes. Ghosts move their elements directly too.

Measure it with `npm run bench` (needs Playwright and Chromium: `CARTON_PLAYWRIGHT`, `CARTON_CHROMIUM`). Sizes:
`node bench/size.mjs`.

## Gallery

`npm run gallery` builds `gallery/dist/index.html` (React) and `preact.html` (Preact) on mock data, plain esbuild,
opened from disk. `npm run screens` is the capture rig (`gallery/capture/`, UX redesign PLAN 9.4: it replaced the old
`gallery/screens.mjs`, which had fallen behind the components): the app's own composition (`scripts/carton/ui.js`) on
Cardboard's real stylesheet, every state shot in headless Chromium at 384 and 300 px, on React and on `preact/compat`,
into `gallery/dist/capture/shots/` with an `INDEX.md`. It needs `CARTON_CARDBOARD_ASSETS` (Cardboard 1.4.0's
`dist/renderer/assets`), `CARTON_PLAYWRIGHT` and `CARTON_CHROMIUM`.

## Tests

`npm test` runs the logic tests, the component tests on React, the component tests again on `preact/compat`
(`test/preact-alias.ts`), and the adapter tests on a real `Carton.open` with store-memory.

## Not yet checked on the target

- The renderer patch that mounts these components is the windows agent's (`scripts/patch-carton*.js`). Look,
  keyboard and frame rate need a check inside the real Windows app.
- Frame-rate numbers come from headless Chromium on a shared ARM box. Re-measure on the laptop before quoting them.

## Retired

The Compare card (`CompareCard`) and Watch the changes (`WatchTheChanges`, `ChangesPlayer`, `stripLayout`, `xAt`) are
gone (docs/carton-ux PLAN 4.4): the Changes view, Play and Before replace them. The view model's `compare()` and
`shotDiff()` stay for hosts that use them; the components no longer call either.
