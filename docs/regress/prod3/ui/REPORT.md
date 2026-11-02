# Carton History / Share UI: re-check of `merge/prod-2` @ `eea781bb` (ORDERS Update 5, items 5, 6, 7), 2026-11-02/03

**Build:** `out\carton-prod3\Cardboard-win` (`build-info.json`: commit `eea781bb…`, carton true), run with `CARDBOARD_CARTON=1` except for the Carton-off checks.
**Baseline:** `D:\cbwork\regress\final\ui\REPORT.md` (candidate `0cc587f1`).
**Machine:** this Windows 11 laptop, 125 % scaling. I didn't resize any window. Every instance ran at its default 1444 × 826 CSS page. The 960 px check narrowed only the editor page, with `Emulation.setDeviceMetricsOverride`, because Electron doesn't implement `Browser.getWindowForTarget`/`setWindowBounds`.

**How I tested**
- **Input and screenshots:** DevTools protocol only. Mouse and keys went through `Input.dispatchMouseEvent`/`dispatchKeyEvent`/`insertText`, state came from page reads, and screenshots are `Page.captureScreenshot` of the app's pages. There was no real keyboard or mouse input, no window was brought to the front, and the screen was never captured.
- **Instances:** each had its own `p3-*` profile from `launch.ps1`, on ports 9380/9381. At most 2 of mine were open at once. Another test's instance (`sp-prod3`, port 9343) was running throughout, and I left it alone.
- **Sharing host:** `host.mjs` on 8795, in `profiles\p3-host`.
- **Who made the edits:** projects were made with `mkproj.js` through `rcb.js you` (a plain terminal). GUI edits were DevTools mouse and keys.
- **Scripts:** all in this folder. The copied ones are adapted to `carton-prod3` and this folder. New ones: `s-join3.js`, `lib2.js`, `s-n3.js`, `s-b9.js`, `s-n4.js`, `s-b2.js`, `s-restore3.js`, `s-n5.js`, `s-b7.js`, `s-b7b.js`, `s-counts.js`, `s-cw.js`, `front.js`, `winsize.js` (unused: Electron lacks the Browser domain).
- **Logs and shots:** logs are `i*.log`. Shots are in `shots\` (53 PNGs, 7.5 MB).
- **Numbers:** x/y/width values are raw DOM readings. They are not timings, and no second agent re-checked them. "Stayed ≥ 6 s" is a pass/fail threshold (the order asks for 5 s), not a measurement.
- **Runs I threw away, and why:**
  - N2: my first 3 `sel-before` runs. The docked History panel narrows the timeline, so W6 (at 9–10 s) was off the visible timeline and runs 2–3 never selected it. I zoomed out one step, so W6 is on screen, and re-ran everything.
  - Baseline 2: two retries. My restore step clicked the History row "Restored an earlier version" (rows are `role=option`) instead of the menu's Restore. It also once targeted a row the virtual list hadn't rendered. `s-restore3.js` fixes both, and only its runs count.

## Results

| ORDERS sub-item | Result | What I saw | Evidence |
|---|---|---|---|
| **5a** N1: Dashboard → "Join a shared project" on an empty library → paste → name → Join; "Open / Done" stays ≥ 5 s; Open opens the tab | **PASS** | Fresh profile `p3-j1`, invite from owner `p3-own` ("Join me", shared live to 8795).<br>• Join turned to "“Join me” is in your library now. … Open \| Done", and it **stayed untouched for 6 s or more** (polled every 200 ms, no change).<br>• Open closed it. Tabs `[] → ["Dashboard","Join me"]`, with "Join me" `aria-selected=true`. The editor shows the clip, the 6 titles and "This video plays from preview copies…". | `i5-j1.log`, `shots/i5-j1-dash-2-held.png`, `i5-j1-editor.png` |
| **5b** N1 again from the Projects page, another fresh profile, pressing Done | **PASS** | Fresh `p3-j2`, sidebar "Projects" highlighted, its "Join a shared project" button.<br>• The dialog stayed ≥ 6 s untouched.<br>• Done closed it, no tab opened (tabs `[]`), and the tile "Open Join me" is in the library.<br>(See P3-E: the page jumps back to the Dashboard top as the join lands.) | `i5-j2.log`, `shots/i5-j2-proj-0-empty.png`, `-2-held.png`, `-3-after.png` |
| **5c** Carton off: no Join control | **PASS** | Fresh `p3-off`, same build, launched without `CARDBOARD_CARTON`: no Join control on the Dashboard or the Projects page, with an empty library and again with one project. The title bar has only "Menu". | `shots/i5-off-empty-dash.png`, `i5-off-1proj-dash.png` |
| **6** N2 `s-escpreview.js sel-before "Added track"` | **PASS** (4/4) | W6 selected, then row ⋯ → Preview.<br>• Esc 1: `selected 1→0`, banner stays.<br>• Esc 2: returns (banner gone), panel stays. | `i6-n2-selbefore.log`, `shots/i6-n2-selbefore-start.png`, `-esc1.png` |
| **6** N2 `sel-during` | **PASS** (3/3) | Esc 1 deselects and the preview stays. Esc 2 returns. | `i6-n2-selduring.log`, `shots/i6-n2-selduring-esc1.png` |
| **6** N3 `s-rowenter.js 2` with W6 selected: row previews, no text editor, ↑/↓ don't move the playhead | **PASS** | Enter on "Added 2 tracks, video 'clip.mp4' and 6 titles":<br>• The banner shows, focus stays in the History list, and no stage editor opens. The only textarea on the page is the chat composer's chip "W6 9.0s–10s".<br>• ↓ ↑ ↑ ↓ move only the list's active row. The playhead stays at 00:00:09.500 (readout 0:06 / 0:06 in the 6 s version) after every key.<br>• The original `s-rowenter.js 2` agrees: banner true, focus in the list. | `i6-n3.log`, `shots/i6-n3-enter.png` |
| **6** Baseline 9: in a preview, Enter / double-click on a title → "Previewing an earlier version. Return to current to edit.", no editor; after Return both edit | **PASS** | W5 at 4.5 s, previewing the 8 s version:<br>• Enter (W5 selected) and a double-click on W5 on the stage both show the pill "Previewing an earlier version. Return to current to edit.". Focus stays on BODY and no version is made.<br>• After Return, Enter and the stage double-click each focus `TEXTAREA[W5]` (the inline editor). Esc leaves the head unchanged (`main@5`).<br>• Extra: a double-click on the clip during the preview shows the same pill and doesn't open crop. After Return the same double-click opens crop. | `i6-b9w5.log`, `shots/i6-b9w5-preview-enter.png`, `-preview-dblstage.png`, `-current-enter.png`, `-current-dblstage.png`, `i6-b9-preview-dblstage.png` |
| **6** N4: a one-change row's open toggle reads "Hide the change" | **PASS** | "Restored an earlier version · 1 change" toggles "Show the change" → (open) **"Hide the change"** → "Show the change". Details: "Moved 'W6' 9.0 s → 7.0 s". | `i6-n4.log`, `shots/i6-n4-toggle-open.png` |
| **6** N5: playhead 9.5 s, preview the 8 s version → 0:08 / 0:08; Return → 9.5 s; preview, ruler click at 3 s, Return → stays 3 s | **PASS** (2/2) | Read with the mouse off the timeline:<br>• Current: `00:00:09.500`, 0:09/0:10.<br>• Preview of "Added track 'Text 1', moved 'W6'": `00:00:08.000`, **0:08/0:08**.<br>• Return: `00:00:09.500`, 0:09/0:10.<br>• Preview again, ruler at 3 s: 0:03/0:08. Return: **`00:00:03.000`**, 0:03/0:10. | `i6-n5.log`, `shots/i6-n5-preview.png`, `-returned.png`, `-returned-3s.png` |
| **6** Baseline 2: Restore, then Ctrl+Z → "Undid the restore"; redo → "Redid the restore" | **PASS** (2/2) | Restore of a different version, then:<br>• Ctrl+Z (DevTools key) gives the row **"Undid the restore"** (`cb`: `undo`).<br>• Ctrl+Shift+Z gives **"Redid the restore"** (`cb`: `revert`).<br>Both rows have the ↺ icon. (A second undo/redo after that is not named: P3-D.) | `i6-b2.log`, `i6-b2-run2.log`, `shots/i6-b2-rows.png` |
| **6** Baseline 7: 960 CSS px, History 300 px wide and ends above the timeline toolbar, Fullscreen and Hide timeline clickable; same with the chat collapsed | **FAIL** with the chat open; **PASS** with it collapsed | **Chat open** (4 of 4 layouts: History open before narrowing, opened at 960, chat shown again, History closed and reopened):<br>• The panel is `position: fixed`, x 576–960, **384 px wide, full height** (bottom 826; toolbar top 586).<br>• At Fullscreen and Hide timeline, `elementFromPoint` hits the History panel. A click on Hide timeline does nothing, and a click on Fullscreen makes no `requestFullscreen` call.<br>**Chat collapsed:** the panel is 660–960, **300 px**, bottom **586** (= toolbar top). Both buttons hit-test as themselves. Hide timeline hides and shows the timeline. Fullscreen calls `requestFullscreen` (which I wrapped so the window never went fullscreen).<br>**Controls:** at 960 with the chat open and History *closed*, both buttons are already under Cardboard's own chat column, also with Carton off (P3-A). | `i6-b7.log`, `i6-b7b.log`, `shots/i6-b7-opened960-chat-open.png`, `i6-b7-chat-collapsed.png`, `i6-b7-960-nohistory.png`, `i6-b7-960-cartonoff.png` |
| **6** Baseline 12b: fold some, then fold in the rest; that row has the fold icon, its undo has ↺ | **PASS** (2/2) | "Folded the rest of 'Alt' into 'Main cut': 1 change" has `data-icon="fold"` (so does "Folded 'Alt' … 1 of 2 changes"). Ctrl+Z gives a row with `data-icon="restore"` (↺). That undo row reads "Added video 'clip.mp4', deleted video 'clip.mp4' and video 'clip.mp4'" (see observations). | `i7-foldc.log`, `i7-fold.log`, `shots/i7c-b12b-icons.png` |
| **7** Split a clip with auto reframe on: History reads only "Split 'clip.mp4' at 1.5 s" | **PASS** | GUI split of a fresh project's clip (`autoReframe` on), with B at 1.5 s. The newest row is exactly **"Split 'clip.mp4' at 1.5 s"**. Mine is `[0,1.5],[1.5,3]`. In the source, neither part has `autoReframe` any more: the editor's split drops it, and History no longer narrates that. | `i7-split.log`, `shots/i7-split-row.png` |
| **7** New cut "Alt": split + a title's font size; Fold into Main says "2 changes"; untick the split → "Fold in 1 of 2"; row "Folded 'Alt' into 'Main cut': 1 of 2 changes"; `cb history` `merge (1 left out)` | **PASS** | "Fold C": "Alt" made with the cut menu's New cut, the GUI split, then W1's font size 100 → 150 with `cb source apply` on Alt.<br>• Dialog: **"2 changes"**: "Changed 'W1' font size 100 → 150", "Split 'clip.mp4' at 1.5 s".<br>• Unticking the split makes the button **"Fold in 1 of 2"**.<br>• Row **"Folded 'Alt' into 'Main cut': 1 of 2 changes"** (toggle "1 change"), and `cb`: **`main@5 person merge (1 left out)`**.<br>• Main's clip stays whole, and W1 is 150.<br>The GUI font-size path gives 3 changes instead (P3-B), with consistent counts: "Fold in 2 of 3", "2 of 3 changes", `merge (1 left out)`. | `i7-foldc.log`, `shots/i7c-fold-dialog.png`, `i7c-fold-dialog-unticked.png`, `i7c-folded-some.png` |
| **7** Fold in the rest: "Folded the rest of 'Alt' into 'Main cut': 1 change" | **PASS** | The dialog shows "1 change · Split 'clip.mp4' at 1.5 s · Left out earlier". After Fold in, the row reads **"Folded the rest of 'Alt' into 'Main cut': 1 change"**, and Main's clip is split. `cb` lists it as `revert` (see observations). | `i7-foldc.log`, `shots/i7c-fold-rest-dialog.png`, `i7c-folded-rest.png` |
| **7** 1 clip + 6 titles: setup row "Added 2 tracks, video 'clip.mp4', 6 titles and media 'clip.mp4'" | **PASS** for the wording I could produce; the "and media 'clip.mp4'" form not produced | Titles are named as titles in the headline: **"Added 2 tracks, video 'clip.mp4' and 6 titles"** (the baseline had "7 clips and 6 media files").<br>I couldn't produce a version that adds the clip's media together with the timeline:<br>• `mkproj`, the `dl` copy, and a one-shot `source apply` that ingests the file all record "Added media 'clip.mp4'" as its own version.<br>• The restore route makes a version that adds both, but it's titled "Restored an earlier version".<br>The row's count and expanded list still include the titles' media entries: P3-C. | `i7-setupE.log`, `shots/i7-setupE-setup-expanded.png` |
| **7** Compare's Clips reads "1 clip, 6 titles" | **PASS** | "UI six", setup row ⋯ → Compare with current: **"Clips | 1 clip, 6 titles"** on both sides. | `i7-cw-uisix.log`, `shots/i7-uisix-compare.png` |
| **7** Compare's and Watch's change counts match; Watch reads "Section 1 of M" | **PASS** | Compare: **"2 changes · 4.0 s of 10.0 s differ"** (Added track 'Text 1'; Moved 'W6' 5.0 s → 9.0 s, to track 'Text 1'). Watch: **"2 changes · 4.0 s of 10.0 s"** and **"Section 1 of 1"**. One comparison checked. | `i7-cw-uisix.log`, `shots/i7-uisix-watch.png` |

## New bugs (all P3; no P1 or P2 found)

### P3-A. At 960 px with the chat open, the History drawer is 384 px wide and full height (baseline P3-7 is only half fixed)
- **Repro:**
  1. Open a project with the chat (Director) open.
  2. Narrow the editor page to 960 CSS px (I used `s-b7b.js`).
  3. Open History.
- **What happens:** the panel is `fixed`, x 576–960, 384 × 826. It covers the chat column and the toolbar's Fullscreen and Hide timeline (hit tests land in the panel), so Hide timeline can't be clicked. 4/4.
- **Expected (ORDERS):** 300 px wide, ending above the timeline toolbar, as it does with the chat collapsed (300 px, bottom 586).
- **Why (from `scripts/carton/ui.js` `fitPanel`/`useFit`):**
  - The drawer width is `max(300, min(preferred, chat))` = `min(384, 384)` = 384.
  - It is shortened only when it is wider than the chat column (`over: fits > chat`), and 384 > 384 is false.
  - The fix measures `innerWidth` and DOM rects, so Emulation exercises it the same way a real 960 px window would.
- **Why only P3:** with History closed, at 960 px with the chat open, Fullscreen and Hide timeline are already under Cardboard's own chat column, and Carton off is the same (`i6-b7-960-cartonoff.png`). The drawer covers only what the chat column already covers, so it is no regression against Cardboard. But the ordered result isn't met with the chat open.

### P3-B. Fold dialog: "Moved 'W1' to track another track, font size 100 → 150"
- **Repro** (`s-counts.js … alt` without `FONT_CB`):
  1. New cut "Alt".
  2. Split the clip.
  3. Select W1, set its font size 100 → 150 in the stage's text toolbar. In this build that version also adds a track "Text 1" and moves W1 onto it.
  4. Main cut → Fold "Alt" in here.
- **What happens:** the dialog row reads **"Moved 'W1' to track another track, font size 100 → 150"**. 2/2 ("Fold B", "Fold D").
- **Expected:** History's own expanded row for the same version reads it correctly: "Moved 'W1' to track 'Text 1', font size 100 → 150" (`i7d-alt-row-expanded.png`). The dialog seems to fall back to "another track" because 'Text 1' doesn't exist on Main yet, and it doubles "track".
- **Shots:** `i7d-fold-dialog.png`, `i7-fold-dialog.png`.

### P3-C. Row change counts and expanded lists still count titles' media entries
- **Repro:** any mkproj project (1 clip + 6 titles). Expand the setup row "Added 2 tracks, video 'clip.mp4' and 6 titles".
- **What happens:**
  - The row says **"15 changes"**: 2 tracks, 1 video, 6 titles, plus **"Added media 'Text: W1'" … "'Text: W6'"**.
  - The headline is right, and Compare says "1 clip, 6 titles", but the count and list still treat each title as a media file too.
  - Restore rows show the same: 16 changes, "Deleted media 'Text: W1'" ….
  - This is what's left of baseline P3-8.
- **Shots:** `i7-setupE-setup-expanded.png`, `i7-setupE-restore-expanded.png`, `i7-setupE-checkpoint-expanded.png`.

### P3-D. A second undo/redo after a restore isn't named as one
- **Repro** (`s-restore3.js "Added 2 tracks"`, then `s-b2.js`):
  1. Restore.
  2. Ctrl+Z → "Undid the restore". ✓
  3. Ctrl+Shift+Z → "Redid the restore". ✓
  4. Ctrl+Z again.
  5. Ctrl+Y.
- **What happens:**
  - Step 4 reads **"Added track 'Text 1', moved 'W6'"**, and step 5 reads **"Deleted track 'Text 1', moved 'W6'"**. In the first run they were "Moved 'W6' 7.0 s → 9.0 s" / "Moved 'W6' 9.0 s → 7.0 s".
  - These rows have the ↺ icon, but their text reads like fresh edits, although they undo and redo the same restore. 2/2.
- **Shot:** `i6-b2-rows.png`.

### P3-E. Joining from an empty library jumps the home page back to the top of the Dashboard
- **Repro:** fresh profile → Projects (or Dashboard → "Your projects") → Join a shared project → Join.
- **What happens:**
  - As soon as the join lands (with the "Open / Done" dialog up), the page scrolls back to the top of the Dashboard.
  - From the Projects page, the sidebar highlight changes from Projects to Dashboard.
  - After Done, the joined tile is below the fold.
  - 2/2 (`i5-j2-proj-0-empty.png` vs `i5-j2-proj-2-held.png`, `i5-j1-dash-0-empty.png` vs `i5-j1-dash-2-held.png`).
- **Expected:** the user stays where they joined from and sees the new tile.
- **Likely cause (not verified):** the empty-library view is replaced by the grid.

### Seen, not counted
- The undo of "Folded the rest of 'Alt' …" reads "Added video 'clip.mp4', deleted video 'clip.mp4' and video 'clip.mp4'" (↺ icon). Unlike "Undid the restore", it isn't named as an undo of the fold.
- `cb history` lists "Folded the rest of …" as `person revert`; the first fold is `merge (1 left out)`.
- In a preview, a selected title still shows the stage's text toolbar (font size, B/I, alignment) and the left panel's title presets (`i6-b9-preview-enter.png`). This is the baseline P3-9 family. I didn't test whether those controls change anything.
- In this build, the stage toolbar's font-size change (100 → 150) also moves the title onto a new track in the same version. That is probably Cardboard's own behaviour; I didn't investigate it.

## Processes, files, profiles
- **Stopped,** each by PID (`taskkill /T /F`):
  - Instances: owner `p3-own` 31576 (9380), `p3-j1` 32436 (9381), `p3-j2` 28928 (9381), `p3-off` 29948 and again 7636 (9381), `p3-ui` 33240 (9380), `p3-dl` 3640 (9381).
  - Host: `host.mjs` 33548 (8795), and its `tail` stdin feeder (MSYS pid 2839).
- **Check afterwards:** nothing listens on 9380–9389 or 8795–8799, and no process mentions `p3-*`, `host.mjs` or `--remote-debugging-port=938x`. The other test's `sp-prod3` (9343) was never touched.
- **Profiles deleted:** `p3-own`, `p3-j1`, `p3-j2`, `p3-off`, `p3-host`, `p3-ui`, `p3-dl` (a copy of `dl`; `dl` itself was only copied from).
- **Profiles kept:** none. Every finding reproduces from a fresh profile with the scripts here.
- **Repo:** untouched at `eea781b`. No checkout, edit, commit, push or workflow. The only untracked file is the `test cardboard.mp4` that was already there. The installed Cardboard and the user's profile weren't touched.
- **Kept here:** this report, the scripts, the logs, and `shots\` (53 PNGs, 7.5 MB).
