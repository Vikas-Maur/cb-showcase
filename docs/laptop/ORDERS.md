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
