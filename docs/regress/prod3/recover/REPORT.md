# Recovered-project fixes: real-app re-check of release candidate prod3

Build: `out\carton-prod3` (`merge/prod-2` @ `eea781bb`), `CARDBOARD_CARTON=1`. Orders: ORDERS.md "Update 5", items 2, 3 and 4.

How I tested:
- Every instance had its own profile, started by `launch.ps1`, on ports 9370/9371. At most one of my instances ran at a time.
- Driven only over DevTools: `Input.dispatch*` for mouse and keys, `Page.captureScreenshot` of the app's own page.
- No real input. No window was brought to the front.
- Console errors were recorded on the editor page with `Runtime.consoleAPICalled` (error/warning) and `Runtime.exceptionThrown`. Every `*.txt` ends with the errors seen during that step.
- `project.json` was read only while the app was closed (`pj.js`).
- Items 2 and 3 each used a fresh copy of `profiles\dl`. The fr-dl3 check used a copy of `profiles\fr-dl3`.
- **Left to the parent:** item 3's Ctrl+Z with a real key. Every Ctrl+Z here is a DevTools key.

## Results

| ORDERS sub-item | Result | What I saw | Evidence |
|---|---|---|---|
| 2.1 Open "Oldest restore", History → ⋯ → Restore the "Added 2 tracks…" row | **PASS** | The row now reads "Added 2 tracks, video 'clip.mp4' and 6 titles" (fold-count's new wording, not the ORDERS' older label). Toast: "Restored the version from 8:59 AM. It's saved as a new version." `main@6 person restore`. The editor shows Mine + Agents with video and W1–W6. Disk: `2 tracks · 7 items`. 0 console errors. | `2a-restore.txt/.png` |
| 2.2 `project.json`: all 7 `project.media[]` entries have `createdAt`/`addedAt`; titles have `format:"text"`, `size:0`, `presetId:"custom"` | **PASS** | All 7 entries have `createdAt` and `addedAt` (2026-11-02T03:29:40.796Z, the original date). The 6 titles have `format:"text"`, `size:0`, `presetId:"custom"`. The clip keeps `format:"mp4"` and its size. | `2b-pj-after-restore.txt/.json` |
| 2.3 Click W6, press Delete: a `person edit` version, `source print` shows 6 items, no "Invalid time value" | **PASS** (see N-1) | Head went to `main@8 person edit`, and `cb source print` shows `16:9 · 5.0s · 2 tracks · 6 items`. 0 console errors, no "Invalid time value". The one Delete saved **2** versions: main@7 "Deleted media 'Text: W6'" and main@8 "Deleted title 'W6'" (N-1). | `2c-delete-w6.txt/.png` |
| 2.4 Restart, edit again: it saves | **PASS** | After closing and relaunching, deleting W5 saved `main@9`/`main@10 person edit`. Disk: `5 items`. 0 errors. | `2d-restart-delete-w5.txt/.png` |
| 2.5 Kept `fr-dl3` profile (a copy): delete a title, it saves and writes the dates | **PASS** | Before: 7 entries with no dates, and titles with no format/size/presetId (`2h-…`). Deleting W3 saved `main@8`/`main@9 person edit`, 7 items, 0 errors. After closing: every remaining entry has `createdAt`/`addedAt`, and the titles have `format/size/presetId`. The original `fr-dl3` is unchanged (md5 of all files before and after). | `2h-frdl3-pj-before.txt`, `2i-fr-delete-w3.txt`, `2k-frdl3-pj-after.txt`, `frdl3-md5-*.txt` |
| 2.6 (optional) `window.__carton.saveFailed(new Error("x"))` shows the toast | **PASS** (P3 N-3) | The stage toast "Your last change couldn't be saved. It's on screen, but it isn't in the project yet." appeared both times (p3r-a, fr copy). No console error. It has a green ✓ "success" icon (N-3). | `2f-savefailed-toast.png/.txt`, `2j-fr-savefailed.png/.txt` |
| 3.1 Ctrl+Z right after the recovery (**DevTools key**): toast, no new version, no crash, timeline unchanged | **PASS** | Toast: "Can't undo that: the project would be left empty". Head stays `main@6 restore`, the editor still has 7 items, no "hit a snag", 0 errors. The real-key half is **left to the parent**. | `3b-ctrlz-devtools.txt/.png` |
| 3.2 Tab open, `cb undo "Oldest restore"`: exit 1 with the same words, tab fine | **PASS** | `exit 1`, stderr: `cardboard: undo: Can't undo that: the project would be left empty`. No new version, the editor is unchanged, no crash banner, 0 errors. | `3c-cbundo.txt/.png` |
| 3.3 Allowed undo ×3 on "Oldest restore": Delete W6, wait for the version, Ctrl+Z; after 30 s the undo is still head, with no `external:project.json edit` | **PASS on what ORDERS checks** (but see **N-1, P2**) | In all 3 runs, 30 s after Ctrl+Z, head is still the `person undo`, and nothing came after it (no external edit). No crash, 0 errors. **But the Ctrl+Z doesn't bring W6 back.** Each Delete saved "Deleted title 'W6'" and then "Deleted media 'Text: W6'". Ctrl+Z only reversed the media half ("Added media 'Text: W6'"), so the editor and disk still had 6 items. A second Ctrl+Z ("Added title 'W6'…") brought W6 back, and I did that before each following run. | `3d-undo-{1,2,3}.txt`, `3d-compare-steps.txt`, `3e-compare.txt`, `3f-second-ctrlz*.txt`, `3g-history-panel.png`, `3g-history-rows.txt`, `3d-history-final.txt` |
| 3.4 Repeat on "Oldest newcut" | **PASS on what ORDERS checks** (same N-1) | Recovered by History → cut menu → Main cut: 7 items, 0 errors (`3h-…`). DevTools Ctrl+Z right after the switch did nothing: no toast, no version, timeline unchanged. `cb undo` was **allowed** here, which is correct: it undid the agent build (main@3) back to main@2, a valid empty project (named, 16:9, the clip in media; `compare` main@0→@2), not the broken state. No crash. I restored the content via History, then did the 3 allowed undos: each kept the undo as head for 30 s, with no external edit and 0 errors. Each Ctrl+Z only reversed the media half (N-1). A second Ctrl+Z brought W6 back each time. | `3h-…`, `3i-newcut-ctrlz-devtools.txt`, `3j-newcut-cbundo.txt`, `3k-…`, `3l-…`, `3m-newcut-redo.txt`, `3n-newcut-undo-{1,2,3}.txt`, `3n-newcut-compare-steps.txt`, `3n-newcut-second-ctrlz-*.txt` |
| 4.1 New project: `cb restore <p> main@1`, then `main@3`. Top-level `media` lists the clip (`ownedByBundle: true`). `cb project list` / `media list` / `app open` print no "[library] Recovered…", also after a restart | **PASS** | Both restores exit 0 (`main@4`, `main@5`). With the app closed, `project.json` has top-level `media` = `[{mediaId: efbc3654…, nativePath: …\P4 CLI.cardboard\media\efbc3654….mp4, ownedByBundle: true}]`. The 7 `project.media[]` entries have dates. stderr was **empty** for `project list`, `media list "P4 CLI"`, `history`, `source print` (app closed), and for `project list`, `media list` (both projects) and `app open "P4 CLI"`, both with the app running and after a restart. | `4a-cli-restores.txt`, `4b-pj-p4cli.txt/.json`, `4c-cli-appclosed.txt`, `4d-cli-warnings.txt` |
| 4.2 Fresh `dl` copy: Restore `main@4` and `main@5` both refuse with "Nothing to restore: that version is empty (nothing of the project is in it)" | **PASS** | GUI Restore on "Restored an earlier version" (main@4) and "Named the project 'Oldest restore'" (main@5): both toasts read exactly "Nothing to restore: that version is empty (nothing of the project is in it)". No new version, 0 errors. | `4e-gui-restore-main4.txt/.png`, `4f-gui-restore-main5.txt/.png` |
| 4.3 `cb restore "Oldest restore" main@4` prints "main@4 holds nothing of the project…" | **PASS** | `exit 1`: `cardboard: restore: main@4 holds nothing of the project: there is nothing in it to restore. Pick another version (see \`cb history\`).` (main@5 gives the same with `main@5`.) | `4i-cli-refusals.txt` |
| 4.4 `main@0` still says "the history starts there" | **PASS** | CLI: `main@0 is where the history starts, before the project was added: there is nothing in it to restore. The project as it was first saved is main@1.` GUI: the "Started the cut" row's Restore item reads "The history starts here, before the project was added. There's nothing to restore." | `4i-cli-refusals.txt`, `4g-gui-restore-main0.txt/.png` |

The old bugs are fixed:
- **P1-1:** recovered projects save GUI edits, including after a restart and on the old-build fr-dl3 copy, and the dates are written and repaired.
- **P2-1:** no crash, and no `external:project.json edit` overwriting the undo.
- **P3-1:** no "[library] Recovered…" warning.
- **P3-2:** the wording is right.

## New bugs

### N-1 (P2). Deleting a title saves two versions, and Ctrl+Z undoes only one of them. Not specific to recovered projects.

Repro (prod3 build, any project with titles, e.g. `mkproj.js carton-prod3 <profile> on "P4 Healthy"`):
1. Open the project. Click title W6 on Agents and press Delete.
2. `cb history <p> --stats`: two `person edit` versions. `cb compare` shows one is "Deleted title 'W6'" and the other is "Deleted media 'Text: W6'". The History panel shows both as separate rows (`3g-history-panel.png`).
3. Press Ctrl+Z once.

Expected: W6 comes back (title and its media entry) in one undo.

Actual: only the newer of the two versions is undone. The order of the two saves varies:
- **Title deleted first, then media.** All 3 runs on "Oldest restore" (p3r-b), all 3 on "Oldest newcut". Ctrl+Z only saves "Added media 'Text: W6'". W6 stays gone from the timeline and disk (6 items), so to the user Ctrl+Z seems to do nothing. A second Ctrl+Z brings the title back.
- **Media deleted first, then title.** p3r-a's first Delete, and "P4 Healthy" (`4h-healthy-compare.txt`). Ctrl+Z brings the title back on screen, but the "Deleted media 'Text: W6'" version stays. The project is left with the title and no media entry for it (later edits still saved, 0 errors).

Every title Delete I made saved two versions: on recovered projects, on the fr-dl3 copy (W3) and on the healthy project. The half-undo showed in every Delete + Ctrl+Z run I checked with `cb compare`: 7 of 7 (6 recovered, 1 healthy).

It predates this candidate, as far as I can tell: the previous report's healthy "FR Healthy" went from main@3 to `main@5` on one Delete. I had no other build to A/B it against.

Evidence:
- `3d-compare-steps.txt`, `3n-newcut-compare-steps.txt`, `4h-healthy-compare.txt`, `4h-healthy-delete.txt`
- `3g-history-panel.png`, `3f-second-ctrlz.txt`
- profile `p3r-c` (kept)

### N-2 (P3, observation, regression status unknown). Selecting a title away from the playhead blanks the paused preview until the playhead moves.

Repro (healthy project "P4 Healthy": clip at 0–3 s on Mine, titles on Agents):
1. Playhead at 0:01; the preview shows the clip (`4l-sel-0-before.png`).
2. Click title W5 (4–5 s) on the timeline to select it. The playhead stays at 0:01.

Actual:
- The preview turns black, apart from W5's transform box and text toolbar (`4l-sel-1-selected.png`). The Library panel goes blank.
- After Escape, the preview **stays black** at 0:01 (`4l-sel-2-escape.png`), as it does after a Delete (`4k-blk-1-after-delete.png`).
- It comes back after a play or a real playhead move. `cb app seek` to the same time doesn't bring it back.

This explains the black paused frames I measured on the recovered projects (`2g-preview.txt`, `3d-preview.txt`, `3o-newcut-preview.txt`). Those came from my selection clicks, not from recovery or saving. The fr-dl3 copy, edited away from that pattern, kept its picture (`2i-fr-preview-*.txt`).

No other build was available to tell whether Cardboard 1.4.0 itself does this.

### N-3 (P3). The "couldn't be saved" toast has a success icon.

`window.__carton.saveFailed(new Error("x"))` shows "Your last change couldn't be saved. It's on screen, but it isn't in the project yet." with the green ✓ that success toasts use (`2f-savefailed-toast.png`). A save failure should show a warning or error icon.

## Observations

- Every editor session logged one `MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 main:event listeners added` (`IpcRenderer.addListener`). It also appears on healthy projects, and nothing seemed to break. It's a warning, not an error.
- On a fresh `dl` copy, the first start saves "Named the project…" on each broken project (main@5 on "Oldest restore", From empty@1 on "Oldest newcut"), as in the previous check.
- The fr-dl3 copy's `project.json` pointed its top-level `nativePath` into `fr-dl3` until its first save, which rewrote it to the copy's own path. `fr-dl3` was not written (md5).

## Profiles, processes, disk

- **Kept:** `D:\cbwork\carton\profiles\p3r-c`, the healthy-project repro of N-1 ("P4 Healthy" history with the split delete/undo; "P4 CLI" is the item 4.1 project).
- **Deleted:** `p3r-a`, `p3r-b`, `p3r-d`, `p3r-fr`.
- **Not touched:**
  - `profiles\dl`: md5 of all 331 files identical before and after (`dl-md5-*.txt`).
  - `profiles\fr-dl3`: all 353 files identical (`frdl3-md5-*.txt`).
  - Other profiles, the installed Cardboard, the user's profile, and the repo (nothing built, no checkout, no edits).
- **Stopped by PID** (`taskkill /T /F`): 26452, 27556, 9736, 30240, 22940, 33224, 13340, 9152, 25960. None of my processes is left, and nothing listens on 9370–9379. Other Cardboard instances (not mine) were left alone.
- **Evidence:** this folder, about 4 MB: `.txt` logs, `project.json` media extracts, md5 lists, 30 screenshots. Scripts: `lib.js`, `my.js`, `restore.js`, `del.js`, `guard.js`, `ctrlz.js`, `newcut.js`, `savefailed.js`, `look.js`, `blk.js`, `selblk.js`, `pj.js`.
