# Restore and media fixes: real-app re-check of the final release candidate

> Pushed from the laptop on 2026-11-02 for the fixers (fix/recover-save). Final candidate `out/carton-final` @ `0cc587f1`. `shots/` holds the P1-1 and P2-1 shots (plus 2 PASS shots); the rest named below stay on the laptop in `D:\cbwork\regress\final\restore\`. `console-errors.txt`: exact console errors with stacks. `project-json/`: a recovered project.json (no dates on `media[]`), a healthy one, and the rc's recovered one.

Build: `out\carton-final` (`merge/prod-2` @ `0cc587f1`), `CARDBOARD_CARTON=1`.

How I tested:
- Driven only over DevTools: mouse and keys through `Input.dispatch*`, screenshots through `Page.captureScreenshot` of the app's own page.
- Each instance had its own profile, started by `launch.ps1`, on ports 9370–9374.
- No real input, and no window was brought to the front.
- "Picture vs black" was read in two ways. I looked at the screenshots, and I measured the preview canvas area of each screenshot inside the page (a 2D canvas). The probe is in `lib.js` `shotLuma`.
- Baseline: `D:\cbwork\regress\restore-root\REPORT.md`, on the previous candidate.

## Results

| Item | Result | What I saw | Evidence |
|---|---|---|---|
| 1a. GUI round trip: Restore "Started the project's history" (main@1), then the newest version | **PASS** | After main@1 the timeline is empty. After the newest ("Added 2 tracks, 4 clips and 3 media files") it has Mine + Agents with 4 items. The Library tile has its thumbnail and the "0:24" badge, and the clip has its filmstrip. The paused frame at 1 s shows the picture. Space plays the picture straight away, not black. `cb media list`: `clip.mp4 0:24 18.9 MB ok`. `cb source print`: `24.0s 1920x1080 30fps`. No `[library] Recovered…` line. After an app restart it's still all there. | `1-initial-*.png`, `1-gui-main1.png`, `1-gui-newest.png`, `1-gui-after-paused.png`, `1-gui-after-playing.png`, `1-restarted-*.png` |
| 1b. Same round trip with `cb restore` (main@1, then main@3) | **PASS** (one P3 left, see P3-1) | Both restores exit 0. After main@1, `cb media list` is empty. After main@3 it shows `clip.mp4 0:24 18.9 MB ok`, and `source print` shows `24.0s 1920x1080 30fps`. In the GUI the tile has its thumbnail and "0:24", and the clip plays its picture. On disk, `project.media[]` has duration, size, width, height and frameRate. Left over: the top-level `media` path list stays `[]`, so every `cb` command prints `[library] Recovered 1 unlisted media path(s)` until the next save (P3-1). | `1-cli-after-paused.png`, `1-cli-after-playing.png` |
| 2. Recovery of the 2 broken projects, playback without a restart | **PASS** for what was asked (but see **P1-1**: the recovered projects can't save GUI edits) | **rr-dl is no longer broken**: the previous check recovered it, and its two `project.json` match `3e-after/`, not `3e-before/`. So I used copies of `profiles\dl`, whose files match `3e-before/` byte for byte (name missing, 0 tracks / items / media; `before/`). On the final build: "Oldest restore" → History → Restore "Added 2 tracks, 7 clips and 6 media files" gives Mine + Agents, the clip and W1–W6. The thumbnail and "0:24" are back. Seek 1 s shows the picture, and playing shows the picture, with no restart. "Oldest newcut" → cut menu → Main cut gives the same: picture paused and playing. `cb media list` shows `0:24 18.9 MB` for both. | `before/*.json`, `2-restore-before.png`, `2-restore-after.png`, `2-restore-paused.png`, `2-restore-playing.png`, `2-newcut-before.png`, `2-newcut-paused.png`, `2-newcut-playing.png` |
| 3. `cb undo <p> 0` is refused and names main@1 | **PASS** | `cb undo "FR Root" 0` and `cb undo "FR Root" 00` both exit 1 with `undo: main@0 is where the history starts, before the project was added: there is nothing in it to restore. The project as it was first saved is main@1.` History is unchanged. | CLI output (in this report) |
| 4. A broken project in the library: `cb history <another project>` prints no warning | **PASS** | While "Oldest restore" was still broken, stderr was empty for `cb project list`, `cb history "Oldest newcut"`, and `cb history` / `media list` / `source print` / `cut list` on a healthy project "FR Healthy". The `[carton] project 5bd486c4…'s project.json can't be read…` line appears only on `cb history "Oldest restore"`, the broken project itself. | `4-err-*.txt` (empty files = no stderr; `4-err-hist-restore.txt` has the one expected line) |
| 5. Restore moves the library's "Updated" time | **PASS** | `cb project list`: a GUI Restore on FR Root moved it from 9:14:13 pm to 9:19:13 pm. `cb restore` on FR CLI moved it from 9:14:54 pm to 9:19:18 pm. The Projects page went from "1 minute ago" to "just now" for both, and FR CLI moved to the top. The recovered projects moved from 8:59:53 am / 9:00:32 am to 9:17:23 pm / 9:18:08 pm. | `5-projects-before.png`, `5-projects-after.png` |
| 6. Regression sanity: GUI edit, Ctrl+Z / Ctrl+Shift+Z over DevTools, `cb source apply`; every save lands; no `refused.log` | **FAIL** | **Normal projects pass.** On FR Root (after its round trip) and FR CLI: a GUI drag of W2 saved `main@10 person edit` ("Added track 'Text 1'; moved 'W2' to 'Text 1'"). Ctrl+Z saved `main@11 undo`, the exact inverse. Ctrl+Shift+Z saved `main@12 revert`. `cb source apply` (+ "Hello") saved `main@13`, and the editor shows Hello. FR CLI went @8–@11 the same way. **Recovered projects fail.** On "Oldest restore" and "Oldest newcut", no GUI edit is ever saved (**P1-1**). Ctrl+Z right after recovering crashes the tab (**P2-1**). `cb source apply` does land on them, but it throws away the unsaved GUI edit. There is no `refused.log` in any bundle, but that doesn't mean every save landed: the failing saves die in the page before they reach disk. | `6-frroot-undo-redo.png`, `6-frroot-apply.png`, `6-frcli-*.png`, `6-oldest-crash.png`, `p1-*.png`, `8-*.png` |

## New bugs

### P1-1. A project recovered through History can't save any GUI edit. The edits are silently lost, and a restart doesn't help.

Repro (final build, fresh copy of `profiles\dl`, i.e. the 2 projects broken by the old bug):
1. Copy `D:\cbwork\carton\profiles\dl` to a new profile and start the final build on it with `CARDBOARD_CARTON=1`.
2. Open "Oldest restore". History → ⋯ on "Added 2 tracks, 7 clips and 6 media files" → Restore. It comes back and plays (item 2).
3. Click W6, the last title on Agents, and press Delete. A drag, or any other edit, does the same.

Expected: a new version (`person edit`), and `cb source print` shows 6 items.

Actual:
- The editor shows W6 gone. But `cb history` doesn't move, and `cb source print` still says `2 tracks · 7 items`. It stays that way for minutes.
- The page console prints these errors on every edit:
  - `Failed to save timeline to IndexedDB: RangeError: Invalid time value at Date.toISOString at p9 (app://cardboard/assets/installErrorTelemetry-DxKId8tA.js:196:87925)`
  - `Failed to update scoped project data: RangeError: Invalid time value` (same frame)
- Nothing tells the user. There is no `refused.log` and nothing in the activity log.
- After the failed edit, the paused preview frame draws **black**. The picture comes back while it plays (`8-before-edit-paused.png` vs `8-after-edit-paused.png`).
- A `cb source apply` (or any agent edit) lands. The editor then reloads from disk, so the user's GUI edit is gone (`p1-after-apply.png`: W6 back). GUI edits made after that fail the same way.
- **An app restart doesn't fix it.** After closing and relaunching, the same Delete fails with the same errors (`p1-after-restart-after-delete.png`).
- "Oldest newcut", recovered by switching to Main cut, fails the same way.
- A healthy project in the same library ("FR Healthy") saves normally (`main@5 person edit`, no errors).

Cause, as far as I can tell:
- In the recovered `project.json`, all 7 `project.media[]` entries that came back from history have only `{id, data}`, with no `createdAt` / `addedAt`.
- `p9` serialises each entry with `t.createdAt.toISOString()` / `t.addedAt.toISOString()`, so every scoped save throws.
- Media added later (the "Hello" title from `cb source apply`) has both dates, as do the media in normal-flow projects after a restore.
- The fix probably belongs where a restore or recovery writes media entries without dates.

Evidence: profile `D:\cbwork\carton\profiles\fr-dl3` (kept), `p1-after-apply.png`, `p1-after-restart-after-delete.png`, `p1-healthy-after-delete.png`, `8-before-edit-paused.png`, `8-after-edit-paused.png`. The script is `p1-repro.js` (`node p1-repro.js "Oldest restore" "Added 2 tracks" <prefix>`, with `CDP_PORT`, `CB_PROFILE`, `CB_PROJECT`).

### P2-1. Ctrl+Z, or `cb undo`, right after recovering a broken project crashes the editor tab.

Repro (fresh copy of `dl`, final build):
1. Open "Oldest restore" and restore "Added 2 tracks, 7 clips and 6 media files" (as in P1-1).
2. Press Ctrl+Z, or run `cb undo "Oldest restore"` while the tab is open.

Expected: the restore is undone and the editor shows the empty project.

Actual:
- The undo is saved: `main@N undo`, which `cb compare` describes as "Cleared the aspect ratio, deleted 2 tracks, 7 clips…". The project is back in its broken state, with no aspect ratio.
- The editor tab shows **"This tab hit a snag. Your project files are safe."**
- Console: `TypeError: Cannot read properties of undefined (reading 'split') at Ge (app://cardboard/assets/LayoutsPanel-BztyTnqC.js:1:6929)`.
- "Reload tab" opens an empty project with Undo and Redo greyed. The redo is lost, so the user has to Restore again in History.
- `cb undo` from an agent crashes the user's open tab the same way. Meanwhile `cb source print` reports that state as `16:9 · 0 tracks`, so the CLI fills in a default aspect ratio and the editor doesn't.
- Restoring that broken version directly is refused, both in the GUI and with `cb restore … main@4` ("Nothing to restore: that version is empty…"). Undo and redo go around that guard.
- Opening the broken project at startup doesn't crash. Only the undo path does.

Seen 4 times: Ctrl+Z twice on one copy, Ctrl+Z once and `cb undo` once on a second copy.

Evidence: `6-oldest-crash.png`, `7-repro-restored.png`, `7-repro-ctrlz.png`, `7-reloaded.png`, `7-cbundo.png`; script `crash-repro.js`.

### P3-1. After a `cb restore` round trip, every `cb` command warns about that project until its next save. This is what's left of old P2-1.

Repro:
1. `mkproj` a project.
2. `cb restore <p> main@1`, then `cb restore <p> main@3`.

Actual:
- Duration, size and thumbnail are fine.
- The project's top-level `media` (path) list in `project.json` stays `[]`.
- Every `cb` command, including ones about other projects (`cb project list`, `cb media list "FR Root"`, `cb app open`), prints `[library] Recovered 1 unlisted media path(s) in …\FR CLI3.cardboard` on stderr.
- It survives an app restart, and goes away at the project's next real save (a `cb source apply` with a change, or a GUI edit). A no-change `source apply` doesn't clear it.
- The GUI round trip doesn't do this.

### P3-2. The refusal for the old broken version describes it wrongly.

Restoring the old broken "Restored an earlier version" (main@4, 09:00 AM) gives "Nothing to restore: that version is empty (the history starts there, before the project was in it)", in both the GUI toast and `cb restore`. The refusal itself is right. But main@4 isn't where the history starts: it's a later version that the old bug emptied (`7-broken-row.png`).

## Observations (not bugs)

- On its first start on the broken library, the app saves a "Named the project '…'" version on each broken project (`From empty@1` on "Oldest newcut", `main@5` on "Oldest restore"). This is harmless, and it's what makes them listable.
- At the default zoom, a narrow title (1 s wide) only takes a press near the top or bottom edge of its block, not the middle. `carton-fold` behaves the same, so it isn't a regression. That's why my first drags missed, and why a missed drag plus Ctrl+Z ran into P2-1.
- The titles don't show over the clip because the clip's track "Mine" is above "Agents". The baseline's after-restart screenshots look the same.

## Profiles, processes, disk

- **Kept:** `D:\cbwork\carton\profiles\fr-dl3`, the evidence for P1-1. Its "Oldest restore" is recovered, plays, and fails every GUI save. It is also the clean repro (main@6 restore, main@7 `cb source apply` "Hello").
- **Deleted:** `fr-main`, `fr-dl`, `fr-dl2`, `fr-fold` (a carton-fold profile for the click-test comparison).
- **Not touched:**
  - `profiles\dl`: the md5 of all 331 files is identical before and after (`dl-md5-before.txt`, `dl-md5-after.txt`).
  - `profiles\rr-dl`: only read. No file in it changed during this session, and its two `project.json` still match `3e-after/`.
  - The installed Cardboard, the user's profile, and the repo (no checkout, no edits, nothing built).
- **Stopped by PID** (`taskkill /T /F`):
  - 2908 and 29760 (fr-main)
  - 11716 (fr-dl)
  - 22464 (fr-dl2)
  - 24048, 34760 and 8316 (fr-dl3)
  - 22844 (carton-fold, fr-fold)

  Nothing listens on 9370–9379 any more. Other ports were not touched.
- **Evidence:** this folder, about 4.6 MB of screenshots, project.json copies, md5 lists and the scripts (`lib.js`, `state.js`, `restore.js`, `newcut.js`, `projects-page.js`, `edit6.js`, `crash-repro.js`, `reload.js`, `broken-row*.js`, `p1-repro.js`, `savewatch.js`, `yscan.js`, `clicktest*.js`, `probe.js`).
