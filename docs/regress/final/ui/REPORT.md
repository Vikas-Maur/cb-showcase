# Carton History / Share UI: re-check on the final candidate (2026-11-02)

> Pushed from the laptop on 2026-11-02. Final candidate `out/carton-final` @ `0cc587f1`. `shots/` holds the shots for the new bugs (N1–N5) and the baseline P3s still open; the full set (41 shots, 7.7 MB) stays on the laptop in `D:\cbwork\regress\final\ui\shots\`.

**Build:** `out\carton-final\Cardboard-win` (`build-info.json`: commit `0cc587f1`, carton true), run with `CARDBOARD_CARTON=1`, except the Carton-off checks.
**Baseline:** `D:\cbwork\regress\ui\REPORT.md` (candidate `1282627`).
**Machine:** this Windows 11 laptop, 125 % scaling. Every window was set to 1920 × 1020, which gives a 1522 × 770 CSS page, the same as the baseline. I used `size.ps1` (`SetWindowPos` with `SWP_NOACTIVATE`), so no window was brought to the front.

**How I tested:**
- **Input and screenshots:** DevTools protocol only (`Input.dispatchMouseEvent`/`dispatchKeyEvent`/`insertText`, page reads). Screenshots are `Page.captureScreenshot` of the app's page.
- **Instances:** each had its own `fu-*` profile from `launch.ps1`, on ports 9380, 9381, 9382–9387. The sharing host ran on 8795.
- **Authors:**
  - "You" comes from mouse drags, or from `cb` through `rcb.js you`. That path removes every `CLAUDE*`/`ANTHROPIC*`/`CARDBOARD*` variable, so it is a plain terminal.
  - "Claude Code" comes from `rcb.js cc`. That path removes the same variables and sets only `CLAUDECODE=1` (no hook variables).
  - One extra run used my full Claude Code shell environment.
- **Scripts and evidence:** scripts are in this folder; `s-*.js` that came from the baseline are adapted to `carton-final`. Shots are in `shots\` (7.7 MB).
- **Numbers:** x/y/scrollTop values are raw DOM readings from the scripts. They are not timings, and no second agent re-checked them. No timings are given anywhere in this report.
- **Mid-run change:** on request, I closed every instance I wasn't driving and kept at most 2 open from then on. This happened after item 2 and the join checks, before P3-13.

## Results

| # | Item | Result | What I saw | Evidence |
|---|---|---|---|---|
| 1 | Claude Code view save credited (`CLAUDECODE=1`, no hook); plain terminal still "You" | **PASS** | **`CLAUDECODE=1`:**<br>• History: "CHECKPOINT Changed 'W2' font size 100 → 222 · Claude Code · 1 edit".<br>• Card: "You · Moved 5.0 s → 7.0 s" / "Claude Code · Preview · Moved 5.0 s → 9.0 s", with buttons **"Keep yours" / "Keep Claude Code's"**.<br>• After "Keep Claude Code's", the toast says **"Kept Claude Code's · 'W6' timing"**, and W6 is at 9–10 s.<br>• `cb history`: `main@5 Claude Code (view regress)`.<br>• Extra: a view save from my full Claude Code shell environment also reads "Claude Code" (CHECKPOINT).<br>**Plain terminal, same steps:**<br>• History: "Changed 'W2' font size 100 → 222 · You".<br>• Card: "Your earlier edit / Your later edit", with "Keep earlier / Keep later".<br>• Toast: "Kept yours · 'W6' timing". | `i1-cc-history.png`, `i1-cc-card.png`, `i1-cc-kept-toast.png`; `i1-you-history.png`, `i1-you-card.png` |
| 2 | History keeps your place in the day-grouped list, including after a keyboard pick | **PASS** (13 of 13) | 164+ versions over 4 days (copy of `ui-days`). For each run: open Yesterday, scroll with the mouse wheel, anchor on the first visible row, then make a `cb` edit. Runs:<br>• Opened by click: 1 run.<br>• Opened with Enter from the keyboard: 3 runs.<br>• Row picked in Today with keys, then Yesterday opened with Enter: 3 runs.<br>• Row picked in Today with keys, then Yesterday opened by click: 3 runs.<br>• Yesterday opened with Enter, a row inside it picked with ↓, then wheeled away: 3 runs.<br>Every time, the anchored row stayed at the same y (e.g. 142 → 142), and scrollTop grew by exactly one row (+52) for the new version above. The picked row stayed off screen ("not rendered"), and the list was never pulled back to it. Two more runs, where setup opened the wrong day by mistake (Fri Oct 30), also held. | `i2-keepplace-pair.png` (before/after crops, identical), `i2-pickinside-before.png`, `i2-pickinside-after.png` |
| 3 | "Join a shared project" on an empty library: Dashboard and Projects with Carton on; not shown with Carton off | **PASS** (new bug N1 at the end of the flow) | **Carton on, empty library:** "Join a shared project" sits beside "Browse recipes / Start a blank project", on the Dashboard ("Your projects") and on the Projects page. It opens the Join dialog.<br>**Carton off** (same build, no `CARDBOARD_CARTON`): no Join control, both with an empty library and with one project. The title bar has only "Menu".<br>**Join from the empty state works:** the project lands in the library (5 of 5 fresh profiles).<br>**But** the success dialog ("… is in your library now · Open / Done") closes on its own, so Open can't be pressed (N1). | `i3-on-empty-dash.png`, `i3-on-empty-projects.png`, `i3-off-empty-dash.png`, `i3-off-1proj-dash.png`, `i3-join-from-empty-done.png` |
| 4 | Esc from a preview: first Esc deselects a selected clip, the next returns. From the list: first Esc returns, second closes the panel | **FAIL** (one of the two orders; new bug N2) | **List** (preview opened with Enter, focus in the list): Esc 1 returns from the preview and the panel stays. Esc 2 closes the panel. PASS.<br>**Clip selected during the preview:** Esc 1 deselects and the preview stays. Esc 2 returns. PASS, 4 of 4.<br>**Clip selected *before* the preview** (row ⋯ → Preview): Esc 1 deselects **and** leaves the preview at once. FAIL, 4 of 4. | `i4-list-esc1.png`, `i4-sel-during-esc1.png`, `i4-sel-before-start.png`, `i4-sel-before-esc1.png` |
| 5 | Comment box: no resize grip, grows to about 8 lines | **PASS** | `resize: none`. The bottom-right corner is plain textarea (`cursor: text`).<br>Growth: 52 px at 1–2 lines, then +18 px per line (`line-height` 18 px), up to `max-height` 160 px at 8 lines. From line 9 on it scrolls (scrollHeight 176…230, scrollTop follows the caret).<br>A long wrapped paragraph also stops at 160. Shift+Enter adds a line and doesn't post. Cleared, it is back to 52 px. | `i5-comment-3lines.png`, `i5-comment-12lines.png`, `i5-comment-wrapped.png` |
| 6a | A first effect on a clip is named | **PASS** | `cb` adds blur to a clip with no effects: **`Added effect "blur" on 'clip.mp4'`**. A second effect: `Added effect "sharpen" on 'clip.mp4'`. From the editor's Effects panel (Grain, clip selected): "Added track 'Track 3' and shader 'Grain'". | `i6-first-effect.png`, `i6-effect-ui.png` |
| 6b | Panel header at its 300 px minimum | **PASS** | I dragged the Resize separator all the way: the panel spans 838–1138. Tabs not open show as labelled icons: "Comments" 934–964 and "Share" 966–996, with `title`s. ✕ is at 1094–1122. Zero overlaps and no clipped text with History, Comments or Share open (the open tab keeps its label, e.g. Share 914–988). | `i6-header-300.png`, `i6-header-300-share.png` |
| 6c | Esc on a row's ⋯ menu, then ↓ moves on from that row | **PASS** | I opened "Moved 'W6' 7.0 s → 9.0 s" ⋯ and pressed Esc. The list then has `aria-activedescendant` on that row (it is also `aria-selected`). ↓ moves to the next row ("CHECKPOINT Changed 'W2' …"). (Enter there: see N3.) | `s-listfocus.js` output |
| 6d | A one-change row's toggle reads "Show the change" | **PASS** (P3 nit N4) | "Restored an earlier version · 1 change": `aria-label` "Show the change". It expands to `Removed effect "sharpen" on 'clip.mp4'`. Rows with more changes read "Show all 2 changes", "Show all 7 changes". Once expanded, the one-change toggle reads "Hide the changes" (plural). | `i6-show-the-change.png` |
| 7 | The other P3s from the baseline | see below | Fixed: P3-1, P3-3, P3-4, P3-5, P3-6 (partly), P3-12a. Still there: P3-2, P3-7, P3-8, P3-9, P3-10, P3-11, P3-12b, P3-13. | below |

### Item 7: the baseline's P3 list, one by one

| Baseline P3 | Now | Evidence |
|---|---|---|
| 1. First effect on a clip isn't named | **Fixed** (6a) | `i6-first-effect.png` |
| 2. Undo after Restore isn't named | **Still there.** The tooltip is plain "Undo Ctrl+Z", there's no toast, and the new row reads `Added effect "sharpen" on 'clip.mp4'` like a fresh edit (`cb`: `main@7 person undo`). Only its icon differs: it's the ↺ restore icon. | `p3-undo-after-restore-tooltip.png`, `w-restore-after.png` |
| 3. Share tab overlaps ✕ at 300 px | **Fixed** (6b) | `i6-header-300.png` |
| 4. Comment textarea resize grip | **Fixed** (5) | `i5-comment-12lines.png` |
| 5. After Esc on ⋯, no active row | **Fixed** (6c) | — |
| 6. Esc while previewing does nothing | **Mostly fixed.** Esc now leaves the preview. But with a clip selected before the preview, it also skips the "deselect first" step (N2). | item 4 shots |
| 7. Floating panel at 960 px covers the timeline | **Still there.** Page 960, panel at the default 384: `position: fixed`, x 576–960, full height. Under it: the timeline's right end (576–720), the timeline toolbar's **Fullscreen** and **Hide timeline**, and the text toolbar's Line height, Colors, Shadow and Opacity. (At 300 px wide it only covers the chat column.) | `p3-narrow-960-384.png` |
| 8. "N media files" counts titles | **Still there.** The setup row reads "Added 2 tracks, 7 clips and 6 media files" (1 clip, 6 titles), and on another project "…3 clips and 2 media files" (1 clip, 2 titles). The Library holds one file. | `i1-cc-history.png` |
| 9. Read-only preview still offers editing | **Still there, and wider.** In preview, W6 keeps its selection on the timeline, and the left panel keeps W6's title presets. Clicking "Hero Title" during the preview changes nothing (W6 stays at font size 100, no version is made). See N3 for the stage's text editor. | `p3-preview-preset.png`, `i4-sel-before-start.png` |
| 10. Compare's "Clips" counts titles | **Still there.** "Clips: 7 clips" on both sides (1 clip, 6 titles). | `p3-compare.png` |
| 11. Watch vs Compare change counts differ | **Still there.** On the same version, Compare says "3 changes · 6.0 s of 10.0 s differ" and lists three. Watch says "2 changes · 6.0 s of 10.0 s · Change 1 of 2". | `p3-compare.png`, `p3-watch.png` |
| 12a. Toggle label "Show all 1 changes" | **Fixed:** "Show the change" (6d) | `i6-show-the-change.png` |
| 12b. "Folded the rest of …" uses the ↺ icon | **Still there.** "Folded the rest of 'Client review' into 'Main cut': 1 change" has `data-icon="restore"`, while "Folded 'Client review' into 'Main cut': 1 of 2 changes" has `data-icon="fold"`. | `p3-fold-icons.png` |
| 13. Joined teammate's card has no thumbnail; the clip has no frame strip | **Still there.** On the teammate (fu-b, joined "FX ui" and "Share t" from host 8795):<br>• Both library cards have no `img`/`video`/background image.<br>• The editor's Library tile for clip.mp4 is blank grey.<br>• The clip on the timeline is a plain blue bar with no frames.<br>Playback is fine (colour bars on the stage), and the notice reads "This video plays from preview copies…". The owner's side shows both. | `p3-joined-library.png`, `p3-joined-editor.png`; owner: `w-share-shared.png` |

## New bugs

### N1 (P2). Joining from an empty library: the "Open / Done" dialog closes on its own, so nothing opens
- **Why P2:** it is the exact first-run flow item 3 adds (a teammate whose first action is joining). The confirmation flashes away, and its Open can't be used. No data is lost: the project tile is there.
- **Repro:**
  1. Start a fresh profile with Carton on (`launch.ps1 -Build carton-final -Profile <new> -Port <p> -Carton`) and onboard it.
  2. On the Dashboard → "Your projects" (or the Projects page), click "Join a shared project".
  3. Paste a valid invite link, enter a name, press Join.
- **What happens:**
  - The dialog shows "“FX ui” is in your library now. … **Open / Done**".
  - It disappears by itself almost at once: my click on Open, sent right after the screenshot, found no dialog.
  - No tab opens (tabs: []). The page now shows the regular project grid with the joined tile.
- **Expected:** the dialog stays until Open or Done, as it does when the library already has a project. Control on fu-b, same build: it ended on "Open / Done", and Open opened the "FX ui" tab.
- **Frequency:** 5 of 5 fresh profiles, from the Dashboard (fu-b, fu-c, fu-e, fu-f) and from the Projects page (fu-d). Every time the library went from empty to one project.
- **Likely cause (not verified):** the dialog lives inside the empty-library view. Once the library holds the joined project, that view is replaced by the grid, and the dialog goes with it.
- **Shots:** `bug-join-empty-noclick-open.png` (the dialog showing Open), `bug-join-empty-dash-end.png`, `i3-join-from-empty-done.png` (after: dialog gone, tile present).

### N2 (P3). With a clip selected before a preview, the first Esc both deselects and leaves the preview
- **Repro:** `s-escpreview.js sel-before "Added track"`.
  1. Click W6 on the timeline.
  2. History → row "Added track 'Text 1', moved 'W6'" → ⋯ → Preview. The banner shows, and W6 is still selected.
  3. Press Esc.
- **What happens:** selection 1 → 0 **and** the banner is gone, on the same Esc. 4 of 4.
- **Expected:** Esc 1 deselects and Esc 2 returns. That is what happens when the clip is selected *during* the preview (4 of 4).
- **Likely cause (from a probe, not proven):**
  - The editor clears the selection in the same keydown in both orders (my probe saw `window.__carton.selection()` go from `[id]` to `[]`).
  - The banner's listener (`status.ts`, `PreviewBanner`) reads its "before" state when it runs.
  - If the editor's Esc listener was registered before the banner's (selection made before the preview), it runs first. The banner then reads an already-cleared selection, sees no change, and closes.
- **Shots:** `i4-sel-before-start.png`, `i4-sel-before-esc1.png`.

### N3 (P3). Enter on a History row also opens the stage's text editor on the selected title, inside the read-only preview
- **Repro:** `s-rowenter.js 2`, with a title (W6) selected on the timeline.
  1. Focus the History list and pick a row with ↓.
  2. Press Enter.
- **What happens:** Enter previews that row (as designed: `virtual.ts` calls `onActivate` and `preventDefault()`), but it doesn't stop the key. The editor's own Enter then opens W6's inline text editor on the stage. Focus is in a TEXTAREA with value "W6", under the "Read-only" banner.
- **Typing there:** "W6ZZ" shows in the field, but nothing is saved, whether you leave with Esc, a click elsewhere, or Enter. W6 stays "W6", no version is added (`cb history` unchanged), and nothing changes after Return to current.
- **Why it matters:** it looks editable and silently drops the typing (same family as P3-9).
- **Frequency:** 4 of 4.
- **Shots:** `w-row-enter.png`, `bug-preview-typed.png`, `bug-preview-commit-enter.png`.

### N4 (P3 nit). An expanded one-change toggle reads "Hide the changes"
"Show the change" becomes "Hide the changes" once expanded (`words.ts`: `hideChanges`). Shot: `i6-show-the-change.png`.

### N5 (P3). Previewing a shorter version keeps the playhead past its end
- **Repro:** with the playhead at 9.5 s on the 10 s current version, preview "Added track 'Text 1', moved 'W6'", an 8 s version.
- **What happens:** the stage is black, and the readout says "0:09 / 0:08".
- **Shot:** `i4-sel-before-start.png`.

### Seen, not counted
After the conflict, the chat composer's selection chip still read "W6 5.0s–6.0s" while W6 was at 7 s and then 9 s (`i1-cc-card.png`). The chip is Cardboard's own, and I didn't look into it.

## Processes, files, profiles
- **Instances stopped**, each by PID with `taskkill /T /F`:
  - fu-a 12984 (9380), fu-off 31692 (9381), fu-days 9936 (9382), fu-b 6524 (9383).
  - fu-c 18232 (9384), fu-d 5436 (9385), fu-e 29936 (9386), fu-f 15812 (9387).
  - Host 19140 (8795); its `sleep` feeder was ended too.
- **Check afterwards:** nothing listens on 9380–9389 or 8795–8799, and no `Cardboard.exe … --remote-debugging-port=938x` or `host.mjs` process is left.
- **Profiles deleted:** fu-a, fu-b, fu-c, fu-d, fu-e, fu-f, fu-off, fu-days, and the host folder `host1`.
- **Profiles kept:** none. Every bug above reproduces from a fresh profile with the listed scripts.
- **`ui-days`:** only copied from. Before and after, the list of its 265 files with sizes and mtimes is identical (`ui-days-before.tsv` = `ui-days-after.tsv`).
- **Repo:** untouched, at `0cc587f`. The only untracked file is the `test cardboard.mp4` that was already there. No commits, pushes or workflows.
- **Kept here:** this report, `shots\` (41 PNGs, 7.7 MB), and my scripts.
