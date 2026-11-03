# Orders for the laptop manager (from the EC2 orchestrator)

The EC2 box can't reach this laptop: the Wi-Fi blocks the relay's port 7844. Calls from the laptop to EC2 still work.
So the orders travel here, on branch `ops/laptop-orders`. **Re-fetch this file before each step** (`git fetch origin &&
git show origin/ops/laptop-orders:docs/laptop/ORDERS.md`). New orders are added under "Updates" at the bottom.

**Report back** with `t3_thread_send` to the orchestrator: env `4af1627e-f00b-442b-8b63-7b28fabc3fba`, thread
`34ab41b4-a742-4531-9258-277aa461340b`, mode `queue`. Send one short message at each step's end. Full details stay in
your thread and in `D:\cbwork\`.

Your role, device duties and rules are unchanged: disk floor 8 GB, mains power for any timing, the keep-awake, your own
profiles and ports, never the user's Cardboard, no GitHub workflows, at most 3 subagents, subagents only through T3
`delegate_task`, clips with neutral footage only and never during file dialogs.

## 0. Start
- Run the device checks and restart the keep-awake.
- Remove the two leftover worktrees listed in RESUME.md.
- Delete the old A/B builds you no longer need, but keep `out/carton-fix` (`26aaf6e`), `out/carton-save` (`67377fa`) and
  `out/carton-fold` (`b4ff5fe`) until the timing runs (step 3) are done.

## 1. Build the release candidate
- **Build:** `merge/prod-2` @ `12826273`, Carton on, into `out/carton-rc`. A newer head may be listed under Updates; use
  the newest.
- **What it holds:**
  - every fix: bugs 1–9; restore-root; History withdraw rows; ui-history; ui-polish rounds 1 and 2, with the share
    crash built on your WIP; cf-hardening; the preview path;
  - **not** `perf/laptop-save` (step 3 decides).
- **On Linux it's green:** typecheck, every package (e2e 63/63), all 28 app sync files, size budgets.

## 2. The final Windows regression (real app, `out/carton-rc`)
Record short clips of the key passes (neutral footage).

1. **Share crash (P1-1):** two instances, Share tab open, teammate present, on both sides, 3/3. No "This tab hit a
   snag".
2. **Bug 8:** a real in-app turn on the user's own Claude Code. The user's Claude limit has reset.
   - The turn is named from the prompt and credited to Claude Code, not "Director".
   - `timeline.tsx` isn't held after the turn ends.
3. **Restore-root** (the steps from fix/restore-root's report):
   - 3a. Create a project, import a clip, add a title, make edits.
   - 3b. History → ⋯ on "Started the cut": no Preview, no "New cut from here", Restore greyed with the "history starts
     here" line.
   - 3c. Restore on "Imported the project" keeps the name (empty timeline); restoring the newest edit brings the content
     back. The library still lists the project after an app restart.
   - 3d. `cb restore "<p>" main@0`, `cb cut new "<p>" X --from main@0` and `cb publish "<p>" main@0` each exit 1 and
     name main@1. `cb history` shows `root (empty)`.
   - 3e. **Recovery:** start the build over the 2 projects that `915eb36` broke. Both are listed by name; `cb history` and
     `cb cut list` work. Restore the version before "Restored a version": name, tracks, clips and media come back. Note
     how media duration and thumbnails look; that part can't be recovered.
   - 3f. During a normal session, no `.carton\refused.log` appears in the bundle.
4. **ui-history:**
   - P1-2: sharing reads "Linked 'clip.mp4' for sharing", with no hash. An effect is named, never an id.
   - P1-3: a partial fold shows one row, "Folded … 2 of 3 changes · You". `cb history` shows `merge (1 left out)`.
   - P1-4: the Fold dialog offers "Left out earlier". Folding it in works. Undo leaves it out again and it's offered again.
   - P1-5: Restore reads "Restored an earlier version", and "N changes" expands the list.
   - P1-6: on a conflict card, Preview of Claude Code's side shows its side.
   - P1-10: "Agent turns" lists a Director turn and a Claude Code turn.
   - Undo right after Restore names the restore and works.
5. **ui-polish rounds 1 and 2:** the checklists from ui-polish's reports, matched to the audit's screenshots on
   `audit/ui-2026-11-02`. In particular:
   - Share failures read "Can't reach this address" (no "fetch failed").
   - Join → Open: no "Missing Media Files". Clips play from the preview or show Offline.
   - Esc and focus in every layer; the last row's menu opens upward; toasts after Fold in, Restore and Keep.
   - At 960 px the History panel floats and the preview stays.
   - Day groups with 150+ versions.
   - Below 1180 px, only the History icon in the title bar. Presence avatars and status dot by Share.
   - Compare lists the changes.
   - A Dashboard "Join a shared project" tile (Carton on only).
   - Ctrl+Shift+H toggles History.
   - Take screenshots for a before/after against the audit.
6. **Bugs 1–9 spot checks:** split → drag kept; redo works; split → drag → Ctrl+Z ×2 undoes both; Fold in credited to
   You.
7. **Shortcuts:** `scripts/test-shortcuts.js`, 25 page tests and 9 with `--os`, Carton on.
8. **G1:** 3 writers for 10 minutes, the person editing, with less zoom. **G2:** short. Use the existing harness.

## 3. Timing (essential only; on mains, nothing else running; every run listed and medians)
- **B, agent apply latency with the app open:**
  - 1 and 4 writers, Carton on vs off, on `out/carton-rc`.
  - Is G1's ~24 s p99 real?
- **C, save A/B:** GUI save round trip (0 and 4 writers) plus undo on the 1,500-item project:
  - `out/carton-fix` (base) against `out/carton-save` (`perf/laptop-save`);
  - `out/carton-fix` against `out/carton-fold` (fold-author's extra head read).
  - Report whether perf/laptop-save is worth merging.
- One separate subagent re-checks the numbers before you report them.

## 4. Wi-Fi test
`D:\cbwork\cflab\` (config valid until 2026-11-04 02:07 UTC). It runs over port 443, so it works on this Wi-Fi. Send the
results file's summary.

## 5. Report and wait
Send the full regression report: pass/fail per item, new bugs by priority, clips, timing medians, disk. Then **wait**.
The orchestrator merges to `main` and adds "Updates: reinstall" here when it's time. Fetch this file every ~10 minutes
while waiting; a T3 scheduled task on the laptop is fine for that.

## Updates

### Update 1 (2026-11-02 ~11:45 UTC): new release head `51f4d243`, previews only
`merge/prod-2` is now **`51f4d243`**. It adds one client-side change to shared previews (`fix/cf-proxy-path-r` @
`d9bce5e5`): the publish tail keeps 4 appends in flight, and playback keeps 2 reads in flight. Linux is green: typecheck,
media, host-http, server-cloudflare, e2e, size, and the live, cbproj, cbproj-offline, open-share and share-peers sync
files.
- **Carry on with step 2 on `out/carton-rc` (`12826273`) as you are.** Nothing else changed.
- **When step 2 is done:**
  1. Build `51f4d243` into `out/carton-rc2`, then delete `out/carton-rc`.
  2. Re-run only the preview and sharing items on it:
     - the Share crash, 3/3 on both sides;
     - Join → Open: the clip plays from its preview or shows Offline, with no "Missing Media Files";
     - one share of a ~1-minute clip to a second instance: the teammate's preview starts and plays to the end.
  3. Use `out/carton-rc2` for steps 3–4.

### Update 2 (2026-11-02 ~12:20 UTC): push the regression reports
EC2 is fixing the new P2s and P3s from 2.3–2.5. The fixers need the reports.
1. **Push them now** to a new branch `audit/regress-2026-11-02`, branched from `origin/main`, holding only docs:
   - `docs/regress/restore-root/REPORT.md` and `docs/regress/ui/REPORT.md`, plus any other step-2 REPORT.md;
   - **at most ~8 MB of screenshots**: the P2s' shots and a few P3s', downscaled or cropped if needed. Keep the full
     17 MB set on the laptop.
2. **Then carry on:** G1; the 9 `--os` real-key tests and the timing runs (step 3) when the user is idle; the Wi-Fi test
   (step 4).
3. **Rebuilds:** Update 1's rebuild to `51f4d243` still applies. The fixes now in progress (presence after a reconnect,
   read-your-writes after `cb source apply`, a split's wording and the cut menu, the restore media details, and the UI
   P2s) will land in a later head, given as Update 3, with re-check steps. Do the final re-check on that.

### Update 3 (2026-11-02 ~15:00 UTC): the final release candidate `0cc587f1`
`merge/prod-2` = **`0cc587f1`**: every fix. On Linux it's green: typecheck, 3,236 workspace tests with 0 failures, all 34
app sync files in the real 1.4.0 worker, the size budgets, and a re-test after the last merge.
1. **Build it** into `out/carton-final`, Carton on. Delete `out/carton-rc` once the build passes its checks. Keep the A/B
   builds until timing C is done, then delete them.
2. **Re-check on `out/carton-final`** (own profiles; DevTools while the user is at the laptop, real keys only when they're
   away):
   - **Presence after a reconnect:** `node check.js out/carton-final --trigger host --wait 180`, 3 runs. Both sides
     re-list each other within seconds.
   - **Read-your-writes:**
     - A real in-app Claude Code turn: "Set W2's font size to 321 with `cb source apply`, then immediately read
       `timeline.tsx` and tell me W2's font size". It must say 321 within the same turn.
     - In the same turn, after a GUI edit of yours, the agent's apply shows and your edit stays held until the turn ends.
     - 15 terminal applies with the app open, each read immediately: 15/15 show the change.
   - **The split wording:** split a clip, and History reads "Split '<file>' at N.N s"; split then move, and it reads
     "…, moved its right part …". In the Fold dialog a split is one row, and unticking it keeps the clip whole on Main.
   - **The cut menu:** `cb cut new "<p>" "30s cut"` appears in History's cut menu within ~1 s, and is still there after
     reopening.
   - **Media details:**
     - Restore "Started the project's history" (main@1), then the newest version: the clip keeps its thumbnail, plays at
       once, and `cb media list` shows its duration and size. Then the same via `cb restore`.
     - Recover a broken project (on a copy), then restore a pre-break version: the clip plays without a restart.
     - `cb undo <p> 0` is refused, naming main@1.
     - With a broken project in the library, `cb history <other>` prints no warning.
     - Restore moves the library's "Updated" time.
   - **ui-regress:**
     - With `CLAUDECODE=1` (no hook), a Claude Code view save reads "Claude Code" in History and on the card ("Keep
       Claude Code's"; the toast "Kept Claude Code's"). A plain terminal's view still reads "You".
     - History keeps your place when versions arrive, also after picking a row with the keyboard (`s-keepplace3.js`).
     - "Join a shared project" shows on an empty library and on the Projects page (Carton on only).
     - Esc returns from a preview: the first Esc deselects a clip, the next returns. From the History list, the first Esc
       returns and the second closes.
     - The comment box has no grip and grows to ~8 lines.
     - A first effect is named, the 300 px header is clean, Esc on a row menu then ↓ moves on, and a one-change row's
       toggle reads "Show the change".
   - **Spot checks:** the share crash 3/3 on one side; bug 6 (split → drag → Ctrl+Z ×2, then redo); page shortcuts
     25/25. Run `--os` 9/9 too when the user is away.
3. **Timing:** finish C. Then **B** (apply latency, 1 and 4 writers, Carton on vs off) on `out/carton-final`. A separate
   subagent re-checks every number.
4. **Report** with step 5's format, then wait for the merge to `main` and the reinstall order.

### Update 4 (2026-11-02 ~16:05 UTC): the network test on the phone hotspot
The user confirmed "V-Phone" is a phone hotspot and the laptop's only network (there's no Wi-Fi), so step 4 uses their
mobile data. Run it with half the upload:
1. **When:** after Update 3's re-checks and report, with nothing else running. Don't stop the re-checks for it.
2. **Run:** `cd D:\cbwork\cflab` then `node .\cf-lab-laptop.mjs .\config.json --upload-mb 100` (about 120 MB of data,
   5–10 minutes). If the folder is gone, ask the orchestrator for the pack.
3. **Once only.** If it fails part way, send the partial results file; don't re-run it.
4. **Send** the summary: edit latency, the 45 s cut and recovery, upload MB/s, the slowed link. Push the results file to
   `audit/regress-2026-11-02` under `docs/regress/network/`, unless it contains the config's tokens.
5. If the reinstall order has already arrived, run this test first, then the build.

### Update 5 (2026-11-02 ~18:20 UTC): the fixed head `eea781bb`, a short re-check
`merge/prod-2` = **`eea781bb`** = `0cc587f1` + `fix/fold-count` `de364a11` + `fix/ui-final` `e3e8a27b` + `fix/recover-save`
`0f1aac0c`. Each branch passed its own full Linux suite and one Codex review. The merges had only two small additive
conflicts. The combined Linux suite is running on EC2 now; I'll tell you if it finds anything. `perf/apply-latency` isn't
in (its timing is still being checked), so **skip timing B** this round.

1. **Build** `eea781bb` into `out/carton-prod3` with Carton on, as `carton-final` was built. Once its own checks pass,
   delete `out/carton-final`.
2. **P1-1, recovered projects save** (needs a fresh copy of `profiles\dl` each time):
   - Open "Oldest restore", then History → ⋯ on "Added 2 tracks, 7 clips and 6 media files" → Restore.
   - In `project.json`, all 7 `project.media[]` entries have `createdAt`/`addedAt`. The titles also have `format: "text"`,
     `size: 0`, `presetId: "custom"`.
   - Click W6 and press Delete. You get a `person edit` version, `cb source print` shows 6 items, and there's no
     "Invalid time value" in the console.
   - Restart, edit again: it saves.
   - On the kept **`fr-dl3`** profile (recovered under the old build), open "Oldest restore" and delete a title. It saves
     and writes the dates.
   - Optional: in DevTools run `window.__carton.saveFailed(new Error("x"))`. The stage toast "Your last change couldn't be
     saved…" appears.
3. **P2-1, undo after a recovery** (fresh `dl` copy, restored as in 2):
   - Ctrl+Z, with a real key and with a DevTools key: the toast "Can't undo that: the project would be left empty", no
     new version, no crash, the timeline unchanged.
   - With the tab open, `cb undo "Oldest restore"`: exit 1 with the same words, and the tab stays fine.
   - An allowed undo, 3 times: Delete W6, wait for its version, Ctrl+Z. After 30 s, `cb history` still has the undo as
     head, with no `external:project.json edit` after it.
   - Repeat on "Oldest newcut".
4. **P3-1 and P3-2:**
   - New project: `cb restore <p> main@1`, then `cb restore <p> main@3`. The top-level `media` lists the clip
     (`ownedByBundle: true`). `cb project list`, `cb media list` and `cb app open` print no "[library] Recovered …
     unlisted media path(s)", also after a restart.
   - On a fresh `dl` copy, Restore `main@4` and `main@5`. Both refuse with "Nothing to restore: that version is empty
     (nothing of the project is in it)".
   - `cb restore "Oldest restore" main@4` prints "main@4 holds nothing of the project…".
   - `main@0` still says "the history starts there".
5. **N1, Join from an empty library** (fresh profiles; a host on 8795):
   - Dashboard → "Join a shared project" → paste the invite → name → Join. "… is in your library now · Open / Done"
     stays for 5 s or more, and Open opens the project's tab.
   - Again from the Projects page with another fresh profile, once pressing Done.
   - Carton off: no Join control.
6. **N2–N5 and baseline P3s 2, 7, 9, 12b:**
   - N2: `s-escpreview.js sel-before "Added track"`: the first Esc deselects (the banner stays), the second returns.
     Also `sel-during`.
   - N3: `s-rowenter.js 2` with W6 selected: the row previews, no text editor opens, and ↑/↓ don't move the playhead.
   - Baseline 9: in a preview, Enter or a double-click on a title shows "Previewing an earlier version. Return to
     current to edit." and opens no editor. After Return, both edit normally.
   - N4: a one-change row's open toggle reads "Hide the change".
   - N5: playhead at 9.5 s, then preview the 8 s version: 0:08 / 0:08. Return puts it back at 9.5 s. Preview, click
     the ruler at 3 s, return: it stays at 3 s.
   - Baseline 2: Restore, then Ctrl+Z gives a row "Undid the restore"; redo gives "Redid the restore".
   - Baseline 7: in a 960 CSS px window, History is 300 px wide and ends above the timeline toolbar, with Fullscreen
     and Hide timeline clickable. Same with the chat collapsed.
   - Baseline 12b: fold some, then fold in the rest. That row has the fold icon; its undo has ↺.
7. **Counts** (fold-count):
   - Split a clip with auto reframe on: History reads only "Split 'clip.mp4' at 1.5 s".
   - New cut "Alt": split a clip and change a title's font size. Fold into Main: the dialog says "2 changes". Untick the
     split → "Fold in 1 of 2". Main's row reads "Folded 'Alt' into 'Main cut': 1 of 2 changes", and `cb history` says
     `merge (1 left out)`.
   - Fold in the rest: "Folded the rest of 'Alt' into 'Main cut': 1 change".
   - A project with 1 clip and 6 titles: the setup row reads "Added 2 tracks, video 'clip.mp4', 6 titles and media
     'clip.mp4'". Compare's Clips reads "1 clip, 6 titles". Compare's and Watch's change counts match, and Watch
     reads "Section 1 of M".
8. **Spot checks:** the share crash 3/3 (one side), bug 6, page shortcuts 25/25, and `--os` 9/9 when the user is
   away. `writers.js --writers 4 --rate 1 --seconds 120`: the table looks as before, and any failure prints a
   `failed: …` line.
9. **Report** in step 5's format: pass/fail per item, new bugs by priority, disk. Then wait. If all is green, the next
   order is the merge to `main` and the reinstall.

### Update 6 (2026-11-02 ~21:35 UTC): the last fixes, head `3b2407c3`
`merge/prod-2` = **`3b2407c3`** = `eea781bb` (your Update 5 pass) + `fix/one-action-one-undo` `a7b449d4` (N-1, N-3, writers
samples) + `fix/stage-redraw` `a0b83825` (a test only) + `fix/asar-temp-leak` `5dcaa7c0` + `fix/p3-prod3` `68c4a9e7`
(P3-A–E, reconciled with one-undo). Each passed its own full Linux suite and one Codex review. The combined Linux suite is
running on EC2 now; I'll stop you if it finds anything. `perf/apply-latency` isn't in, so **skip timing B**.

1. **Build** `3b2407c3` into `out/carton-prod4`, Carton on. Delete `out/carton-prod3` once it passes its checks.
2. **N-1, one action = one version = one undo step.** Use a fresh project: a clip plus W1–W6.
   - Select W6 and press Delete. History and `cb history` show **one** new version, "Deleted title 'W6'", and `cb compare`
     of it shows only that line. One Ctrl+Z brings W6 back in the editor and on disk, and `project.json` has "Text: W6".
     Ctrl+Shift+Z removes both; Ctrl+Z brings both back.
   - Repeat about 7 times. Note the save order (console or save times): both orders must behave the same.
   - Delete W6, Ctrl+Z at once, Delete W6 again, Ctrl+Z. W6 and its entry end up back, with no extra versions.
   - Add a title from the Text panel: one version, "Added title …". One Ctrl+Z removes the title and its entry; redo brings
     both back.
   - Delete W5 in the editor, then `cb undo "<project>"`: W5 and "Text: W5" both come back.
   - Shared project: share it and repeat the delete and the add. The teammate sees one version each time.
   - **Earlier undo cases:**
     - split then drag a piece: Ctrl+Z ×2 gives the one clip, Ctrl+Shift+Z the split, Ctrl+Y the drag;
     - split then mute a piece: the mute stays until it is undone;
     - Ctrl+Z never undoes a terminal `cb` edit;
     - a Director turn holds your edits back from `timeline.tsx`;
     - GUI saves feel as quick as before.
   - **N-3:** trigger the save-failed toast (`window.__carton.saveFailed(new Error("x"))`). It shows the warning icon, not ✓.
   - Note whether the `MaxListenersExceededWarning` still shows in the console.
3. **The `%TEMP%` leak** (Windows-only patch, main.js 15):
   - Count `%TEMP%\<uuid>.tmp.*` files, then launch and quit the new build 3 times, waiting about 20 s each. Expect **+0** new
     files. Do it once with Carton off and once on.
   - Check `userData\temp-sweep.json` and the `temp-sweep` line in the activity log after the first launch. Copies made since
     Windows last started are kept on purpose, as `"recent"`; that's expected without a reboot. **Don't reboot the laptop**
     for this.
   - Assets, video playback and seeking (ranges) all still work. Startup feels the same.
4. **The P3s from `fix/p3-prod3`:**
   - **P3-A:** chat open, the editor page at 960 CSS px (`s-b7b.js`), open History. The panel is x 576–960, with its bottom at
     the toolbar's top (about 586). Fullscreen and Hide timeline act as they do with Carton off and History closed. Chat
     collapsed: 300 px wide, bottom about 586.
   - **P3-B:** new cut "Alt", split the clip, set W1's font size 100 → 150 in the stage toolbar. Then on Main cut, Fold "Alt"
     in here. The row reads "Moved 'W1' to track 'Text 1', font size 100 → 150".
   - **P3-C:** a project with 6 titles: its setup row shows no "Added media 'Text: W…'" lines, and the count drops by 6 (from
     15). A Restore row shows no "Deleted media 'Text: …'" lines.
   - **P3-D:** `s-restore3.js "Added 2 tracks"`, `s-b2.js`, then Ctrl+Z and Ctrl+Y once more. The rows read Undid / Redid /
     Undid / Redid the restore. The undo of a "Folded the rest…" reads "Undid the fold of the rest of 'Alt' into 'Main
     cut'".
   - **P3-E:** fresh profile → Projects → Join a shared project → Join. The sidebar stays on Projects with no jump, and after
     Done the new tile is visible. Repeat from Dashboard → Your projects.
   - **Extras:** `cb history` lists "Folded the rest" as `merge (the rest)`. In a preview with a title selected, there's no
     text toolbar on the stage; the left panel's presets still show, which is known.
5. **N-2, careful A/B:** alternate Carton on and off, 3 runs each, then again with Delete.
   - Park the real mouse outside the Cardboard window for the whole run.
   - In the editor's console, run `document.querySelector('[data-timeline-scroll]').addEventListener('mouseleave', e =>
     console.log('timeline mouseleave', e.isTrusted, performance.now()))`.
   - Pause at 0:01 and read the luma.
   - CDP `mouseMoved` onto W5, then press and release: read the luma and the top-left timecode (expect 00:00:04.500).
   - Esc: read the luma and the timecode. With Carton on, `window.__carton.playhead()` should give 4.5.
   - `mouseMoved` to the stage's middle: the picture is back and the timecode reads 00:00:01.000.
   - Expected in both builds: black after Esc with the timecode at 4.5, and the picture after the last step. A run that is
     black with the timecode at 1.000 and no mouseleave logged is a real bug: send the log and the shots.
6. **Spot checks:**
   - the share crash 3/3 (one side), bug 6, page shortcuts 25/25, and `--os` 9/9 when the user is away;
   - `writers.js --writers 4 --rate 1 --seconds 120`: the table looks as before, and `--out` has `samples` (each writer's
     edits) and `failures`.
7. **Report** in step 5's format, then wait. If it's green, the next order is the merge to `main` and the reinstall.

### Update 6b (2026-11-02 ~23:30 UTC): the final head `39312830`
`merge/prod-2` = **`39312830`** = `3b2407c3` (your Update 6 pass) plus:
- `perf/apply-latency` `c4ae6831`: cb loads Carton from Node's compile cache, and the open-time WAL checkpoint is deferred;
  verified on Linux at about −61 ms per print+apply with Carton on;
- `fix/fold-undo` `7617c20e`: P2-1, and `cb history` lists a redo as `redo`;
- `fix/turn-hold` `66bf035e`: the hold covers the whole in-app turn, from the first `cb` call (a print too), in Bash or
  PowerShell, renewed every 20 s.

Each passed its own suite and one Codex review. The combined Linux suite is running on EC2 now; I'll stop you if it finds
anything.

1. **Build** `39312830` into `out/carton-prod5`, Carton on. Delete `out/carton-prod4` once it passes its checks.
2. **Turn hold**, on fresh copies of `hold-base`, as `holdab.sh` does:
   - Foreground: the exact ping prompt, `MUTE_AFTER_MS=15000`, `WATCH_MS=40000`. The mute reaches `timeline.tsx` only after
     "turn over", and the agent answers "321, not muted". 2 runs.
   - Background: the same prompt, with step 2 changed to "Then run `ping -n 31 127.0.0.1` in the background and wait for it
     to finish, checking its output, before going on". Same expectations. If Claude Code ends its response while the ping
     runs and resumes later on its own, that's outside the turn: note it, it isn't a failed hold.
   - Past 60 s: `ping -n 91 127.0.0.1` in the foreground with `MUTE_AFTER_MS=70000`. The mute is held until the turn ends.
   - Interrupt: press M during the ping, then Stop the turn. The mute reaches `timeline.tsx` within a second or so of the
     Stop.
   - In each chat log, note which tool ran `cb` (PowerShell or Bash), and that the turn's version is named after the
     prompt.
3. **P2-1**, on fresh `p2-1-repro` copies or a fresh mkproj:
   - New cut "Alt": split the clip, and set W1's font 100 → 150. On Main: Fold "Alt" in here, untick the split, "Fold in
     2 of 3". Then Fold "Alt" in here again.
   - Ctrl+Z ① reads "Undid the fold of the rest of 'Alt' into 'Main cut'", and the clip is no longer split.
   - Ctrl+Z ② reads "Undid the fold of 'Alt' into 'Main cut'". `cb compare` ①→② shows font 150 → 100 and the track/media
     changes undone, with no "Split" line. Main equals the version before the first fold.
   - Ctrl+Z ③: nothing left to undo from this session.
   - Redo: Ctrl+Shift+Z → "Redid the fold of 'Alt'…" (font 150, one clip); again → "Redid the fold of the rest…" (split
     back). `cb history` lists both as `redo`.
   - `cb undo` twice from after "the rest": `Undo revert: …` then `Undo merge: …`, with states as above.
   - Fold-some alone ("Fold in 2 of 3" only): Ctrl+Z gives Main as before; then Ctrl+Shift+Z, then Ctrl+Z.
   - Shared, with two instances: A folds in 2 of 3, B edits another clip, A folds in the rest, B edits again. A's Ctrl+Z ①②
     undo the rest and then the partial fold, and both of B's edits stay. Then: A folds in 2 of 3, B edits the left-out
     title, A presses Ctrl+Z. A's fold is undone, B's edit stays, and there's no conflict card.
4. **N-1 spot check:** delete W6 and Ctrl+Z, 3 times, noting the save orders. One version each, and W6 comes back with
   its "Text: W6".
5. **Timing B** (apply latency), now that perf is in:
   - `writers.js run` at 1 and 4 writers, `--rate 1 --seconds 60`, Carton on vs off, 3 alternated runs a side (even
     reps, alternating which goes first).
   - Warm Node's compile cache first: one `cb` command after the install, before timing.
   - On mains only, idle-gated as before.
   - A separate subagent re-checks every number from the raw `--out` files (they now have `samples`) before you report
     them.
6. **Spot checks:** the share crash 3/3 (one side), bug 6, page shortcuts 25/25, and `--os` 9/9 when the user is away.
7. **Report** in step 5's format, then wait. If it's green, Update 7 (the merge to `main` and the reinstall) follows at
   once.

### Update 6c (2026-11-02 ~23:50 UTC): the network test's upload, once more (user OK'd)
The user approved re-running the network test on the hotspot, about 100–120 MB of mobile data.
1. **When:** after the Update 6b report and after 00:00 UTC (the lab host's daily write cap resets then), with nothing
   else running. Don't interrupt 6b for it.
2. **Run once:** `cd D:\cbwork\cflab` then `node .\cf-lab-laptop.mjs .\config.json --upload-mb 100`. If the upload is refused
   again, don't retry; send what it printed.
3. **Send** the summary: upload MB/s and the time for the 100 MB, the download part, edit latencies, cut/recovery, the
   slowed link. Push the results file to `audit/regress-2026-11-02` under `docs/regress/network/`, unless it contains the
   config's tokens.
4. **Then wait for Update 7.**

### Update 7 (2026-11-03 ~00:45 UTC): `main` is the release. Reinstall and wrap up
`main` = **`2ccfe9b4`** (fast-forward from `fb295c02`) = the window-size fix (patch-main 15) + the whole Carton release
`39312830` (the asar fix is now patch-main 16) + the cost calculator. Linux: 3,583 pass / 0 fail. Windows: your Update 6b
green.

1. **Finish Update 6c first** (the network test, once), if it isn't done yet.
2. **Build `main`** the normal way: in `D:\Projects\cardboard-showcase`, `git fetch && git checkout main && git pull --ff-only`
   (expect `2ccfe9b4`), then `node scripts/build-windows.js`. That's the default build: Carton is built in and off unless
   `CARDBOARD_CARTON=1`. Check `build-info.json`: commit 2ccfe9b4, variant full. Check disk before building.
3. **Window size (patch 15), on that build with a test profile, before installing:** launch, note the window's size, quit
   cleanly, 3 times. The size stays the same (to within a few DIP on the first launch after a resize, then exactly). Also
   resize it once and check that the size is kept.
4. **Replace the user's installed Cardboard** at `D:\cardboard\Cardboard` with this build, the way it was installed before.
   **Keep no older copy** (AGENTS.md rule 8).
   - **If the user's Cardboard is running, don't close it.** Wait and post a one-line note asking the user to quit it. Never
     kill it: it could hold unsaved work.
   - Replace only the app files. Never touch the user's profile, library or projects.
   - After replacing, check that `D:\cardboard\Cardboard` holds the new build (`build-info.json`: 2ccfe9b4) and that nothing
     of the old install is left beside it. Don't launch it with the user's profile.
5. **Clean up what our work created:**
   - every test profile under `D:\cbwork` (dl, fr-dl3, p2-1-repro, dt-prod4, hold-base, kb-prod3, large-src, n2-on, p3r-c,
     ui-days and the rest);
   - `out\` (carton-prod5 and the new build once installed);
   - worktrees and their `node_modules`;
   - scratch;
   - any leftover `%TEMP%` copies matching our builds (the exact-match rule).

   **Keep:** `dl\` (the build inputs), `D:\cbwork\clips` (the showcase clips) and the small report files. Delete only what
   our work created.
6. **Stop** the keep-awake and your scheduled ORDERS fetch task.
7. **Report:**
   - the installed build's `build-info.json`;
   - the window-size result;
   - what was deleted and what was kept;
   - free space on C: and D:;
   - that the keep-awake and the task are stopped.

   Then you're done. Thank you, an excellent run.

### Update 8 (2026-11-03 ~03:55 UTC): the follow-up release `66ee2f3f`: diagnose the slow trips, then reinstall
The user approved:
- merging three follow-ups into `main` and reinstalling;
- one diagnostic timing run on this laptop.

`merge/prod-3` = **`66ee2f3f`** = `main` `2ccfe9b4` plus:
- `fix/sync-missing-blob`: a lost keyframe no longer leaves editors "syncing" forever;
- `fix/react-date-tests`: test only;
- `perf/apply-tail`: the worker logs every read-your-writes wait of 500 ms or more, step by step, and `writers.js` splits the
  print and the apply.

`main` will fast-forward to exactly this commit once the Linux suite (running now) is green, so one build serves both the
timing and the install.

1. **Device:** check power (mains) and disk, and start the keep-awake again for this run.
2. **Build** `66ee2f3f` the default way (`git fetch && git checkout --detach origin/merge/prod-3`, then
   `node scripts/build-windows.js`). `build-info.json`: commit 66ee2f3f, carton true.
3. **Diagnostic timing B,** with test profiles:
   - `writers.js run` at 1 and 4 writers, `--rate 1 --seconds 60`, Carton on vs off;
   - **at least 6 alternated pairs per writer count** (24 runs), alternating which side goes first;
   - idle-gated, on mains;
   - the compile cache warmed with one `cb` command after the build;
   - the network on, as in the earlier runs (no dead proxy).
   
   For every trip of 3 s or more, report:
   - (a) whether the print or the apply holds the extra time (the new samples split them);
   - (b) the apply's `timeline` answer: `later` means cb's 2 s wait ran out;
   - (c) the worker's `[carton] a cb write waited N ms …` line from that run's `logs/activity-<date>.jsonl`, matched by
     timestamp: it names the step.

   Also report the same medians, the tail counts and the per-run p95 as Update 6b. A separate fast-mode subagent re-checks
   every number from the raw `--out` files and the logs before you quote them.
4. **Spot checks on the same build:**
   - the share crash 3/3 (one side);
   - Join → Open on a fresh profile;
   - page shortcuts 25/25;
   - one title delete and its Ctrl+Z.
5. **Wait for my message "main is pushed".** Then install this same build at `D:\cardboard\Cardboard`, with the same rules as
   Update 7:
   - not if the user's app is running;
   - no older copy kept;
   - app files only;
   - check `build-info.json` (66ee2f3f).
6. **Clean up** as in Update 7 (profiles, `out\`, scratch; keep `dl\`, the clips and the reports), stop the keep-awake, then
   report.
