# P9: contention, 5 editors on one track

The load harness for PLAN §6.1 / §20 P9, on the real Carton code: the replicas' `SyncClient` and `ReplicaQueue`
(`@carton/core`), the sequencer core with its overlap rule (`@carton/server`, on node:sqlite), and real merges on the
Cardboard schema, in a deterministic virtual-time simulation (`packages/conformance/src/system/`). Port of the verified
prototype `proofs/system-v11/p9.mjs`.

Scenario: 5 editors at 0.5 commits/s each for 600 s; 60% timing edits (move, trim-in, trim-out, frame-accurate, within
±0.5 s of a clip's nominal edges) and 40% opacity edits (lww); 40 butted 5 s clips on one track; RTT 300 ms and 50 ms; a
rebase costs 20 ms of the pusher's engine thread per pending change. Latency is from the commit to the confirmed row
reaching the committing replica.

Keyings: `v3-spans` (the plan's rule), `per-item` (leaf paths and reads only: the critic's baseline, which misses S2),
`v2-layout` (v2's per-track key), `v3-spans-v10` (v10's rule; sensitivity). S2 checks that a ripple at 5 s against an
append at 15 s is forced through merge3.

Target (§6.1): v3 spans within 1.5× of per-item paths at p99, while still catching S2.

```sh
cd carton
flock /tmp/gfv-race/cpu.lock node bench/p9/run.ts --seeds 30 --out bench/p9/results/main
flock /tmp/gfv-race/cpu.lock node bench/p9/run.ts --seeds 30 --sensitivity --only none --out bench/p9/results/sensitivity
flock /tmp/gfv-race/cpu.lock node bench/p9/run.ts --seed0 31 --seeds 30 --out bench/p9/results/seeds31-60
```

Every number these write is UNVERIFIED until a separate verifier re-runs it (AGENTS.md rule 6). Results are
deterministic per seed: CPU load changes only the wall time. The conformance suite runs a smaller version (seeds 1–20)
as `P9 single track, RTT …` in `packages/conformance/src/system/tests/p9-contention.ts`.

Differences from the prototype's harness: the server is the real sequencer, so a rejected push's concurrent rows reach
the client before the reject on its own connection; absorbed edits that had been sent are withdrawn with one row each
(H1, counted in the `absorbed (withdrawn)` column); keyframes come from client uploads; there is no FIFO row (the plan
keeps FIFO as a contingency that P9 never engaged).
