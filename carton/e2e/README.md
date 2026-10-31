# @carton/e2e: the whole system, end to end

Real processes, real files, real sockets. Each scenario starts what a user's machine runs: the app's engine thread
(lease holder, Carton on `.carton/carton.db`, the cardboard materializer), `cb` processes (the standalone `carton`
bin), agents editing through their per-agent views, detached helpers, a sequencer host (server-node, or the Worker
under `wrangler dev`, locally only), and TCP links that really drop. The project is the sample bundle Cardboard
1.4.0's own CLI wrote (cardboard-adapter's fixtures), in a scratch library; never anyone's real data.

| File | Scenario |
|---|---|
| `test/s1-project.test.ts` | a real project: GUI save, a Director turn with two parallel subagents × three dependent edits through views (R2-03), `cb history`, `credits`, `undo --turn`, `restore`, the `timeline.tsx` header contract |
| `test/s1-mcp.test.ts` | the MCP tools over stdio on the same kind of project |
| `test/s1-real-codec.test.ts` | an agent's JSX edit of its view through Cardboard 1.4.0's own printer and parser (skipped without the 1.4.0 CLI) |
| `test/s1-view-base.test.ts` | §6.4 interleaved: R4-02 (trim, ripple) with a person's edit between an agent's two view saves, R7-01 stale writer on the shared file |
| `test/s1-takeover-views.test.ts` | B3: a view print while the app's engine thread is briefly busy |
| `test/s2-cuts.test.ts` | cuts: `cut new`, edits on both, `fold --check`, a fold with cards, a partial fold and the rest, `cb conflicts` / `resolve`, `cut switch` |
| `test/s3-cbproj.test.ts` | `.cbproj` collaboration with no server: export, a teammate edits, "Bring in their changes" ×2, a third merge, H11 |
| `test/s4-live.test.ts` | live sync between two machines through server-node and server-cloudflare: hand-off (R3-03), concurrent edits, `pending` → `confirmed`, offline + rejoin + rebase, a late conflict back to its subagent, view agents on a shared cut, R1-01 on two replicas, joining from an empty store |
| `test/s5-media.test.ts` | media through blob-fs and blob-s3 (VersityGW): share, resume after a cut link, a teammate streaming the proxy |
| `test/s6-crash.test.ts` | crash safety: helper killed mid-push, app killed mid-save, server restart mid-sync |

Known bugs are pinned as `todo` tests named after their id (B3…); the notes of agent e2e-qa route them.

## Run

```sh
cd carton && npm ci
npm test -w @carton/e2e                      # every scenario, one file at a time
node --test e2e/test/s4-live.test.ts         # one scenario
```

- Node 24 (type stripping). Linux, macOS and Windows; nothing needs a GPU.
- Scratch: `CARTON_E2E_TMP` (default `~/gfv-scratch/carton/e2e-qa/run` when `~/gfv-scratch` exists, else the OS temp
  folder). Every process the suite starts gets a HOME, app-data folder and temp folder inside it; carton.db is never
  opened outside it.
- `CARTON_E2E_CLOUDFLARE=0` skips the `wrangler dev` cases (they need `carton/node_modules/.bin/wrangler`).
- `VERSITYGW_BIN`: a VersityGW binary for the S3 cases (skipped without it).
- The scenarios start many processes: run them one file at a time (`--test-concurrency=1`, as `npm test` does).
