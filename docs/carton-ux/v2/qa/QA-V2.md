# Carton v2: design QA of the built UI, and its fixes

**What was judged:** `origin/feat/carton-ux`, from `bbb9d771` (History v2: N2) through `6f5c00d6` (N2b, Bring back on
N0b), `0a51cbda` (N1, Compare in the editor), `f2136b1c` (N2c, another cut's versions in pick mode) and `54954c6c` (N1b:
Play both waits, the row detail, the new ways into Compare). Every builder's work is in.
**Against:** `origin/design/carton-ux-v2` @ `68d40da1`, `docs/carton-ux/v2/DESIGN-V2.md` and its mockups in
`docs/carton-ux/v2/after/`. The first design (`design/carton-ux`) and the first QA (`design/carton-ux-qa`,
`docs/carton-ux/qa/QA.md`) still hold where v2 says nothing.
**For whom:** a video editor who has never used version control. The user's asks: *"make version stuff as much easy
for the end user as possible"*, and the complaints DESIGN-V2 §0 lists (a messy History to roll back from, a git-like
diff of any two versions, Compare congested in the panel, comparing separate cuts, the agent opening Compare).
**By:** a design QA reviewer who neither designed nor built it. The fixes are on `fix/ux2-qa` (`18cb7a60`).

**How:** the capture rig (`carton/packages/react/gallery/capture`, `npm run screens`) renders the real components with
Cardboard 1.4.0's own CSS and fonts, on React and on preact/compat. Every History state was shot at 384 and 300 px,
and the editor compositions at the mockups' 1522 × 810, 1250 and 1100 px. N2's and N1's rig states were used as they
are; `states/qa2.js` and `states/qa2.shots.mjs` add the states they didn't reach: search cleared and with a filter,
each Go back… choice, Bring back's confirmations and toasts, a past day opened, Another cut, pick mode with search,
and the editor around them. Shots beside the mockups are in `shots/`. Bugs that only a real browser shows were
reproduced in headless Chromium with scripts (`rig/` in the scratch copy) before they were fixed.

**Scores are from renders.** They are a ceiling until the Windows checks in §5 pass.

## 1. Verdict

- **The user's four complaints are answered on screen.**
  - *A messy History to roll back from:* landmarks (Exported, Sent, Named, Before, Start) with pictures, folded days
    that keep their landmarks, search, hold-to-peek, and **Go back…**, which puts the four ways back side by side with
    what each does. Nobody restores a whole edit when they meant one clip.
  - *A git-like diff of any two:* **Compare** on the stage, with the change list in the panel and marks on Cardboard's
    own timeline. Pick mode compares any two rows, and N2c any version of any cut.
  - *Compare congested in the panel:* gone. Compare takes over the stage: Side by side, Wipe or Flip, Play both, and
    the panel is only the list.
  - *Separate cuts, and the agent opening it:* both work, and both name both sides.
- **Fidelity to the mockups is high** for N2's History and N1's Compare. Most differences are the rig's data, not the
  build.
- **What I found and fixed tonight** (§3):
  - a bring-back's row read as the plain change it undid, in the real view model;
  - a Before landmark couldn't say which restore it kept;
  - "↑ Newest" stuck over search results; the search's clip credits ran to five lines at 300 px;
  - a held row's chip named the version plainly, not its landmark and "holding";
  - Compare's list wasn't in timeline order, and Play both sat at the stage's foot, far under the pictures;
  - the timeline legend squeezed the timecode in a narrow window;
  - across cuts, another cut's version was "an earlier version" three times on screen, Fold in named that version
    though it folds the cut, and the count gave one length.
- **N1b closed Compare's last design gaps**: Play both waits and shows slates, the list's row detail (Then / Now, Bring
  back or Take out), a playing card's ⇆ Side by side, Fold in's See them side by side, a teammate cut's Compare with
  Main cut.
- **What stops it short of 10/10:** landmark titles cut off at 300 px (G9), past days not folding their runs (G10),
  the few open gaps in §4, and everything in §5 that only the real app can judge.
- **Overall: History about 8.5/10, Compare about 9/10 on renders**, up from about 7.5 and 7.5 as they came in.

## 2. Scores, before and after the fixes

Scores out of 10, for a newcomer editor. "Before" is the build as it came in; "after" is `fix/ux2-qa`.

| Region | Before | After | Why |
|---|---|---|---|
| **History: landmarks, Landmarks filter, folded days** | 7 | 8 | Tags, pictures, "41 versions · 4 landmarks", the filter: as designed. Before, two restores' safety points both read "BEFORE Restoring an earlier version", and a bring-back's "BEFORE Bringing back a clip". Fixed: "Restoring the 11:02 am version", "Bringing back “B-roll 3”". Open: titles cut at 300 px (G9), past days don't fold their runs (G10) |
| **Search: results, empty, clearing** | 7 | 8.5 | Debounced, newest first, the clip first with Only this clip, each row says why. Before, a search from a scrolled list kept "↑ Newest" over results already at the top, and after Clear search. Fixed, and the clip's credits now take two lines at most (G12). Open: no "Search every cut" (G13) |
| **Hold to peek** | 7.5 | 8.5 | "Holding" in the row, the frame and chip while held. Before, the chip named the version plainly ("Your edit from 11:52 am") while the row said Holding. Fixed: "Exported 1080p for the client · holding" (G19). The hint is a native tooltip: the real app decides it |
| **Go back… (each choice, a clip selected)** | 8 | 9 | Four choices smallest first, nothing picked, "Choose one", each button names its action, "Ctrl+Z undoes any of these", a selected clip picked. Before, at 300 px the wrapped row put the named action alone on the right, over Cancel. Fixed |
| **Bring back one clip (list, confirm, changed again, toast)** | 7.5 | 9 | N2b brought place, ripple and the "changed again" refusal. Before, in the real view model the new version's row read "Trimmed “Intro”, now ends at 0:05": the change it undid, so a bring-back couldn't be told from an edit. Fixed: "Brought back “Intro” from 10:20 am" / "Took out “Drone shot”" |
| **⇆ Compare menu and pick mode** | 7 | 8.5 | The questions people ask, with pictures; pick mode with the From pill and ⇆ Compare on every row; search works while picking. At 300 px the menu ran out of the panel's left edge (N2c fixed it at the same time). N2c's another-cut picker reads well |
| **Cuts, viewing, toasts, conflict cards** | 8.5 | 8.5 | No regressions from v2: chip, frame, row mark, toasts with Undo, conflict cards, the cuts menu |
| **Compare: Side by side** | 8 | 9 | Close to the mockup. Before, Play both sat at the stage's foot, far under the pictures at 1522 × 810, and the list was in the engine's order (0:12 before 0:07). Fixed |
| **Compare: Wipe** | 8.5 | 8.5 | The line, the corner labels, the hint |
| **Compare: Flip, Flip only** | 8 | 8 | Hold B, the blue tag, the pill. While B is held the timeline is the left side's, so its marks go (G15: the spec should say so) |
| **Compare: the marks, the strip, the legend** | 7.5 | 8.5 | Every mark kind, the strip, tags. Before, the legend followed the window's width (a 900 px media query): in a 1100 px window it stayed in a timeline far narrower than 900 px. Fixed: the timeline's own width |
| **Compare: chip and the ways out** | 9 | 9 | One label everywhere; Esc, ✕, Done comparing, ← History |
| **Compare: an edit tried** | 9 | 9 | One line in Compare's words, Done comparing, Esc, the pulse |
| **Compare: narrow windows, the drawer** | 7.5 | 8.5 | Flip at 1250, Flip only at 1100, icons, "Done", the frame's own label. The legend fix is what moved it |
| **Compare: across cuts** | 6 | 8 | Opened from the cuts menu, Another cut and N2c's picker. Before, another cut's older version read "“30s Instagram cut” (an earlier version)" in the chip, "(an earlier version) · an earlier version" in the range line, and in Fold in's button. Fixed: "Comparing “30s Instagram cut” at 1:53 pm with Main cut now", and the count gives each cut's length (G14) |
| **Compare: agent-opened, idle and busy** | 9 | 9 | Idle: it opens, one toast says who. Busy or viewing: never replaced, an offer with Open |
| **Compare: the change list** | 7.5 | 9 | The range in words, the count, ▶ on a row, now in timeline order (G4). N1b's row detail: Then / Now in words, Bring back “Summer sale” or Take out, and what it does |
| **Compare: Play both (N1b)** | 8.5 | 9 | The shorter side holds and says "waiting"; a shot only one side has gets a slate on the other, in every mode (N1b's tests). Play both now sits under the pictures (G5). The rig's stand-in player can't show the wait itself: the real app does |
| **Compare: the ways in (N1b)** | 8 | 8.5 | See them, ⋯ Compare with your edit / with…, Shift+click, ⇆ Compare, the cuts menu, N2c's picker, and N1b's playing card's ⇆ Side by side, Fold in's See them side by side (with Back to Fold in…) and a teammate cut's Compare with Main cut |

## 3. Gaps fixed on `fix/ux2-qa`

Each with a test where it's behaviour; every one shot before and after in the rig.

| # | Gap | Fix | Proof |
|---|---|---|---|
| G1 | **A bring-back's row read as the change it undid** in the real view model ("Trimmed “Intro”, now ends at 0:05"): `from-carton.ts` had no words for core's `bring-back` title | "Brought back “Intro” from 10:20 am" (the version's name or time), or "Took out “Drone shot”" when every row is a removal, as the toast says it | `ux2-n0.test.ts`: fails on the old code with exactly that summary |
| G2 | **"↑ Newest" stuck over search results** that start at the top, and after Clear search: History's list unmounts while a search loads, and its host never heard it wasn't scrolled | `VirtualList` tells its host on unmount | Reproduced in Chromium (pill shown at scrollTop 0), gone after; `history-v2.dom.test.ts` "search from a scrolled list" |
| G3 | **Before landmarks couldn't say which restore** they kept: every one read "Restoring an earlier version" or "Bringing back a clip" | Its title comes from the row after it: "Restoring the 11:02 am version", "Bringing back “B-roll 3”" (`words.safetyTitleOf`) | `history-v2.dom.test.ts` landmarks; shot `landmarks-before-title` |
| G4 | **Compare's list wasn't in timeline order** (the engine's is by clip): 0:12 "Removed “B-roll pier”" above 0:07 | Sorted by place, stable, no-place last; ↑↓ follow it | `compare-view.dom.test.ts` |
| G5 | **Play both sat at the stage's foot**, far under the two pictures at 1522 × 810 | Side by side lays the pictures and Play both out as one block in the middle | shot `compare-side-by-side` before/after |
| G6 | **The legend squeezed the timecode** onto three lines in a 1100 px window: it hid by window width (≤ 900 px), not the timeline's | It shows only when the timeline's toolbar row is 900 px or wider (DESIGN-V2 §1.6). Cardboard's timeline region is `display: contents`, so the row is measured | `compare.test.js` §1.6, a narrow and a wide toolbar row |
| G7 | **Another cut's older version was "an earlier version"** in the chip, twice in the range line, and in "Fold in changes from “30s Instagram cut” (an earlier version)…", though Fold in folds that cut as it is now | `openCompare` reads that version from its cut's History before naming the sides: "Comparing “30s Instagram cut” at 1:53 pm with Main cut now"; the range line "“30s Instagram cut” · 1:53 pm / with Main cut · your edit now"; Fold in names the cut | `compare.test.js` "N1 with N2" |
| G14 | Across cuts the count gave one length ("7 differences · 0:38"); §1.12 gives each cut's | The panel's count gives both, left first: "7 differences · 0:30 and 0:36" | `compare.test.js` §1.1 |
| G12 | The search's "“Intro”, the clip" credits ran to five lines at 300 px and pushed the results below the fold | Two lines at most, the whole on hover (the clip filter's card keeps them whole) | shot `history-search` |
| G19 | **While a row was held to peek, the chip said the version's plain label** ("👁 Your edit from 11:52 am"), not its landmark and "holding" (§2.4) | `usePeek` takes `labelOf`: the row's landmark as one phrase plus " · holding"; a view of a row given with its own label keeps it (from-carton and the mock; a ref's label, as Comments' See it as it was gives, is unchanged) | `history-v2.dom.test.ts` peek, `ux2-n0.test.ts` |
| G8 | **Go back…'s and Bring back's actions** at 300 px: the named action alone on the right, over Cancel | Left-aligned when they wrap | shot `bring-back-confirm-300` before/after |
| — | Two rig shots broke when ⋯ entries started opening Go back… (`after-toast-newcut`, `history-restore-error`) | Their steps go through Go back… | the rig, both runtimes |

N2c fixed the Compare menu's clipping at 300 px at the same time as I did; its CSS was kept.

**Review:** one round by a fresh reviewer (Opus 5.5; the Codex accounts were out). It found five, all fixed with
tests: a Before's title cut a clip name that has " from " in it ("Bringing back “View"); across cuts the second length
was always your edit's, even when the right side is an older version; openCompare waited for a read on every open and
a close during another cut's read didn't cancel it (now only another cut's version waits, and a close wins); an earlier
day's moment read "“30s Instagram cut” Oct 30 at 4:10 pm" (now "on Oct 30 at 4:10 pm"); a peek on an export lowered
its label's first letter.

## 4. Open gaps, by impact, with their exact fixes

**N1b's four items** (built by N1b, judged here, not changed by me): Play both's wait and slates are as §1.4 says in
N1b's tests (`compare.test.js` "N1b §1.4", `compare-view.dom.test.ts` slates); the rig's stand-in player doesn't
render the wait, so it is on the real-app list (§5). The row detail matches the mockup; its line is longer than the
mockup's ("It goes back to how it was at 12:05 pm: its timing, text, look and settings. Nothing else moves. Ctrl+Z
takes it back." against "Only this title changes. Ctrl+Z takes it back."), which is accurate and reads fine at 300 px.
The playing card's ⇆ Side by side opens Compare between the version before and the version, still playing. Re-measuring
Play both is N1b's.

**Mine to list (too big, or not mine, tonight):**

| # | Gap | Impact | Exact fix |
|---|---|---|---|
| G9 | **Landmark titles are cut at 300 px** ("EXPORTED 1080p for th…", "BEFORE Restoring the 11:…"). DESIGN-V2 §2.1: "Below 340 px a landmark's title wraps to two lines rather than losing its words to the tag" | Medium: at the narrowest panel the moments people look for lose their words | Rows are fixed-height virtual rows, so a wrap needs a taller row. Tried tonight and reverted: every landmark row 18 px taller under 340 px (a ResizeObserver on the panel, `heightOf`, `layoutKey: { rows, wraps }`, `grid-template-rows: 36px 16px` and a two-line clamp): short titles left a gap, and in the rig Today's rows went missing at 300 px after the re-layout. The fix that holds: (1) in `HistoryPanel`, decide per row whether its title overflows: `landmarkTitle`'s text width with Cardboard's 13 px font, measured once per (title, panel width) with a canvas `measureText` cached in a Map, against the title column's width (panel width − 22 − 8 − the time column); (2) only those rows get `LANDMARK_WRAP_ROW_HEIGHT` in `heightOf` and `data-wrap`; (3) find why VirtualList drops the rows above a row whose height changes when `layoutKey` changes (its anchor keeps `into` from the old tops) and test it in `history-v2.dom.test.ts` at 300 px |
| G10 | **An opened past day lists every version** instead of its landmarks with one line per run between them ("› 18 changes by You and Claude Code", §2.5) | Medium: yesterday's 23 rows are noise when looking for a moment | In `history-groups.ts`, a past, opened day becomes: each landmark row, and between two landmarks a `run` row (`{ kind: "run", ids, authors }`, words "N changes by A and B") that opens in place like a group. Today is never folded this way |
| G11 | The mock's bring-back row still says "from an earlier version" (gallery only: the real view model is fixed by G1) | Low: rig only | `mock-find.ts` `restoreClip`: summary `Brought back “X” from ${clockOfDay(version.at)}` |
| G13 | Search's empty state has no "Search every cut" (§2.3) | Low | `HistoryPanel` empty-search: a `carton-link` "Search every cut" that re-runs `find(q, { allCuts: true })`; each hit's meta line gets its cut's dot and name |
| G15 | While B is held in Flip, the timeline's marks, strip and legend go. That is right for what's on screen: Flip swaps the editor's timeline to the left side too (Before's swap), and the marks are placed on the right side's clips. The mockup keeps them | Low: a flick, and the list stays | No code change. DESIGN-V2 §1.3's Flip row should say "While held, the timeline shows the left side as well; its marks come back on release" |
| G16 | The pinned day header says "Today" for about one header's height after yesterday's rows reach the top | Low | `HistoryPanel` `stickyAt`: use the row under the header's bottom edge (`scrollTop + 32`) for `topRow`, not `scrollTop` |
| G17 | A removed caption's ghost has no name when the clip is narrow (mockup: "our new" in red) | Low | `CompareMarks`: draw the ghost's name when it's at least 24 px wide (the tag's 36 px rule is for tags) |

## 5. What only the real Windows app can judge

- **The second player:** ready within 2 s, the Flip-only fallback on a real failure, GPU memory, Play both in step on
  real footage (a side holding its last frame with "waiting", the slates: the rig's stand-in can't show them), and no cost while not comparing (DESIGN-V2 §6; N1's FEASIBILITY.md §5). On mains power, the NVIDIA GPU
  checked (AGENTS.md).
- **The marks on Cardboard's canvas timeline:** their places on real clips, at zoom and scroll; the legend's hiding on
  the real toolbar row (G6 measures `.justify-between`, the rig's stand-in has the same structure).
- **Hold to peek:** the 300 ms hold against a real stage swap, and the native tooltip "Click to open · hold to peek".
- **Landmark pictures** made from the real stage, and never during playback or export.
- **The agent's `cb compare --show`:** idle detection with real keys and mouse, the offer toast while busy.
- **Bring back's place and ripple** on a real project: a new track above when the place is taken, the rest moving 3 s.
- **Another cut's History** read a page at a time on a long cut (N2c), and G7's one-version read before Compare opens.
- **Fonts and sizes at 125 %**, Windows' caption buttons, and the 960, 1100 and 1522 px windows.

## 6. React and preact/compat

The whole rig (every state of every workstream, 319 shots a runtime) was shot on both from `fix/ux2-qa`'s final code
and compared pixel by pixel (a pixel counts when a channel differs by more than 16). The pairs that differ are all
things caught at another instant, as in the first QA:
- a playhead or progress line mid-playback (`editor-before`, `editor-viewing`, `editor-play-newest`,
  `after-history-viewing`, `tip-before`, `tip-viewing-x`, `ws1-editor-*`);
- the frame's pulse on an edit tried, an animation (`n1-edit-attempt`, `ws1-editor-edit-attempt`);
- a text caret (`ws6-cuts-new`).

Six shots fail on both runtimes, the same way: the retired in-panel Changes view's (`changes`, `changes-playing`,
`changes-before`, `changes-none`, `changes-two`, `changes-play-older`). Their steps open it through "Compare with your
edit" or Shift+click, which now open Compare in the editor (DESIGN-V2 §1.2, N1), so the view they wait for never comes.
That is the design; the rig's WS4 list in `shoot.mjs` should drop them, or open them in a scenario without the host's
Compare, as DESIGN-V2 keeps `ChangesView` in the gallery for one release.

Tests on the final code: the full `npm run typecheck`; `npm test -w packages/react` on React and on preact/compat;
`compare.test.js`, `viewing.test.js`, `panel-polish.test.js` and `cut-chip.test.js`; all pass. The history bundle stays
within its 32 KB budget (nothing was added to `packages/core/src/history/`).

## 7. Shots

In `shots/`, each with its mockup beside it where one exists. 384 and 300 px panels, 1522 × 810 editor.

| File | Shows |
|---|---|
| `history-landmarks.png` | Landmarks at 384 and 300 beside the mockups; G9 visible at 300 |
| `landmarks-before-title.png` | G3: the Before titles after the fix, after a restore and after a bring-back |
| `history-search.png` | Search: results, 300 px, empty, beside the mockups |
| `search-newest.png` | G2: the editor with "intro" searched, before (↑ Newest over the results) and after |
| `history-goback.png` | Go back…: nothing picked, a clip selected, Restore picked at 300, beside the mockups |
| `bring-back.png` | The clip list and the confirmations (deleted, taken out, changed, changed again), beside the mockups |
| `bring-back-confirm-300.png` | G8 before/after |
| `bring-back-toast.png` | The editor after Bring back: the toast and the row (G1's words are the real view model's) |
| `compare-menu.png` | ⇆ Compare menu at 384 and 300, Another cut, pick mode, N2c's picker |
| `compare-side-by-side.png` | G4 and G5: before and after, beside the mockup |
| `compare-modes.png` | Wipe, Flip, Flip only, beside the mockups |
| `compare-narrow.png` | 1250 and 1100 px windows, the drawer hidden |
| `compare-cuts.png` | Across cuts: the cuts menu's Compare (G14's two lengths), and G7 before/after (opened from N2c's picker in a scenario with no second player, so Flip only) |
| `compare-agent.png` | Agent-opened, idle and busy; the edit attempt |
| `compare-n1b.png` | N1b: the row detail at 384 and 300 beside the mockups, a playing card's ⇆ Side by side, Play both after G5 |
