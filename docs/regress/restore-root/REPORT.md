# restore-root: real-app check on Windows

> Pushed from the laptop on 2026-11-02 (step 2 on `out/carton-rc` @ `12826273`). `shots/` here holds only the shots for the new bugs: the P2s. Every other shot named below is in the full set, which stays on the laptop at `D:\cbwork\regress\restore-root\`.


Build: `out\carton-rc` (commit `12826273`, `merge/prod-2`, contains all of `origin/fix/restore-root` up to `5069d94`), `CARDBOARD_CARTON=1`.
Driven only through DevTools (CDP), on my own profiles (`rr-main` on port 9380, `rr-dl` on 9382, `rr-base` on 9381 for one comparison). The repo checkout stayed at `12826273`, unchanged.

## 1. Results

| Item | Result | Evidence | Screenshot |
|---|---|---|---|
| 3a Create, import, title, edits | PASS | `mkproj` "RR Root" (clip.mp4 + W1–W3). GUI drag W3 → Ctrl+Z → Ctrl+Shift+Z → drag W2 (versions @4 edit, @5 undo, @6 revert, @7 edit). `cb source apply` added the title "Hello" (@8). | `3a-opened.png`, `3a-edited.png` |
| 3b ⋯ on "Started the cut" | PASS | Menu is only "Compare with current", "Name this version" and a greyed Restore (`aria-disabled=true`) reading "The history starts here, before the project was added. There's nothing to restore." No Preview, no "New cut from here". Clicking the greyed Restore does nothing. | `3b-root-menu.png` |
| 3c Restore main@1, then newest, then restart | PASS (but see bug P2-1) | Restore of main@1 gives an empty timeline. The tab and `cb project list` still say "RR Root". Restore of the "Hello" version brings back 4 tracks / 5 items. After killing and relaunching the app, the project is on Projects and in `cb project list`, and it reopens with 4 tracks / 5 items. Note: main@1's row is labelled **"Started the project's history"**, not "Imported the project". | `3c-restore-main1.png`, `3c-restore-newest.png`, `3c-restart-projects.png`, `3c-restart-editor.png` |
| 3d CLI at main@0 | PASS | `cb restore`, `cb cut new … X --from main@0` and `cb publish` each exit 1: "main@0 is where the history starts, before the project was added: there is nothing in it to restore / make a cut from / publish. The project as it was first saved is main@1." `cb history` ends with `main@0 … root (empty)`. The git words `revert`, `branch --from` and `tag` refuse the same way (exit 1). | n/a (CLI) |
| 3e Recovery of the 2 broken projects (copy `rr-dl`) | PASS (media metadata not recovered, see section 3) | Before: both `project.json` had no name and 0 tracks / items / media (saved in `3e-before/`). On the RC: both listed by name (Projects, tabs, `cb project list`). `cb history` and `cb cut list` exit 0 on both. **Oldest restore**: restoring "Added 2 tracks, 7 clips and 6 media files" (the row before the old "Restored an earlier version") brings back the name, Mine + Agents, the clip and W1–W6. **Oldest newcut** (the old bug left it on an empty "From empty" cut): switching to Main cut in the panel brings back the same. Both still good after an app restart (`3e-after/*.json`: name, 2 tracks, 7 items). | `3e-library.png`, `3e-restore-before.png`, `3e-restore-after.png`, `3e-newcut-before.png`, `3e-newcut-after.png`, `3e-*-restarted-1s.png` |
| 3f No `refused.log` during the session | PASS | `find profiles/rr-main -iname "refused*"` finds nothing, and nothing matches "refus" in `userdata/logs`. Checked with `ls`/`find` only. | n/a |
| Extra (report step 2): double-click on "Started the cut" previews nothing | PASS | Double-click: no "Previewing" banner, editor unchanged. | `3b-root-dblclick.png` |
| Extra (step 6): no false refusals across GUI edits, Ctrl+Z / redo, cut switch, fold in, `cb source apply` | PASS | On RR Root: GUI new cut "Alt cut", `cb source apply` on it, GUI switch back to Main, GUI "Fold in" (main@12 merge, "W1 alt" landed), Ctrl+Z / Ctrl+Shift+Z after the fold (@13 / @14), `cb cut switch` both ways, 4 restores. Every save landed, and there is no `refused.log` in either bundle. | `6-hf-newcut.png`, `6-hf-fold.png`, `6-undo-redo.png` |
| Extra: a fork's own empty start ("From empty", `fork (empty)`) | PASS | Its "Started the cut" row has the same greyed Restore with the same line, and no Preview or New cut. | `3e-newcut-fork-root-menu.png` |
| Extra: `dl` profile untouched | PASS | md5 of all 331 files before and after are identical (`dl-md5-before.txt`, `dl-md5-after.txt`). | n/a |
| Extra (step 7, optional): `cb project create` in a OneDrive folder | NOT RUN | It would write into the user's real OneDrive, which syncs to the cloud. Outside my test library. | n/a |

## 2. New bugs

**P2-1. A clip comes back from Restore without its duration, size or thumbnail. This happens in the normal flow too, and it predates this fix.**
- Repro, RC, fresh profile:
  1. `mkproj` "RR Undo" (`cb media list` shows clip.mp4 `0:24`, 1920x1080, 30 fps).
  2. `cb restore "RR Undo" main@1`.
  3. `cb restore "RR Undo" main@3`.
  - The same happens in the GUI: History → Restore "Started the project's history", then Restore the newest edit.
- Expected: clip.mp4 back as it was.
- Actual:
  - `cb media list` shows DURATION `-`, and `cb source print` lists no length, size or fps.
  - The Library tile is blank, without "0:24", and the timeline block has no filmstrip.
  - In `project.json` the video entry is `{type, fileName}` only.
  - Every `cb` call prints `[library] Recovered 1 unlisted media path(s) in …`.
  - It lasts through an app restart and through later saves.
  - Preview playback still works on the normal-flow project.
- The pre-fix build `out\carton-fold` behaves the same, so it isn't a regression from restore-root. But the new refusal message now sends users to main@1 ("The project as it was first saved is main@1"), which makes this path likely.
- Evidence: `3c-after-newest-library.png`, `3c-restart-editor.png`; profile `rr-main` (kept).

**P2-2. Right after recovering a broken project, its clip draws black until the app restarts.**
- Repro: on `rr-dl` (RC), open "Oldest restore" and in History restore "Added 2 tracks, 7 clips…" (or switch "Oldest newcut" to Main cut). Seek to 1 s, or play.
- Expected: the clip.mp4 picture.
- Actual: the preview is black, with only the title on top, paused and while playing.
- After closing and relaunching the app, the same projects draw the clip correctly (`3e-restore-restarted-1s.png`). Workaround: restart the app.
- I didn't see this on the normal-flow project (RR Root drew the clip after its round trip).
- Evidence: `3e-restore-playing.png`, `3e-restore-paused-1s.png`, `3e-newcut-after.png`.

**P3-1. `cb undo "<p>" 0` quietly undoes the newest change.**
- `cb undo "RR Undo" 0` printed "Undo Claude Code: edit" and emptied the timeline, which is a plain undo.
- `cb undo "RR Undo" 1` restores main@1.
- Rev 0 is treated as "no rev" rather than refused like `cb restore main@0`. It's reversible, so it isn't data loss.

**P3-2. The "can't be read" warning prints on every `cb` command, including ones about other projects.**
- While "Oldest restore" was still broken, every `cb` command printed `[carton] project 5bd486c4…'s project.json can't be read by Cardboard (no name); it is listed through its history…` on stderr, even `cb history "Oldest newcut"`.
- It's gone once the project is restored.

**P3-3. Restore doesn't update the library's "Updated" time.**
- After two Restores, `cb project list` still showed 4:36:16 pm. It changed only on the next `cb source apply`.
- The recovered projects also still show 8:59 am / 9:00 am.
- Not compared against the pre-fix build.

Unrelated observation, not investigated: after dragging W2 to 4 s, the Director chat's context chip still read "W2 1.0s–2.0s" (`3b-root-menu.png`).

## 3. What the recovered projects (3e) look like

- **Restored:** name, 16:9, 6.0 s, tracks Mine + Agents, clip.mp4 0–3 s, W1–W6 titles, and the library entries' ids, kinds, file names and text. `project.json` is readable by Cardboard and still is after a restart.
- **Not restored:**
  - clip.mp4's duration (`-` in `cb media list`, no "0:24" on the tile), size, dimensions and fps;
  - the Library thumbnail (blank tile with only "Added") and the timeline filmstrip (plain blue block);
  - the top-level `media` (path) list, which stays empty.
  - The media file itself is still in `media/`.
- **Playback:** black until the app restarts (P2-2). After a restart the clip plays normally.
- Evidence: `3e-restore-paused-1s.png` (before restart), `3e-restore-restarted-1s.png`, `3e-newcut-restarted-1s.png`, and `3e-before/` and `3e-after/` for the `project.json` before and after.

## 4. Processes and disk

- **Stopped:** every instance I started was killed by pid with `taskkill /T /F`: 3168 and 26248 (rr-main), 27960 (rr-base), 5764 and 19420 (rr-dl). Nothing listens on 9380–9384 any more. Other people's instances (ports 9362, 9363, 9390) were not touched.
- **Left on disk:**
  - `D:\cbwork\carton\profiles\rr-dl`: the recovered copy, as asked.
  - `D:\cbwork\carton\profiles\rr-main`: kept as evidence of P2-1 (RR Root and RR Undo with the stripped clip).
  - `D:\cbwork\regress\restore-root\`: screenshots, the before/after `project.json` copies, md5 lists, my driver scripts and this report (about 4.4 MB).
- **Removed:** `rr-base`, the pre-fix comparison profile (its result is recorded above), and my temp files.
- **Not touched:** `D:\cbwork\carton\profiles\dl` (md5-verified) and the user's own Cardboard.
