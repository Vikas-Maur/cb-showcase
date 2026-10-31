# @carton/core benchmarks (P4)

TypeScript ports of the verified core-v5 prototype's benchmarks (`_inspect/git-for-video/proofs/core-v5/`:
`bench.mjs`, `compare.mjs`, `bench-util.mjs`), run on `@carton/core`, plus a runner that runs the prototype's own
`bench.mjs` and the port against each other. PLAN §20 P4: "merge3 faster than Cardboard's `rn` in every row at 1k
and 10k". Engine + history size is covered too.

Node 24 runs the `.ts` files directly (type stripping). Run from the repo root, or anywhere: the imports are relative
or `@carton/core` from `carton/node_modules`. Typecheck: `carton/node_modules/.bin/tsc -p carton/bench/core`.

Cardboard's own merge `rn` is never copied into this repo: `util.ts` copies Cardboard 1.4.0's pristine CLI chunks into
the scratch dir at run time and appends one export line to the copy (as the prototype did).

| env | default | what |
|---|---|---|
| `CARTON_CARDBOARD_DIR` | `/home/ubuntu/.t3/projects/cardboard-showcase/_inspect/cardboard-1.4.0` | an unpacked Cardboard 1.4.0 (holds `cli/chunks/`) |
| `CARTON_BENCH_SCRATCH` | `/home/ubuntu/gfv-scratch/carton/foundation-core/bench` | Cardboard's chunk copy, raw outputs, the prototype's copy |
| `CARTON_PROTO_DIR` | `…/_inspect/git-for-video/proofs/core-v5` | the prototype (read only) |
| `RUNS` | 7 | timed runs per cell |
| `LOAD_MAX`, `LOAD_WAIT` | 2, 30 s | the prototype's load gate: wait up to LOAD_WAIT for the 1-min load < LOAD_MAX (`ab.ts` sets LOAD_WAIT=0) |
| `GFV_LOCK` | `/tmp/gfv-race/cpu.lock` | the box's shared CPU lock (`ab.ts`) |

## bench.ts: the P4 cells

```sh
node --expose-gc carton/bench/core/bench.ts [sizes...]     # default 100 1000 10000; holds the CPU lock for the whole run (GFV_LOCK)
```

Each cell is timed by `measure()` (the prototype's loop): 3 warm-up calls, a probe call that sets `reps` so a run lasts
at least 25 ms, then RUNS runs of `reps` calls with `gc()` before each run. It prints ms per call for every run, the
median, and the 1-minute load average before the row. With `setup`, every call gets fresh input built outside the
timer. JSON goes to `$CARTON_BENCH_SCRATCH/raw/bench-carton[-sizes][-TAG].json` (or `OUT=`).

Inputs per size N: `genDoc(N, 42)` (a realistic Cardboard timeline) given engine keys; "1 edit per side" = a trim
(endTime/trimEnd −0.5) of the middle video vs the agent's text rewrite of a text item; "10%" = N/10 random items edited
per side (the human: trims, grades, font sizes…; the agent: transforms, text, caption words…). "shared" = the three docs
share unchanged records, as a long-lived store's docs do; "parsed" = all three are fresh `JSON.parse` results (cold).

| cell | what it measures |
|---|---|
| diff, 1-item edit / 10% edit (shared, parsed) | `diff(base, edited)`: the ops between two versions |
| apply one change / 10% change, in place | `apply(live, ops)` on an owned doc |
| fork | `fork(base)`: an owned copy (arrays + id index) |
| merge3, 1 edit / 10% per side (shared, parsed) | `merge3(base, ours, theirs)` |
| Cardboard rn, same rows | Cardboard 1.4.0's own merge `rn(base, editor, incoming, {prefer: "file"})` on the same inputs as project.json-shaped docs (no `#pos`), sharing records exactly as merge3's inputs do |
| client: declare a change | `declare(schema, base, ops)`: paths, reads, spans |
| sequencer push, accepted (fast-forward) / (20 behind, disjoint) / rejected (20 behind, same leaf) | one push to `sequencer.createLocalSequencer` after 50 warm-up changes; the notes give the accepted count over the row's calls |
| hash all records + doc, cold / after a 1-item edit (cache warm) | `hashDoc` |
| canonical snapshot | `snapshot(base)` |
| shot diff, 30-min timeline (repeat call, cold) / segment into shots | `shotDiff`, `shots` on a 1,800 s timeline with a ripple cut and a grade change |

Also printed, untimed: bytes of a stored change row for typical edits and of the canonical snapshot vs Cardboard's
`.revs` entry per write, module sizes (esbuild `--minify`, ESM, platform node, gzip level 6: the prototype's method;
`scripts/size.mjs` is the budget check), and a sanity line (card counts, and whether merge3 with every card resolved
to "theirs" keeps the same items as rn).

Port differences: the sequencer rows push to the redesigned sequencer (changes carry their declaration and
`base: {seq, pending}`); the same push sequence gets the same verdicts from both sequencers at 1k and 10k. Carton's
change rows are bigger because `declare()` now adds the `#time` group path and span `item`/`structural`.

## compare.ts: Cardboard rn vs merge3, correctness

```sh
node carton/bench/core/compare.ts [--engine carton|proto]   # CASES=n fuzz cases, default 2000
```

13 hand-written human-vs-agent scenarios (who keeps what, what is flagged, whether the doc stays valid), then a fuzz
corpus of random concurrent edits (seeds 9000+): per engine, changes kept, lost but flagged by a conflict, composed by
the time algebra, lost silently, invalid docs, conflicts reported. `--engine proto` runs the same harness on the
prototype's engine, so the tables can be diffed. The prototype's own `compare.mjs` predates v5: its fuzz section reads
`merge3().shifts`, which v5 dropped, so it throws after the scenario table. The port uses v5's equivalent (a side's
remap map is non-empty) and counts time-group compositions (`stats.composed`) separately.

## ab.ts: prototype vs Carton, like for like

```sh
node carton/bench/core/ab.ts [--rounds 5] [--sizes 1000,10000] [--no-compare] [--resume <runDir>] [--summarize <runDir>] [--no-copy]
```

Runs the prototype's `bench.mjs` (unchanged: a byte-identical, sha256-checked copy under the scratch dir, because it
writes `results/` next to itself) and `bench.ts` alternately, one process per (build, size), prototype first in odd
rounds. Each process holds the shared CPU lock for its whole run only, so other benchmarks interleave between
processes, and records `uptime` when it gets the lock and when it ends; every row also records its load. Both builds
get the same env (RUNS, LOAD_WAIT=0). Then, if not `--no-compare`: the prototype's `compare.mjs`, and `compare.ts` on
both engines, each in the lock, checking that the scenario tables and the fuzz tallies match.

Output: `<runDir>/summary.md` and `summary.json` (per cell: each build's median over rounds of the per-process medians,
carton/prototype ratio, Cardboard rn's median and merge3/rn from the same processes, loads, every round's median and
every run), plus the sanity check, module sizes, change-row bytes and the compare result. These and the compare tables
are copied to `results/` here. Completed jobs are appended to `<runDir>/jobs.jsonl`, so `--resume` continues a run.
