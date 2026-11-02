# Carton UI fixes: real-app check on Windows (2026-11-02)

> Pushed from the laptop on 2026-11-02 (step 2 on `out/carton-rc` @ `12826273`). `shots/` here holds only the shots for the new bugs: the P2s, the P3s that name a shot, the PARTIAL/NOT FIXED rows'\'' shots, and the "Not counted" case. Every other shot named below is in the full set, which stays on the laptop at `D:\cbwork\regress\ui\shots\`.


**Build:** `out\carton-rc\Cardboard-win` (`build-info.json`: commit `1282627`, carton true), with `CARDBOARD_CARTON=1`.
**Machine:** Windows 11 at 125 % scaling.

**Instances and window:**
- Each instance ran with its own `ui-*` profile and DevTools port:
  - `ui-a` on 9390: owner "Vikas", History tests.
  - `ui-b` on 9391: teammate "Leo".
  - `ui-large` on 9392: a copy of `large-src`.
  - `ui-days` on 9393.
- Every window was set to the audit's size, 1920 × 1020, which gives a 1522 × 770 CSS page, the same as the audit's shots.
- The local host ran from the repo on 8795.

**Input and authors:**
- Input went only through DevTools: mouse and key events, plus page reads.
- "You" came from mouse drags, or from `cb` with all `CLAUDE*`/`ANTHROPIC*` variables removed (my shell had `CLAUDECODE=1` set).
- "Claude Code" came from `cb` with `CLAUDECODE=1`, and "Director" from `cb` with `CARDBOARD_ACTOR=director/regress`.

**Deviations from the brief:**
1. **Window size.** Electron doesn't implement `Browser.getWindowForTarget`, and the audit's `os-win.ps1 place` sends a mouse nudge and brings the window to the front. Instead I used `size.ps1`, which only calls `SetWindowPos` with `SWP_NOZORDER|SWP_NOACTIVATE`: no input, no focus change.
2. **History over several days.** `large-src` holds 151 versions, all made today, so it can't show day groups. I built a project on a fresh `ui-days` profile with the app closed. Only my own `cb` processes got a shifted `Date` (`faketime.js` preloaded through `NODE_OPTIONS`). The system clock was not touched. `cb history` confirms the stored dates: Oct 30: 54, Oct 31: 50, Nov 1: 50, Nov 2: 10.
3. **Teammate on the same PC.** Both people ran on one PC under one Windows user, so their actors share `group: local:vikas@V-LAPTOP`. One result depends on that; see the notes at the end.

Screenshots are in `D:\cbwork\regress\ui\shots\` (17 MB). An `<audit-id>-after.png` pairs with the audit's `<audit-id>.png` in `D:\cbwork\ui-audit\shots\`. A `w-*.png` is an extra working shot, and a `bug-*.png` is evidence for a new bug.

---

## Table A: ui-history

| Item | Result | Evidence | After shot ↔ audit shot |
|---|---|---|---|
| **P1-2** sharing words | **PASS** | Owner's History reads "Linked 'clip.mp4' for sharing · You". The teammate's reads the same row "· Vikas". No hash on either side. | `38-A-teammate-edit-in-history-after.png` ↔ `38-A-teammate-edit-in-history.png`; `30-B-history-after.png` ↔ `30-B-history.png` |
| **P1-2** effects are named, never an id | **PASS** (with a P3) | Effects layer: "Added track 'Track 3' and shader 'Vignette'". A second effect on a clip: "Added effect "sharpen" on 'clip.mp4'". No id appears anywhere. But the *first* effect on a clip that had none reads "Changed 'clip.mp4' effect", without the effect's name (new P3-1). | `w-16-effect-added.png`, `02-history-authors-after.png` |
| **P1-3** a partial fold is one row | **PASS** | Main shows one row: "Folded 'Client review' into 'Main cut': 2 of 3 changes · You". Its "2 changes" lists only the clip move and W2's text, and W4 stays 100 on Main. `cb history` shows `main@5 person merge (1 left out)`, and the JSON has `leftOut: [timelineItems/…]`. The fold is now credited to the person, not "Terminal". | `14-main-after-fold-after.png` ↔ `14-main-after-fold.png`; `12-fold-some-after.png` ↔ `12-fold-some.png`; `11-fold-dialog-after.png` ↔ `11-fold-dialog.png` |
| **P1-4** "Left out earlier", fold it in, Undo | **PASS** | From Client review, the Fold dialog lists "Changed 'W4' font size 100 → 60 · Left out earlier · Claude Code". Fold in sets Main's W4 to 60, with a row "Folded the rest of 'Client review' into 'Main cut': 1 change". Undo brings W4 back to 100 (`cb`: `main@7 person undo`), and the dialog offers the change again. | `52-fold-again-after.png` ↔ `52-fold-again.png`; `w-07-main-after-rest.png`; `w-10-fold-offered-again.png` |
| **P1-5** Restore row and "N changes" | **PASS** | The row reads "Restored an earlier version · You · 2 changes". "2 changes" expands to "Moved 'clip.mp4' 2.0 s → 0.0 s" and "Changed 'W2' text …". The toast reads "Restored the version from 4:36 PM. It's saved as a new version." A multi-change row reads "Moved 'clip.mp4', changed 'W2'". | `18-restore-confirm-after.png` ↔ `18-restore-confirm.png`; `w-11-after-restore-toast.png`, `w-12-restore-expanded.png` |
| **P1-6** Preview of the agent's side shows its side | **PASS** (preview). Credit: see new P2-1. | Audit's actor (`CARDBOARD_ACTOR=claude-code/cardtest`): the card reads "You / Claude Code". Preview of Claude Code's side gives "Previewing Claude Code's edit", with W6 at 9–10 s and the playhead at 00:00:09.000. Return to current puts W6 back at 7 s. Your own side is "Showing now", so it has no Preview button. With `CLAUDECODE=1` the preview is also right (9 s), but both sides read "Your earlier edit / Your later edit" (new P2-1). Still open from the audit's second fix bullet: in read-only preview W6 keeps its selection handles, and the left panel keeps its edit presets (P3-9). | `41-card-preview-after.png` ↔ `41-card-preview.png`; `w-15-card-cc.png`; `40b-agent-card-crop-after.png` (the `CLAUDECODE=1` card) ↔ `40b-agent-card-crop.png` |
| **P1-10** Agent turns: Director and Claude Code | **PASS** | "Agent turns" lists "CHECKPOINT Changed 'W4' font size 100 → 60 · Claude Code · 1 edit" and "CHECKPOINT Changed 'W2' text … · Director · 1 edit". Not run: real in-app turns, so turns named from the prompt weren't seen. | `05-filter-director-after.png` ↔ `05-filter-director.png` |
| **Undo right after Restore** | **Works: PASS. Names the restore: FAIL** (P3-2) | Undo brings back the clip at 2.0 s, W2 and W4 (`cb`: `main@9 person undo`). But nothing on screen names the restore. The toolbar tooltip is plain "Undo Ctrl+Z", there's no toast, and the new row reads "Moved 'clip.mp4', changed 'W2'", like a fresh edit. Cardboard's build doesn't mount Carton's `UndoTurnButton`, so there is no "panel's Undo" to carry a name. | `w-13-undo-after-restore-tooltip.png` |
| Root row (audit's "already known") | **PASS** | On "Started the cut", Restore is now disabled, and Preview and "New cut from here" are gone. | `54-oldest-row-menu-after.png` |
| New track named, fold credit | **PASS** | "Added track 'Text 1', moved 'W6'". The partial fold and "fold the rest" are credited to `person` in `cb history`. | `40-agent-card-after.png` |

## Table B: ui-polish, rounds 1 and 2

| Audit id / checklist item | Result | Evidence | After shot ↔ audit shot |
|---|---|---|---|
| **P1-1** Share tab with a teammate present | **PASS** | Share tab open on A and on B with the other present. No "hit a snag" on either side after about 10 s plus rechecks. A lists "Leo · Editing", and B lists "Vikas · Editing". (One run per side; the audit's crash reproduced 3 of 3.) | `36-A-share-peer-after.png` ↔ `36-A-share-peer.png`; `37-B-tab-crash-peer-after.png` ↔ `37-B-tab-crash-peer.png` |
| **P1-7** Watch: Before/After inside the panel | **PASS** | At 384 px, Before/After spans x 778–890 inside a panel at 754–1138. At 300 px (drag on the panel's "Resize" separator), it spans 862–974 inside 838–1138. Nothing in the Watch view crosses the panel's edges. | `16-watch-after.png`, `16-watch-300-after.png` ↔ `16-watch.png` |
| **P1-8** Share failure says "Can't reach this address" | **PASS** | With host `http://127.0.0.1:8799`, the address field shows "Can't reach this address. Check it, and that the sharing server is running." No token field, no native bubble, no "fetch failed". | `25-share-fetch-failed-after-result.png` ↔ `25-share-fetch-failed.png`; `24-share-token-required-after.png` ↔ `24-share-token-required.png` |
| **P1-9** Join → Open: no "Missing Media Files" | **PASS** | B: Dashboard tile → Join → **Open**. No dialog. The clip plays from its preview copy (colour bars on the stage), and a notice reads "This video plays from preview copies. Its originals stay on your teammate's computer." Control case: one of my own originals (`--no-copy`) renamed still gets Cardboard's "Missing Media Files" (Relink / Back / Remove and Open), as intended. P3: on B the library card has no thumbnail, and the clip on the timeline has no frame strip. | `29b-B-missing-media-after.png` ↔ `29b-B-missing-media.png`; `w-32-own-moved-original.png` |
| **P2-1** Esc and focus, layer by layer | **Mostly PASS** | New cut form: Esc 1 reopens the cut menu with focus on its item; Esc 2 puts focus on "Cut: Main cut". Compare takes focus (`SECTION [Compare]`); Esc closes it and focus goes to the list. Watch takes focus; Esc returns to the list (not back to Compare). Reply: Esc on typed text shows "Press Esc again to discard it.", with the text kept. Fold dialog: focus starts on the dialog, and Esc returns it to the cut button. Filters: ← → move between All / Named / Agent turns. Row ⋯ menu: Esc closes it, but focus goes to the list with no active row (new P3-5). **Preview banner: Esc does nothing, and focus is on `<body>` (FAIL; ui-polish listed it as not done).** History panel: Esc from the list closes it, and focus falls to `<body>`. | `07b-newcut-form-long-after.png` ↔ `07b-newcut-form-long.png`; `07c-after-esc-after.png` ↔ `07c-after-esc.png`; `22-reply-after.png` ↔ `22-reply.png` |
| **P2-2** No highlight left after a menu closes | **PASS** | With the mouse away after Esc, no row has a background. | `13-after-menu-close-after.png` ↔ `13-after-fold.png` |
| **P2-3** Last row's menu opens upward | **PASS** | Last row's ⋯ is at y 608. The menu spans 436–591, upward and fully in a 770 px window. The header stays at y 48, and there's no second scrollbar. | `54-oldest-row-menu-after.png` ↔ `54-oldest-row-menu.png` |
| **P2-4** Toasts after Fold in, Restore, Keep | **PASS** | Fold in: "Folded “Client review” into Main cut. Some changes were left out." with "Switch to Main cut". Restore: "Restored the version from 4:36 PM. It's saved as a new version." Keep: "Kept yours · 'W6' timing". (In the `CLAUDECODE=1` case it said "Kept yours" after I kept the *agent's* 9 s; see new P2-1.) | `13-after-fold-after.png` ↔ `13-after-fold.png`; `43-after-keep-after.png` ↔ `43-after-keep.png`; `w-11-after-restore-toast.png` |
| **P2-5** Compare lists the changes | **PASS** (one leftover) | "2 changes · 5.0 s of 6.0 s differ", then "Moved 'clip.mp4' 0.0 s → 2.0 s" and "Changed 'W2' text "W2" → "Hello world"". It no longer says "shots". The compared row is marked, and the card takes focus. Leftover: "Clips: 7 clips" still counts the 6 titles (P3-10). (A Preview banner from my previous step is on the stage in this shot. The card itself is unaffected.) | `15-compare-after.png` ↔ `15-compare.png` |
| **P2-6** Watch stand-in | **PARTIAL** (as ui-polish said) | No frames in the panel (0 `img/canvas/video`). It says "Shown in the player, read-only", and the editor's player follows: Space in Watch took the timeline 0.000 → 1.590 with Watch at 0:01. | `16-watch-after.png` ↔ `16-watch.png` |
| **P2-7** Preview banner words, Undo | **PASS** | "Previewing the version from 4:36 PM (You) · Read-only · Return to current to edit". Toolbar Undo is `disabled`, at opacity 0.5. | `17-preview-after.png` ↔ `17-preview.png` |
| **P2-8** Share words | **PASS** | "Sharing server" with the hint "The address you were given…". "Invite code" appears only once the server asks ("This server asks for one…"). The panel then says "Teammates see you as Vikas". Join isn't offered on a shared project. | `23-share-empty-after.png` ↔ `23-share-empty.png`; `26-shared-after.png` ↔ `26-shared.png` |
| **P2-9** Dashboard "Join a shared project" (Carton on only) | **PASS**, with new P2-3 | Carton on, with one project: the tile appears beside New project. It opens the Join dialog, which ends with **Open / Done**, and Open opens the project's tab. Carton off (same build, `ui-b` without `CARDBOARD_CARTON`): only "New project", and no Carton icons in the title bar. **But on an empty library the tile isn't there** (new P2-3). | `29-joined-after.png` ↔ `29-joined.png`; `w-23-B-dashboard-1project.png`; `w-31-B-dashboard-carton-off.png`; `w-21-B-dashboard-projects.png` (empty, no tile) |
| **P2-10** Role picker | **PASS** | Custom menu (Can edit / Can comment / Can watch) with no `<select>`. Esc returns focus to "Can edit". | `27-invite-link-after.png` ↔ `27-invite-link.png` |
| **P2-11** Presence avatars and status dot by Share | **PASS** | A's title bar shows an "L" avatar beside Share. Tooltip: "Share · Up to date · Leo is here" (B's reads "… Vikas is here"). With the host down: an amber dot (`rgb(251, 189, 35)`), the tooltip "Share · Offline: 1 edit waiting", and the stage chip "Offline: 1 edit waiting". When the host came back, both sides returned to "Up to date" and the edit reached B. B's very first read, a few seconds after opening, said "Nobody else is here right now", then listed Vikas. | `36-A-share-peer-titlebar-after.png` ↔ `36-A-share-peer.png`; `34-A-share-offline-after-titlebar.png`, `35-A-tabs-offline-after.png` ↔ `35-A-tabs-offline.png` |
| **P2-12** Offline message | **PASS** | One sentence: "The sharing server can't be reached. Your edits wait here and go out when it's back." Create link is disabled, with "You can create a link when you're back online." | `34-A-share-offline-after.png` ↔ `34-A-share-offline.png` |
| **P2-13** At 960 px the panel floats, the preview stays | **PASS** (P3 note) | Page width 960: the panel is `position: fixed` over the chat (x 576, w 384), and the preview canvas stays visible (168 × 95). P3-7: the floating panel is full height, so it also covers the timeline's right end and its toolbar buttons. | `47-narrow-history-after.png` ↔ `47-narrow-history.png` |
| **P3-6** Below 1180 px only the History icon | **PASS** | Title bar at 1136 CSS px: `history` only. At 1186: `history` and `share`. With 5 project tabs, the tab list still squeezes under the toolbar (Cardboard's own behaviour). | `47b-narrow-tabs-after.png` ↔ `47b-narrow-tabs.png` |
| **P2-14** Distinct History icon | **PASS** | Title bar uses the stack glyph; the chat keeps its clock. | `00-tabs-after.png` ↔ `00-tabs.png` |
| **P2-15** Agents' marks | **PASS** | Claude Code and Director use different marks (different SVGs). Colours are unchanged (both `#8fb3ff`), as ui-polish said. | `02-history-authors-after.png` ↔ `02-history-authors.png` |
| **P2-16** Tooltips on truncated text | **PASS** for rows | Hovering the cut-off title "Changed 'T2_150' font size 80 → 129" sets it as the `title`. The cut trigger has `aria-label` "Cut: Main cut"; I didn't make a cut name long enough to be truncated. | — |
| **P2-17** Day groups with 150+ versions | **PASS** for groups; **FAIL** for keeping your place (new P2-2) | 164 versions over 4 days. Headers read "Today · 10 versions" (open), "Yesterday · 50", "Sat, Oct 31 · 50" and "Fri, Oct 30 · 54" (folded). Click and Enter toggle a day. 10–26 rows are in the DOM. The single-day 151-version list shows clock times ("09:47 AM") and one Claude Code checkpoint ("149 edits"). **A version arriving while you read an opened older day jumps the list (5 of 5).** | `44-long-history-days-after.png` ↔ `44-long-history-top.png`; `45-long-history-scrolled-days-after.png` ↔ `45-long-history-scrolled.png`; `46-long-history-days-bottom-after.png` ↔ `46-long-history-bottom.png`; `44-long-history-top-after.png` (single day) |
| **P3-9** Divider when the list scrolls | **PASS** | When scrolled, `.carton-history` gets `data-scrolled` and the panel head a 1 px line (`box-shadow rgba(255,255,255,0.07) 0 1px`). | `45-long-history-scrolled-after.png` ↔ `45-long-history-scrolled.png` |
| **Ctrl+Shift+H** (DevTools key event) | **PASS** | Ctrl+Shift+H toggled the panel open→closed→open→closed. Plain H and Ctrl+H changed nothing. The tooltip reads "Version history (Ctrl+⇧H)". | — |
| **P2-18** "Imported the project" | **PASS** in the panel | "Started the project's history". `cb history` still says `import` (core's word, as ui-polish noted). | `01-history-blank-after.png` ↔ `01-history-blank.png` |
| **P2-19** Fold in from Main | **PASS** | The cut menu offers "Fold “Main cut” in here", which opens "Fold “Main cut” into “Client review” · 1 change". | `09-cut-menu-2cuts-after.png` ↔ `09-cut-menu-2cuts.png` |
| **P2-20** Comments composer | **PARTIAL** | No duplicate visible heading. The disabled Comment button is dark (`rgb(48,48,48)`, not a white slab). The comment posts with a "0:00.0" chip. **The textarea still shows the native resize grip (`resize: vertical`)**, although ui-polish's checklist says "no resize grip" (new P3-4). | `19-comments-empty-after.png` ↔ `19-comments-empty.png`; `21-comment-posted-after.png` ↔ `21-comment-posted.png` |
| **P3-1** mixed quotes | NOT FIXED (ui-polish: not done) | Rows use 'W1'; the Fold dialog uses “Client review”. | `11-fold-dialog-after.png` |
| **P3-2** card words | PARTIAL | "Two different edits. Pick one." The pill still varies: "1 conflict" / "1 conflict card waiting". | `w-15-card-cc.png` |
| **P3-3** "You" avatar stable | **PASS** | "Y You" in the same colour before and after sharing. | `38-A-teammate-edit-in-history-after.png` |
| **P3-4** one edit, two names | NOT FIXED (ui-polish: needs a decision) | A terminal `cb` edit is "You" in the panel and "Terminal" in `cb history`. | — |
| **P3-5** Fold dialog first focus | **PASS** | Focus is on the dialog (`DIV [Fold “Client review” into …]`). | `11-fold-dialog-after.png` ↔ `11-fold-dialog.png` |
| **P3-7 / P3-8** shortcut, cut switcher label | **PASS** | See Ctrl+Shift+H. `aria-label` is "Cut: Main cut". | — |
| **P3-10** Named hint | **PASS** | Two lines: "No named versions yet. Name one to find it again." | `06-filter-named-after.png` ↔ `06-filter-named.png` |
| **P3-11** New cut field focus | **PASS** | `outline: none`, with a subtle border (`rgba(255,255,255,0.25)`). | `w-29-newcut-focus.png` ↔ `07b-newcut-form-long.png` |
| **P3-12** Undo in preview | **PASS** | Disabled. | `17-preview-after.png` |
| **P3-13** Watch counter | PARTIAL | Inside Watch it's consistent ("1 change · Change 1 of 1"), but Compare on the same pair says "2 changes" (P3-11). | `16-watch-after.png`, `15-compare-after.png` |

## New bugs

### P2-1. Claude Code's view saves under `CLAUDECODE=1` are credited to "You" in History and on the conflict card
- **Repro:** `s-cards.js ui-a regress` (Claude Code = `cb` with `CLAUDECODE=1`).
  1. The agent runs `cb source print <id> --view regress`.
  2. The person drags W6 from 5 s to 7 s in the editor.
  3. The agent saves its view with W6 at 9 s and W2's font size at 222.
- **Expected:** History and the card say "Claude Code", as with `CARDBOARD_ACTOR=claude-code/…`, and as `cb history` does.
- **What happened:**
  - `cb history`: `main@5 Claude Code (view regress)`, with `by: {kind: "external", id: "external:.scratch/views/regress.tsx", name: "Claude Code (view regress)"}`.
  - The panel: "Changed 'W2' font size 100 → 222 · **You**". It stays so after closing and reopening the panel.
  - The card: "**Your earlier edit** 5.0 s → 7.0 s / **Your later edit** 5.0 s → 9.0 s", with "Keep earlier / Keep later".
  - After "Keep later" (the agent's 9 s), the toast says "**Kept yours**".
  - The same steps with `CARDBOARD_ACTOR=claude-code/cardtest` show "Claude Code" everywhere.
- **Why it matters:** a real Claude Code session in a terminal sets `CLAUDECODE=1`, and view saves are how agents edit. The person is told the agent's edit was their own, and the "Agent turns" filter misses it.
- **Shots:** `bug-cc-viewsave-card-both-you.png` (= `40b-agent-card-crop-after.png`), `41-card-preview-after.png` (the audit-actor run, for contrast).

### P2-2. A day-grouped History loses your place when a version arrives
- **Repro:** profile `ui-days` (kept), project "Days" with 164 versions over 4 days.
  1. Open History and open "Yesterday".
  2. Scroll down with the mouse wheel (`s-keepplace3.js ui-days <id> 9`).
  3. Make any edit with `cb`.
- **Expected:** the row you're reading stays where it is (ui-polish: "the reader keeps their place when versions arrive").
- **What happened:** the list jumps back to an older position, always onto the same row (Yesterday's "CHECKPOINT Changed 'W6' … Director · 5 edits"). The row you were reading leaves the visible list (not rendered).
  - Wheel runs: scrollTop 1928 → 1020, and 2512 → 1124.
  - `scrollTo` runs: 1500 → 708, and 1900 → 916.
  - The last run, with screenshots: 2204 → 1176.
- **Frequency:** 5 of 5 runs when I had scrolled since the previous arrival. With no scroll in between, the place held (scrollTop +52, one row; 3 of 3).
- **Control:** the single-day 151-version list (no day groups) keeps your place, 2 of 2 (row at y 130 → 130, and 126 → 126).
- **Shots:** `bug-days-jump-before.png`, `bug-days-jump-after.png`.

### P2-3. No "Join a shared project" on the Dashboard while the library is empty
- **Repro:** a fresh `ui-*` profile with Carton on. Onboard, then go to Dashboard → "Your projects". It shows only "Make your first video · Browse recipes / Start a blank project". The Projects page has no Join either.
- **Expected:** a teammate whose first action is joining can do it from the Dashboard (P2-9).
- **What happened:** the tile appears only once the library holds at least one project (`w-23-B-dashboard-1project.png`).
- **Workaround:** make or open any project and use its History → Share → "Join a shared project".
- **Shots:** `w-21-B-dashboard-projects.png`, `w-22-B-projects-empty.png`.

### P3
1. **First effect on a clip isn't named.** On a clip with no effects, adding one reads "Changed 'clip.mp4' effect". With an effects list already there, it reads "Added effect "sharpen" on 'clip.mp4'". Repro: `s-fx.js`. Shot: `w-17-clip-effect.png`.
2. **Undo after Restore isn't named anywhere.** See Table A.
3. **At the panel's 300 px minimum, the Share tab overlaps the close ✕ by 20 px.** Share spans x 1041–1115, ✕ spans 1094–1122, so it reads "Share✕". Repro: drag the panel's Resize separator all the way right. Shot: `w-30-panel-300-header.png`.
4. **The Comments textarea keeps the native resize grip** (`resize: vertical`). Shot: `19-comments-empty-after.png`.
5. **After Esc on a row's ⋯ menu, the list has focus but no active row.** `aria-activedescendant` is null, so the next ↓ starts at the top row, not the row whose menu was open. Repro: `s-listfocus.js`.
6. **Esc while previewing does nothing, and focus is on `<body>`.** This is the audit's P2-1 row, still open; ui-polish listed it as not done.
7. **At 960 px the floating panel is full height**, so it covers the right end of the timeline and its toolbar buttons (frame export, fullscreen, hide timeline) while open. Shot: `47-narrow-history-after.png`.
8. **"6 media files" counts titles.** The setup row reads "Added 2 tracks, 7 clips and 6 media files"; the 6 are the titles' internal records ("Added media 'Text: W1'"… in `cb compare`). The Library shows one file. Shot: `w-01-history-open.png`.
9. **Read-only preview still offers editing.** W6 keeps its selection handles on the stage, and the left panel keeps W6's edit presets. This is the audit's P1-6 second bullet. Shot: `41-card-preview-after.png`.
10. **Compare's "Clips: 7 clips" still counts titles** (audit P2-5 sub-point).
11. **Watch says "1 change · Change 1 of 1" where Compare says "2 changes"** for the same two versions.
12. **Small text and icon slips:**
    - The toggle's `aria-label` reads "Show all 1 changes".
    - The "Folded the rest of …" row uses the ↺ undo/restore icon, while the first fold row uses the fold icon.
13. **The joined teammate's library card has no thumbnail**, and the clip on the timeline has no frame strip (playback is fine). Shot: `29b-B-missing-media-after.png`.

### Not counted (probably a test artifact)
- On B (Leo), a `cb` terminal edit made on A by Vikas showed as "You" in B's History. Both profiles run under the same Windows user, so the actor's `group` (`local:vikas@V-LAPTOP`) is B's own. Its `owner` is `{id: "Vikas"}`. Needs a check on two real machines. Shot: `38-B-teammate-edit-in-history-after.png`.

## Not run
- Real in-app Director or Claude Code chat turns (named from the prompt). I simulated them with `CARDBOARD_ACTOR` and `CLAUDECODE=1`.
- The cut switcher tooltip on a truncated cut name. I didn't make a long cut name.
- A person-vs-teammate conflict card.

## Processes and files
- **Stopped:** every instance I started, by pid, with `taskkill /T /F`:
  - 7924 (`ui-a`), 31368 (`ui-b`, first run), 24468 (`ui-b`, Carton off), 1960 (`ui-large`), 6676 (`ui-days`).
  - Hosts 32288, 32076 and 27716 on 8795; the last stopped itself at its 10-minute limit.
- **Check afterwards:** nothing answers on 8795 or 9390–9393, and no `host.mjs 8795` process is left.
- **Repo:** `D:\Projects\cardboard-showcase` is untouched, at `1282627`; its only untracked file is the `test cardboard.mp4` that was already there. `large-src` was only copied from.
- **Deleted:** profiles `ui-a`, `ui-b`, `ui-large`; host folder `D:\cbwork\regress\ui\host1`; temp media `D:\cbwork\regress\ui\tmpmedia`.
- **Kept:**
  - `D:\cbwork\carton\profiles\ui-days` (41 MB): evidence for P2-2. Delete it when no longer needed.
  - `D:\cbwork\regress\ui\` (17 MB): this report, `shots\` (100 PNGs), and my scripts (`rcb.js`, `lib.js`, `s-*.js`, `gen-days.js`, `faketime.js`, `size.ps1`, `bounds.js`, `x.js`).
