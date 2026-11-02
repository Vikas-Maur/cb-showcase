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
