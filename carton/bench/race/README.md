# P10: the displace-then-install race (PLAN §6.4)

Can Carton's materializer destroy a write that another process made to a file it re-materializes (`project.json`,
`timeline.tsx`, a per-agent view)? `race.ts` races three replacement protocols against foreign writers and accounts
for every foreign write. It is a TypeScript port of the verified prototype `proofs/race/race.mjs`. The one change is
that the `displace` protocol now calls the shipped code: `displaceThenInstall`, and with `--settle 2` the hold rule
`DisplacedFiles`, both from `@carton/cardboard` (`packages/cardboard/src/node/`).

| protocol | steps | where a foreign write can be destroyed |
|---|---|---|
| naive (control) | write tmp; stat the view; import it if its stamp isn't ours; rename tmp over it | between the stat and the rename |
| hardlink (control) | link the view to `prev/k`; rename tmp over it; import `prev/k` if it isn't ours | between the link and the rename |
| **displace** (shipped) | loop { rename the view to `displaced/n`; link tmp to the view; on EEXIST loop }; unlink tmp; review every displaced file | none: the engine never replaces a name |

## Run it

Node 24 or later runs the `.ts` files directly. No build and no dependencies.

```
node race.ts                                  # the portable matrix in <tmpdir>/carton-race
node race.ts --dir D:\carton-race             # another volume
node race.ts --trials 5 --rounds 5000 --out r.jsonl && node summarize.ts r.jsonl
node race.ts trial --protocol displace --writers 4 --mode free --rounds 5000 --oracle ./inotify-log   # Linux
```

- **Windows (the NTFS gate):** `run-windows.cmd`, or `powershell -File run-windows.ps1 [-Dir D:\x] [-Trials 5]`.
  - Run it on mains power. The script warns when the laptop is on battery.
  - It records the volume's file system, writes `results-windows-<date>.jsonl`, and prints the tables.
  - `rename`, `link` and `unlink` retry on EPERM, EBUSY and EACCES, which Defender or the indexer holding the file
    cause. The retries show in the `busy retries` column.
  - FAT and exFAT have no hard links. The script says so and runs `naive` only; Carton itself falls back to
    stat-then-rename there (L13).
- **Linux:** `./run-linux.sh out.jsonl [trials] [rounds] [fs:dir ...]`.
  - Each trial holds the shared CPU lock `/tmp/gfv-race/cpu.lock` and logs `uptime` to `out.uptime.log`.
  - It builds the inotify oracle (`inotify-log.c`) on first use. Free mode needs it, to tell "superseded by a later
    foreign write" (the writers' own loss) apart from "lost by the engine".
- **macOS (APFS):** `node race.ts` runs unchanged. We have no Mac, so this run is open.

## Reading the results

- **Turn mode** needs no oracle. Writers take turns and never replace each other, so every unaccounted foreign
  write is a loss caused by the engine.
- **In-place writers** (`--style inplace`: open, truncate, write) are measured, not proved safe. P10 found residual
  losses with plain displacement; the shipped settle-2 rule left about 1 in 12,000 rounds in one harness and 0 in
  about 26,000 in the verifier's (L19).
- **The missing-path gap** rows (`--writers 0 --pace 2`) time how long the path is absent per install, with sync and
  async `fs` calls. The shipped code is synchronous because the async gap is several times longer.

Every number this harness prints is unverified until a separate verifier re-runs it (AGENTS.md rule 6).
