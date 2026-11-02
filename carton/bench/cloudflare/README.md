# cf-lab: Carton's Cloudflare backend, for real

The lab that tests `@carton/server-cloudflare` deployed on Cloudflare (Workers Free plan), with R2 and without it
(blobs in the `BlobVault` Durable Object), under shaped networks. It measures live sync, offline and back, large
media, the per-request limits, and what each operation really costs, read back from Cloudflare's GraphQL Analytics.
The results and the cost table are in `_inspect/carton-build/CF-REPORT.md` (git-ignored, next to the run records).

Every number the lab prints is UNVERIFIED until a separate verifier re-runs it (AGENTS.md rule 6).

## The free-tier guard (`guard.ts`)

Every test calls `guard()` first. It reads this month's R2 operations (by action, classed A/B per R2's pricing page),
R2 storage, and today's Workers and Durable Object requests, duration (GB-s at 128 MB), rows read and written, and DO
SQL storage, adds the test's declared worst case plus every test still inside the analytics' lag (its own ledger,
`~/.config/carton-lab-ledger.json`), and refuses if any lab ceiling could be crossed:

| | Free amount (2026-11-01) | Lab ceiling |
|---|---|---|
| R2 Class A / Class B | 1M / 10M a month | 40% |
| R2 storage | 10 GB-month | 40%; never more than 4 GB held at once |
| Workers requests | 100k a day | 50% |
| DO requests, duration, rows read, rows written | 100k, 13,000 GB-s, 5M, 100k a day | 50% |
| DO SQL storage | 5 GB in total | 50% |
| Uploads from the lab box | — | 20 GB in total |

A test that deliberately hits a daily limit (`limitTest`) runs only 23:00–23:50 UTC and only with
`CARTON_LAB_LIMIT_TEST_APPROVED` set. `node guard.ts status` prints the account's usage against the ceilings.

## The deployments

`wrangler.lab-r2.toml` and `wrangler.lab-nor2.toml`: the real Worker (`lab-worker.ts` wraps
`packages/server-cloudflare/src/worker.ts` unchanged) as `carton-lab-r2` (R2 bucket `carton-lab`, a 1-day lifecycle
rule that deletes objects and aborts multipart uploads) and `carton-lab-nor2` (no R2 binding: the BlobVault fallback).
Both are locked: no open creation, sessions only from invites the secret `ADMIN_TOKEN` makes, and the daily write
cap (`WRITE_CAP_BYTES_PER_DAY`, `WRITE_CAP_OPS_PER_DAY`; branch `fix/cf-write-cap`). The lab's two extra routes
(`/api/lab/projects/:p/purge` and `/stats`) need the same token. Secrets live in `~/.config/carton-lab-secrets.json`,
never in the repo:

```sh
export CLOUDFLARE_API_TOKEN="$(cat ~/.config/carton-cf-token)" CLOUDFLARE_ACCOUNT_ID=…
npx wrangler deploy -c bench/cloudflare/wrangler.lab-r2.toml
jq -r .AUTH_SECRET ~/.config/carton-lab-secrets.json | npx wrangler secret put AUTH_SECRET -c bench/cloudflare/wrangler.lab-r2.toml
```

## Shaped links (`netns.sh`)

One network namespace per client (`cfl0`, `cfl1`, …): a veth pair, NAT out of the box's main interface, and netem
inside the namespace only (upload on the veth, download on an IFB device). The box's main interface never gets a
qdisc. Profiles per direction: `good` 20 Mbit/s 15 ms, `4g` 5 Mbit/s 40 ms 0.5%, `3g` 1 Mbit/s 100 ms 1%, `bad`
256 kbit/s 200 ± 50 ms 3%; `hole on|off` drops everything both ways (a dead link, not a reset). `netns.sh down`
removes it all and restores `ip_forward`.

## The tests

- `sync.ts`: N parties (people and agents; every third is an agent) edit one cut at once, each a real client (core's
  `ReplicaQueue` + `SyncClient` over the WebSocket transport) in its own process and namespace (`party.ts`). Reports
  convergence (commit to every other party holding it confirmed), confirm latency, lost edits, duplicates, order,
  conflict cards, rejects, reconnects, and each process's event-loop lag (a busy box inflates latency). `--chaos flap`
  drops each link 5 s every 30 s; `--chaos outage --outage-sec 300` takes the first party offline while it keeps
  editing (offline, then back).
- `run-matrix.sh`: runs `sync.ts` lines one at a time, each when the shared box has ≥ 45% idle CPU.
- `media.ts` (+ `media-client.ts`): uploads a synthetic, incompressible file (an AES-CTR keystream from a seed, so the
  same seed is the same content) with `@carton/media`'s `uploadMedia` through the host's media API, exactly as the app
  shares; `--resume kill|hole` kills the uploader or cuts its link at `--at`, then resumes and counts re-sent bytes;
  `--dedup` uploads the same content again; `--preview` times a teammate getting the proxy's first 2 s segment;
  `--download N --down-profile 3g` times a teammate's download through `MediaReader` (the app's read path, with its
  retries; `--download-raw` for plain ranged GETs). Every HTTP request the client makes is counted by kind, and its
  multipart upload ids are logged. Purges the project's blobs after.
- `cost.ts`: reads each run's real use back from GraphQL (the run's room is the object with the most requests in its
  window; `inboundWebsocketMsgCount` reads 0 for hibernatable sockets, so requests count the messages). Superseded
  by `analyze.ts` (round 2), which reads each run's own objects.
- Round 2 (cf-lab2, 2026-11-02):
  - `sync.ts` also runs presence as the Carton web app sends it (`--presence-mode drag`: `PresenceSender` fed a drag at
    60 Hz pointermove for `--presence-sec`; `once`: one "Idle", then silence) and idle sessions (`--edits 0
    --idle-sec 600`); each run records its phases (epoch ms), its project's Durable Object ids and every party's
    frames by type and its log.
  - `conn.ts`: `--n` connects one at a time (fresh replica or reconnecting), starting on a fresh minute after the cut's
    adoption.
  - `proxy-run.ts`: shares a real video as the app does (`shareMedia`: libx264 cutting 2 s CMAF segments, each
    uploaded as made) and plays the stream back as a teammate's player does (`ProxyStreamReader` over `MediaReader`).
  - `tail.ts` follows both lab Workers with `wrangler tail` (path, status, outcome, CPU, wall time; Worker events
    only). It drops events under load, so the clients' own request counts are preferred where they exist.
  - `objcost.ts` reads one run's use per object: Durable Objects by id and invocation type (`http`, `hibernation`,
    `alarm`) from the admin route `GET /api/lab/projects/:p/ids`, R2 by object name (names are cut to their last ~256
    characters), the Worker from the tail. `analyze.ts` turns each run into per-unit costs (`<run>.c2.json`),
    `measured.ts` builds `results/measured.json` for the cost calculator, `report.ts` prints its tables.
  - `guard.ts` waits instead of refusing with `CARTON_LAB_GUARD_WAIT_SEC` (same ceilings).
- `laptop/`: the same measurements from a person's own machine and home network (Windows included, which has no
  netem; no admin rights, and no admin token on the laptop). `make-config.ts` adopts a fresh `laptop-<timestamp>`
  project and writes a config outside the repo with three editor sessions (48 hours at most) and the run's upload size
  (`--upload-mb`, default 200, at most 300). With `--guard`, it also declares one run's worst case (`estimate.ts`) as
  `laptop-pack-<projectId>` and leaves it open, because the run happens out of the guard's sight. `build.mjs` bundles
  `laptop.ts` into one `cf-lab-laptop.mjs` that imports only Node's built-ins. `BRIEF.md` is what the person is told.
  In one process, the bundle runs, in this order:
  - a network probe: DNS, TCP, TLS and WebSocket connect times, health round trips, and Cloudflare's `colo` and
    `loc`, never the IP;
  - 60 edits between two replicas: convergence and confirm p50/p90/p99, and every value;
  - a third replica through a local proxy (`proxy.ts`: plain ws in, TLS to the host out) whose link goes dead for
    45 s while it and the first replica both keep editing: when it shows offline, its reconnect, catch-up both ways,
    lost edits, conflict cards;
  - the upload, with `uploadMedia`, while two replicas keep editing every 3 s (sync on a saturated uplink). A link
    too slow to finish in time restarts once, smaller. Then the same content again (dedup), and the first 16 MiB back
    through `MediaReader`, compared with what was sent;
  - if time is left, a replica through the proxy shaped to 1 Mbit/s and 100 ms each way.

  It writes one results JSON next to itself (also on Ctrl+C) and stops within 20 minutes. Afterwards, `purge.ts
  --project <id> --end-test <name>` deletes the project's blobs and ends its guard entry.

```sh
cd carton
node bench/cloudflare/guard.ts status
bash bench/cloudflare/netns.sh up 20
node bench/cloudflare/sync.ts --host r2 --parties 5 --edits 12 --seconds 30 --profile 4g
node bench/cloudflare/media.ts --host nor2 --size 100M --profile good --dedup --preview
node bench/cloudflare/cost.ts
bash bench/cloudflare/netns.sh down
node bench/cloudflare/laptop/build.mjs && node bench/cloudflare/laptop/make-config.ts --guard   # laptop: node cf-lab-laptop.mjs config.json
node bench/cloudflare/laptop/purge.ts --project <projectId> --end-test laptop-pack-<projectId>   # once the results are back
```
