# Carton UX redesign: implementation plan

This plan builds `DESIGN.md`. `AUDIT.md` is the baseline. Each workstream lists its files, what to build, and its
acceptance criteria. A criterion names the mockup (`after/*.png`) a screenshot must match, the before-shot it replaces,
and the tests that must pass. The workstreams are independent where stated, and can go to separate implementers at
once. Follow `AGENTS.md`:
- patches only; Windows-only behaviour behind `__cbWin`;
- every patch commented, with the README updated;
- no measured number quoted until a second agent has checked it.

## How to check your work (every workstream)

- **Unit and component tests:** `cd carton/packages/react && npm test`. It runs every component on React and again on
  `preact/compat`, so both must pass. `npm run typecheck`.
- **Integration tests** for `scripts/carton/*`: `scripts/carton/test/` (follow the nearest existing test).
- **Screenshots:**
  - The capture rig in `docs/carton-ux/capture-rig.patch` (apply it to `carton/packages/react/gallery/`; how to run it is
    in `docs/carton-ux/before/README-capture.md`) renders today's composition with Cardboard's real CSS at 384 and 300 px.
  - Update its states to the new components, and put your shots beside the mockups in the PR, at both widths.
  - "Matches the mockup" means the same structure, words, order and states. Pixel-exact isn't the bar.
- **Performance** (rule 3: never a net negative):
  - History with 12,000 versions (`gallery/?versions=12000`) still renders only the rows on screen.
  - Opening a version's card describes only that version.
  - Play runs outside React, as `ChangesPlayer` does today: per-frame work touches the DOM and the host's `onFrame`, not
    React state.
  - Check with `npm run bench` before and after, and have a second agent re-run it before any number is quoted.

## Workstream 0: data and words (start first; the others build against the mock meanwhile)

| # | Change | Files | Acceptance |
|---|---|---|---|
| 0.1 | **Structured changes.** `ui.changes(a, b): Promise<Change[]>`. Each entry: `{ text, kind: "add"\|"remove"\|"change", clip: "video"\|"title"\|"caption"\|"audio"\|"image"\|"code"\|"project", itemId?, at?: number (seconds in b, or in a for a removal), end?, author?: Actor, when?: number }`. Build it from `docDiff` + `describe`, one per change as `countChanges` counts them. Add it to the mock with 0:00–0:38 positions. Send it over `remote.ts` as plain data, and cache it per (a, b) like `shotDiff` | `carton/packages/react/src/model.ts`, `from-carton.ts`, `mock.ts`, `remote.ts`; `carton/packages/core/src/engine/describe.ts` (sentence per record) | Unit test: for the fixtures in `test/` the count equals `changeCount`; a removal's `at` is its start in a; a project-level change has no `at`. Remote round-trip test. Version cards and the Changes view never call `shotDiff` again |
| 0.2 | **Change sentences** in editor words, one table for every kind of change, used everywhere (History, cards, Changes, Fold, conflict sides, toasts): verb first, clips by name in curly quotes, positions as 0:09, e.g. "Trimmed “Intro”, now ends at 0:05". See DESIGN §8 "Change sentences". Restore, fold, undo and new-cut versions get their own sentences ("Went back to the 12:41 version", "Folded in “X” · 2 of 3 changes", "Made this cut from Main cut at 12:20"). No hashes or ids, ever | `core/src/engine/describe.ts`, `react/src/from-carton.ts` (summary of kinds), `react/src/words.ts` | Golden tests updated, one per sentence form in DESIGN §8. A test fails if any summary matches `/[0-9a-f]{12,}\|@\d+\|main@/` |
| 0.3 | **Words.** Every string in DESIGN §8 goes into `words.ts`; the removed ones go. Count in "changes" everywhere ("version" only for a folded day) | `react/src/words.ts`, `react/src/comments/words.ts` | `grep` in `src/` and `scripts/carton/` finds none of: "Read-only", "Return to current", "Previewing", "Checkpoint", "Section", "unchanged shot", "Shown in the player", "Watch the changes", "Showing now", "conflict card waiting", "Waiting to sync" |
| 0.4 | **History groups.** Consecutive versions by one human author (≤10 min apart, none named or a turn between them) become a group row. The start rows ("Started the cut", "Started the project's history", the import) merge into one "Project created" row. The newest row is flagged `now` | `react/src/history-groups.ts`, `HistoryPanel.ts` | Unit tests on `groupHistory`: grouping, the 10 min break, a named version breaking a group, the start merge. Virtual list test: 12k versions render ≤ (viewport/56 + overscan) rows |
| 0.5 | **Viewing state** replaces `preview()`: `ui.viewing(): { ref, kind: "version"\|"before"\|"conflict"\|"cut", label, short } \| null` (short: "12:20 · Director"), and `ui.view(...)`/`ui.view(null)`. `openPreview` stays as a deprecated alias | `model.ts`, `from-carton.ts`, `mock.ts`, `remote.ts`, `hooks.ts`, `scripts/carton/ui.js` (`connect`) | Unit test of the labels (DESIGN §8 "Viewing"). `bridge.preview` is still the one way the editor swaps |
| 0.6 | **Undo any agent turn:** `ui.undoTurn(versionId)`, using core's turn undo (`cb undo --turn`). A clash becomes conflict cards, as `undo` does | `core/src/carton.ts` (expose it if needed), `from-carton.ts`, `model.ts` | Test: undoing an older turn keeps a later edit on another clip; a clash makes a card |
| 0.7 | **An agent working:** a `working` topic: `{ actor, label, edits }` while an in-app turn holds the timeline, null otherwise | `scripts/carton/carton-node.js` / `main-bridge.js` (where the turn hold is known), `from-carton.ts`, `model.ts`, `mock.ts` | Test: set while a Director turn is open, cleared when it ends; the row and its line show (§6.1) |
| 0.8 | **History of one clip:** a `{ item: id }` filter, plus `credits(itemId)` lines at its top. It needs a per-version index of the clips each version touched, written at save time (diffing on demand won't scale to 10k). Until the index exists, the filter covers the last day only and says so | `core` (index at commit), `model.ts` (`HistoryFilter`), `from-carton.ts` | Test: only versions that touched the clip are listed; with 12k versions the filter answers without diffing every version (count the diffs in the test) |
| 0.9 | **One label and one clock.** `versionLabel(v)`: the name, "Director's “prompt…”" (24 characters), or "your edit from 12:41 pm". `clock(at)`: always with am/pm (or "yesterday at 4:10 pm"), in the locale's 12-hour form where it has one; never a bare H:MM beside a timecode. The chip, the row, the frame label, the toasts and the Changes title all use them | `react/src/format.ts`, `words.ts`, `actors.ts` | Unit tests for each form. `grep` finds no other place that formats a version's time for display |

## Workstream 1: viewing without banners (needs 0.5, 0.9)

| # | Change | Files | Acceptance |
|---|---|---|---|
| 1.1 | **The stage frame** replaces `PreviewBanner`: 2 px blue round the stage while viewing. Its **label tab** (label and ✕ "Back to my edit (Esc)") shows only when History's list isn't on screen: a conflict side, Comments' "See it as it was", the drawer hidden. The Esc rules stay exactly as today (capture-phase state, the editor's own Esc first) | `react/src/components/status.ts` (new `ViewingFrame`), `react/src/skin/cardboard.ts`, `scripts/carton/ui.js` (`CartonStage`, knows whether History's list is shown) | With History open the stage has the frame and nothing else (matches `after/editor-viewing.png`); with it closed, the label (matches `after/editor-conflict-theirs.png`). The existing Esc tests (banner tests, final re-check N2 cases) pass unchanged. Before: `before/real/user-preview-card.png` |
| 1.2 | **The row mark**: the viewed row gets the blue edge and "👁 Viewing ✕"; there is **no** bar across the panel | `HistoryPanel.ts` | Matches `after/history-viewing-384.png` / `-300.png` |
| 1.3 | **What opens viewing, and nothing else**: Play all or ▶ on a version that isn't the newest, Before, a conflict's See it, a comment's See it as it was, a teammate's cut. A row's click or Enter opens its card. Closing the panel or switching tab returns. Play never selects a clip (Cardboard's Esc would take the first Esc) | `HistoryPanel.ts` (`open`), `scripts/carton/ui.js` (`Sidebar` close → `ui.view(null)`, seeker) | Test: click, Enter and double-click on a row leave `viewing()` null; Play on the newest version leaves it null; closing the panel while viewing clears it; Play leaves `bridge.selection()` unchanged |
| 1.4 | **The edit-attempt toast** ("You're looking at … [Back to my edit] Esc") and one pulse of the frame, in place of Cardboard's refusal toast while Carton is on. It is raised from the same place Cardboard raises its refusal (the `Tm` guard's message), so every guarded path keeps its guard | `scripts/carton/renderer-bridge.js` (`refuse`, `previewMessage`), `scripts/patch-carton.js` (the refusal's toast: Carton's words when on, Cardboard's when off), `scripts/carton/ui.js` (`Toast`) | Matches `after/editor-edit-attempt.png`. Drag, trim, Delete, Enter on a title and Ctrl+Z each show it and change nothing (tests on the refusal path). With Carton off, Cardboard's own toast (test). The stage text editor still doesn't open (N3 test) |
| 1.5 | **New hook: the timeline's frame.** A `data-carton-viewing` attribute on the timeline's wrapper while viewing (CSS: the frame and muted clips), and `data-carton-cut` for the optional cut label. One new anchor in the editor bundle, commented as every patch is | `scripts/patch-carton.js`, `scripts/carton/ui.js` (skin rule) | With Carton off neither attribute appears; the patch's `replace(…, count)` matches exactly once; matches `after/editor-viewing.png` and `after/editor-other-cut.png`. If the anchor fails the build stops (as every patch does); the stage frame and the chip carry the state alone |
| 1.6 | **Export while viewing** returns to your edit first ("Back to your edit to export it.") | `scripts/patch-carton.js` (Export's open), `scripts/carton/ui.js` | Test: Export opened while viewing exports the cut's newest version; checked in the real app |

## Workstream 2: the cut chip in the title bar (needs 0.5 for its viewing part; independent of 1)

| # | Change | Files | Acceptance |
|---|---|---|---|
| 2.1 | **The chip** `✂ Main cut ⌄` (a colour dot for every cut but Main): placed before Cardboard's `16:9` chip if the anchor allows, else first in our group. It grows `👁 <label> ✕` while viewing (0.9). The page's panel report (`reportPanel`) carries `{ cut, viewing }`. Its ✕ sends `carton-back` | `scripts/carton/strip-buttons.js`, `scripts/carton/ui.js` (`CartonSide` report), `scripts/carton/main-bridge.js` (route `carton-cuts`, `carton-back`), `scripts/patch-carton.js` (strip anchor) | Matches `after/titlebar-default.png`, `titlebar-other-cut.png`, `titlebar-viewing.png`, `titlebar-teammate-cut.png`. It shows on every project tab with Carton on, and never with Carton off. The name updates within one frame of a switch from `cb cut switch` (test via the event path) |
| 2.2 | **The cuts menu from the chip.** The title bar is a separate page from the editor, so **version 1**: the chip's click opens History with its cuts menu open and focused. **Version 2**, after a prototype: the strip sends the chip's x with `carton-cuts`, and the editor page draws the menu under the title bar at that x (focus, Esc and click-outside all in the editor page) | `strip-buttons.js`, `main-bridge.js`, `scripts/carton/ui.js` | v1: the chip opens History's menu, keyboard and mouse. v2: matches `after/titlebar-cuts-menu.png`; Esc closes it and focus goes back to the page |
| 2.3 | **Narrow** (< 1180 px): the chip shows up to 150 px of the name; Share moves into History's head | `strip-buttons.js`, `scripts/carton/ui.js` (`Sidebar` head) | Matches `after/titlebar-narrow.png`; at 960 px the tabs, the chip and the icons don't overlap (screenshot at 960) |

## Workstream 3: History list and the version card (needs 0.1–0.4 or their mock)

| # | Change | Files | Acceptance |
|---|---|---|---|
| 3.1 | **Rows:** avatar, title, time on the right, then who and how much. **Now** on the newest row. Agent prompts as titles in quotes. Group rows ("You · 6 edits ›") with their children. A named version in bold with a yellow bookmark. The single start row. **Agent marks:** Director, Claude Code and Codex each get their own glyph (small inline SVGs in `icons.ts`), not one sparkle | `HistoryPanel.ts`, `react/src/icons.ts`, `actors.ts`, skin | Matches `after/history-default-384.png` / `-300.png`. Before: `before/real/w-01-history-open.png`, `before/gallery/history-few-384.png` |
| 3.2 | **The cut bar and filter menu** replace the segmented filter: All versions, Named versions, Agent turns, Your changes, and Only “clip” when one clip is selected (0.8). An active filter shows as a removable chip | `HistoryPanel.ts`, `CutsMenu.ts` (button), `scripts/carton/ui.js` (`bridge.selection`) | Matches `after/history-filter-384.png`, `after/history-clip-384.png`; each filter's empty text says what would appear there |
| 3.3 | **The version card**, inline, one open at a time: "Your edit has N changes since this · See them" on any version but the newest (count from `ui.changes(v, head)`), change map, first four change rows with ▶ on hover, "and N more", Play all, Restore… / Undo this turn, ⋯. `VirtualList`'s `expanded` gives its height | new `react/src/components/VersionCard.ts`, `ChangeRow.ts`, `ChangeMap.ts`; `HistoryPanel.ts`; `virtual.ts` | Matches `after/history-expanded-384.png` / `-300.png`, `after/history-older-384.png` / `-300.png`. Before: `before/gallery/history-few-expanded-384.png`. Keyboard per DESIGN §7 (tests: Enter, →, ←, Space, Esc order). Only the open card calls `ui.changes` (test with a counting mock) |
| 3.4 | **Live agent row** (0.7) and its line; **↑ Newest** docked at the list's bottom when scrolled away; skeleton loading; "Not sent yet"; per-action errors in their card | `HistoryPanel.ts` | Matches `after/history-working-384.png`, `after/history-many-384.png`, `after/history-empty-384.png`, `after/history-offline-384.png`, `after/history-loading-384.png` |
| 3.5 | **Row menu:** Play, Compare with your edit, Name this version, New cut from here…, Restore… (with its line); none on the start row | `HistoryPanel.ts` | Matches `after/history-menu-384.png`; it opens upwards near the bottom (existing test) |

## Workstream 4: Changes view, Play and Before (replaces Compare and Watch; needs 0.1, 0.5)

| # | Change | Files | Acceptance |
|---|---|---|---|
| 4.1 | **The Changes view** in place of the list: title in words, map, rows, transport, Restore… and Name. Shift+click or Shift+↑↓ picks the second version | new `react/src/components/ChangesView.ts`; `HistoryPanel.ts`; `scripts/carton/ui.js` (`HistorySide`: drop `WatchTheChanges` and `CompareCard`) | Matches `after/changes-384.png` / `-300.png`, `changes-none-384.png`. Before: `before/real/p3-compare.png`, `before/gallery/history-compare-384.png` |
| 4.2 | **Play:** ▶ on a change plays its span ±1 s; **Play all** plays every span in order. Overlapping spans merge. Positionless changes are lit briefly and skipped. No counter and no step buttons: the lit row is where you are. Runs on your edit when the newer side is the cut's head (no viewing), else views the newer side. A spinner after 300 ms; "Couldn't load this version. Try again." on failure. The editor's playhead follows, as Watch's `seeker` does today (≤ 10 seeks/s, always the last) | `react/src/player.ts` (ranges from `Change.at`/`end` in place of shot rows), `VersionCard.ts`, `ChangesView.ts`, `scripts/carton/ui.js` (seeker) | Matches `after/changes-playing-384.png`, `after/editor-viewing.png`. Tests: span merging, skip. A render counter shows no React render per animation frame (progress by CSS transform). Before: `before/real/user-watch-the-changes.png` |
| 4.3 | **Before**: hold the button (or **B** while the list has focus) to view the older side at the same moment; release to return; a click latches it. The older side is checked out when playing starts, so the flip doesn't wait for it | `VersionCard.ts`, `ChangesView.ts`, `scripts/carton/renderer-bridge.js` (keep the checked-out doc for the flip) | Matches `after/editor-before.png`; the chip reads "Before Director's “Add captions…”". **The flip time is measured on the laptop** (both directions, a long project) before the hold is promised; until a second agent has checked that number, no claim of "instant" is made |
| 4.4 | Retire `CompareCard` and `WatchTheChanges` from the app. Keep their exports one release for the gallery and tests, then delete them | `scripts/carton/ui.js`, `react/src/index.ts`, `react/README.md` | `scripts/carton/` no longer imports either; the README's component table is updated |

## Workstream 5: restore, name, new cut, undo turn, and toasts with Undo (needs 0.6; independent of 1–4)

| # | Change | Files | Acceptance |
|---|---|---|---|
| 5.1 | **Inline restore confirmation** in the card: the count of later changes comes from `ui.changes(v, head).length`, plus "See them" | `VersionCard.ts` | Matches `after/history-restore-384.png` / `-300.png`. Before: `before/real/03-row-menu.png` |
| 5.2 | **New cut from here** as an inline field in the card, with its line; the toast after | `VersionCard.ts`, `scripts/carton/ui.js` (`confirmations`: wrap `newCut`, `switchCut`) | Matches `after/history-newcut-384.png`; the toast "You're on “…”, made from 12:20. Main cut is unchanged. [Back to Main cut]" shows (test on `confirmations`) |
| 5.3 | **Toasts with Undo:** restore, fold, conflict pick and undo-turn toasts get **Undo** (the bridge's undo: the same path as Ctrl+Z). Ctrl+Z of a restore or fold shows "Undid: …" with **Redo**, using the label the worker's undo returns. A hovered toast stays | `scripts/carton/ui.js` (`Toast`, `confirmations`), `scripts/carton/renderer-bridge.js` (undo result label → notice) | Matches `after/toasts.png`. Test: Undo on the toast undoes exactly that action, and a second Ctrl+Z still works |
| 5.4 | **Undo this turn** on agent-turn cards (0.6) | `VersionCard.ts` | Its tooltip reads "Takes out only these N changes. Later edits stay."; a clash shows a card |

## Workstream 6: cuts menu and Fold in (needs 0.1 for change rows; independent of 1–5)

| # | Change | Files | Acceptance |
|---|---|---|---|
| 6.1 | **Cuts menu:** a colour per cut but Main; who and when per cut; "From teammates" with "View only"; New cut from your edit; one "Fold in changes from a cut…"; Rename; Open History (from the chip); "Agents work on the cut you're on."; scrolling past 8 and search past 12. **During a turn** (0.7): the item opens in place with **Switch when it finishes** (a queued switch, run when the turn ends) and **Switch now** | `react/src/components/CutsMenu.ts`, `model.ts` (`Cut.updatedBy`, `Cut.color`), `from-carton.ts`, `scripts/carton/ui.js` (the queued switch) | Matches `after/cuts-menu-384.png` / `-300.png`, `after/cuts-menu-turn-384.png`. Before: `before/real/09-cut-menu-2cuts.png`. Tests: one Fold entry however many cuts; a queued switch runs once at the turn's end and is dropped if the person switches by hand first |
| 6.2 | **A teammate's cut, viewed:** History shows its versions with "Fold into Main cut…" and "Copy as a new cut"; no Restore | `HistoryPanel.ts`, `scripts/carton/ui.js` | Matches `after/history-teammate-cut-384.png` ("New cut from it", no Restore) |
| 6.3 | **Fold dialog:** From/Into pickers, the line on what happens, change rows with tick boxes (`ChangeRow`), a lock for "Can't be left out", "Left out on Oct 30", inline pick rows for conflicts, the footer's left-out line, the counted primary button, and the nothing-to-fold state. Focus starts on the dialog | `react/src/components/FoldInDialog.ts`, `scripts/carton/ui.js` | Matches `after/fold-all.png`, `fold-some.png`, `fold-conflict.png`, `fold-rest.png`, `fold-nothing.png`. Before: `before/real/11-fold-dialog-after.png`. Existing fold tests pass (partial, rest, stale picks) |

## Workstream 7: conflict cards (needs 0.5; independent of 2–6)

| # | Change | Files | Acceptance |
|---|---|---|---|
| 7.1 | **Sides as a radio group** that only picks, starting on the side shown. **See it** on each side views it (kind `conflict`, with the frame label). One primary button that names the pick. On timeline. Not now | `react/src/components/ConflictCard.ts`, `scripts/carton/ui.js` (See it → `ui.view`) | Matches `after/conflict-card.png`, `after/editor-conflict-theirs.png`, `conflict-same-person.png`, `conflict-keep-both.png`, `conflict-during-turn.png`. Tests: picking a radio never changes `viewing()`; See it does; no two buttons on a card share a label (existing rule) |
| 7.2 | **One card at a time**, with "1/2 ›", and the pill "N conflicts to pick". No set-aside list | `react/src/components/ConflictStack.ts` | Matches `after/conflict-pill.png`. A card resolved elsewhere leaves (existing test) |
| 7.3 | **During a turn** (0.7): the line; a pick on changed values asks again (the existing `sig`) | `ConflictCard.ts` | Test with a mock turn |

## Workstream 8: Share dialog and Join (independent)

| # | Change | Files | Acceptance |
|---|---|---|---|
| 8.1 | **Share dialog** opened by the strip's Share icon, in place of the Share tab: not shared, invite code when asked, errors at their field (keep `shareProblem`), shared (People with roles and their agents, Invite with role and Copy link, status), offline | `scripts/carton/sync/ui.js` (`SharePanel` → `ShareDialog`), `scripts/carton/ui.js` (`Sidebar` tabs, `CartonSide` command), `react/src/components/ui.ts` (`Dialog`) | Matches `after/share-first.png`, `share-owner.png`, `share-offline.png`, `share-unreachable.png`. Before: `before/gallery/share-empty-384.png`, `share-owner-invite-384.png`. Existing `shareProblem` tests pass |
| 8.2 | **Join and open**: one button | `scripts/carton/sync/ui.js` (`Join`), `scripts/carton/ui.js` (`JoinDialog`) | Matches `after/join-dialog.png`; the joined project opens in its tab (bridge test). The empty-library case still holds (N1 test) |
| 8.3 | **Compact footage notice** and the offline chip's words | `scripts/carton/ui.js` (`MediaNotice`, `LiveChipView`) | Matches `after/stage-live-media.png` |

## Workstream 9: Comments, and what was built but never mounted (independent)

| # | Change | Files | Acceptance |
|---|---|---|---|
| 9.1 | **Comments:**
  - drop the second heading;
  - "Add a note at 0:13…";
  - times as "0:06";
  - "That moment changed since. See it as it was" (views the version it was made on: 0.5) | `react/src/comments/CommentsPanel.ts`, `comments/words.ts` | Matches `after/comments-384.png` / `-300.png` |
| 9.2 | **Credits** through History's "Only “clip”" filter (0.8) | `HistoryPanel.ts` | The filter shows the credit lines at its top |
| 9.4 | **Small fixes found while capturing** (AUDIT R3, R4, R7, R8): field error and focus borders that exist in Cardboard's CSS (use its own classes or inline styles); title-bar avatars spaced so initials show; the minute clock read on first subscribe (Preact first render); retire `gallery/screens.mjs` for the capture rig | `scripts/carton/sync/ui.js`, `scripts/carton/strip-buttons.js`, `react/src/hooks.ts`, `react/gallery/` | Shots `share-unreachable`, `titlebar-shared` show the border and readable initials; a Preact test renders "1 min ago" on first render |
| 9.3 | **Teammates' drags on your timeline** (`GhostLayer`): needs the timeline hook from 1.5 plus the timeline's time→x and track bands. Ship it only if the hook gives both without a second anchor; else leave it for its own design review | `scripts/patch-carton.js`, `scripts/carton/ui.js` | With two instances shared: the other's drag shows as a ghost; nothing when not shared |

## Order and parallelism

```
Week 1   0.1 0.2 0.3 0.4 0.5   (one engine implementer; words first, then changes, groups, viewing)
         3.x 4.x 6.x 7.x on the mock (four component implementers, in parallel)
         2.x 8.x                (one integration implementer: strip + Share dialog)
Week 2   1.x (needs 0.5)  5.x (needs 0.6)  9.x
         wire 3/4/6/7 to the real view model; capture rig after-shots at 384/300; README + patch comments
Week 3   real-app verification on the Windows laptop (with the user's permission), fixes
```

These can each go to their own implementer at once:
- the engine and words (0);
- History list and card (3);
- Changes and Play (4);
- cuts and Fold (6);
- conflict cards (7);
- title bar and Share (2 and 8);
- viewing (1, once 0.5 lands).

The components share `ChangeRow` and `ChangeMap`. Workstream 3 owns them; 4 and 6 import them, and stub them until 3
lands.

## What to verify in the real Windows app at the end

Do this only at the end, on the user's laptop, with their permission. Use a separate profile and library
(`CARDBOARD_USER_DATA`, `CARDBOARD_HOME`) and DevTools (`scripts/cdp.js`), on mains power.

1. **No surprise takeovers.**
   - A click, Enter or double-click on any History row doesn't change the stage.
   - Play on an older version does. The chip, the frame and the row mark appear together, with one label, and nothing
     covers the picture.
   - Each of these brings your edit back, with the playhead where it was: Esc (also with a clip selected before), the
     chip's ✕, the row's ✕, closing the panel, and switching tab.
2. **Play on the newest agent turn** plays on your edit (no frame or tag), and the editor's playhead follows each change.
3. **Before:**
   - Holding it flips the stage at the same moment, and releasing it comes back. Frames are real (the editor's player).
   - Measure the flip time on a long project; a second agent re-checks it before it is quoted.
4. **An edit tried while viewing** (drag a clip, Enter on a title, Delete, Ctrl+Z):
   - It shows the one-line toast and the frame pulse, never Cardboard's refusal, and changes nothing.
   - Back to my edit then lets the same drag work.
   - **Export** opened while viewing exports your edit.
5. **The cut chip:**
   - It shows the cut on every project tab with the panel closed.
   - `cb cut switch` from a terminal updates it.
   - Its menu works with the mouse and the keyboard.
   - At 960 px nothing overlaps.
6. **A conflict card** made the way the audits made one (a drag and a Claude Code view save on the same title):
   - picking Claude Code's side changes nothing on the stage; its See it shows it, with the frame's label;
   - Keep Claude Code's keeps it;
   - the toast's Undo takes it back.
7. **Fold some and then the rest** across two cuts. The dialog's counts agree with History's rows and `cb history`.
8. **Restore** with its confirmation; the toast's Undo; Ctrl+Z of a restore shows "Undid: …".
9. **Share** between two instances:
   - the dialog's People shows the other person and their Director;
   - offline shows the amber line and the stage chip;
   - Join and open from an empty library opens the project.
10. **Keyboard only, then a screen reader (Narrator):** every flow above; the viewing state is announced once.
11. **Carton off** (`CARDBOARD_CARTON=0`): no chip, no frame attribute, and Cardboard's own refusal toast.
12. **Performance:**
    - a 12,000-version project: History opens and scrolls smoothly;
    - Play holds the editor's frame rate;
    - measured against the current build with `scripts/bench/run.js`, alternating builds, medians and every run
      reported, and re-checked by a second agent before any number is quoted.

## Target scores

| Region | Now | Target |
|---|---|---|
| Watch the changes → Play and Before in the change list | 2 | 9 |
| Preview banner → viewing (chip, frame, row) | 2 | 9 |
| Compare card → Changes view | 3 | 9 |
| Where am I (cut chip) | 3 | 10 |
| Agent turn holds | 1 | 8 |
| History list | 5 | 9 |
| Row menu and actions (restore, new cut, undo turn) | 5 | 9 |
| Cuts menu | 4 | 9 |
| Fold in | 6 | 9 |
| Conflict cards | 5 | 9 |
| Toasts | 5 | 9 |
| Share | 5 | 8 |
| Join | 6 | 9 |
| Stage status | 6 | 8 |
| Title bar | 6 | 9 |
| Comments | 6 | 8 |
| Credits, ghosts (unmounted) | 0 | 7 |

Each target is reached only when its rows' acceptance holds in the real app (the list above). A screenshot alone is not
enough.
