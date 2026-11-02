# The cost calculator's data (`/cost/`)

The showcase site's cost calculator (`site/cost/`, served at `/cost/`) says what running Carton's sync backend on
Cloudflare costs a month, which limits you'd meet and how fast it is. It loads one file, `site/cost/data.json`, built
from the lab's measurements and Cloudflare's prices.

| File | What it is |
|---|---|
| `site/cost/model.js` | The cost model: pure functions (`usage`, `bill`, `freeCheck`, `compute`, `curve`); `model.d.ts` types it for the tests |
| `site/cost/prices.json` | Cloudflare's prices and Free limits, with each page's URL and the date fetched |
| `site/cost/build-data.mjs` | Checks a `measured.json` (schema 1) and `prices.json`, writes `data.json` |
| `site/cost/text.js` | Every plain-words tooltip and the glossary |
| `site/cost/app.js`, `index.html` | The page (no framework, no build step, no external requests) |
| `bench/cost/initial-measured.mjs` | Made the first `measured.json` from the 2026-11-01 lab runs (`CF-REPORT.md`) |
| `bench/cost/measured.initial.json` | That file, until the lab's own one lands |
| `test/cost-model.test.ts` | Hand-computed bills, the 20:1 WebSocket rule, Free's daily thresholds |

## Rebuild `data.json` from a new `measured.json`

From `carton/packages/server-cloudflare`, with the lab's file, the verifier's verdicts on it, the first preview-path
re-check (`CF-VERIFY-PROXY.md`, cf-verify2), the release's preview settings (`bench/cost/proxy-release.json`, from
`CF-VERIFY-PROXY-3.md` and the final runs) and the check of the final runs (`CF-VERIFY-PROXY-4.md`, cf-verify4):

```sh
git show origin/lab/cloudflare:carton/bench/cloudflare/results/measured.json > /tmp/measured.json
node site/cost/build-data.mjs /tmp/measured.json site/cost/prices.json \
  --verified /home/ubuntu/gfv-scratch/carton/cf-verify/verified.json \
  --proxy-verified /home/ubuntu/gfv-scratch/carton/cf-verify2/verified.json \
  --proxy-release bench/cost/proxy-release.json \
  --proxy-final /home/ubuntu/gfv-scratch/carton/cf-verify4/verified.json
node --test test/cost-model.test.ts
```

The preview path ("Preview path" setting: optimized, the default, or before the fix) is priced per segment published,
per stream (one a clip shared: the "Average clip length" setting) and per MiB played, on the re-checks' 80 s clip (40
segments and the init, 0.618 MiB a part: `PV_REF_PART_MIB`).

- **Before the fix** (part by part), from cf-verify2: 418 Worker requests a stream = 10 a segment + 18; 169 Class B =
  4 a segment + 9; 9.87 requests and 9.83 Class B per MiB played. Verified.
- **Optimized, the release** (`merge/prod-2` @ `51f4d243`: 1 part / 1 MiB per append, 4 in flight; 1 MiB reads, 2 in
  flight; `PV_RELEASE`): one append a segment plus the lease and the end (42 for 40 segments), 7 setup requests a
  stream, 42 write-cap reserves, and as many segments a read as fit 1 MiB plus one read a stream (41 reads for 40 0.62
  MiB segments). CPU per segment and per read from cf-verify3's 4 runs; the per-request CPU distribution from
  cf-verify4 ("8 of 255 at or over 10 ms, max 23 ms, none refused"). Verified.
- Both paths: 3 Class A a segment + 5 a stream; optimized publish Class B is 4 a stream.
- **Not measured at the release's 1 MiB reads, so Estimated:** playback Class B (2 a segment, its list entry and
  bytes, + 1 a read, the next entry past the budget), from the read path cf-verify2 verified at 2 and 4 MiB.

The round-2 lab keys `seg*` and `view*` are superseded and listed as extras. The build adds the preview path's speeds
(before the fix from cf-verify2; the release on 4G from cf-verify4; on the good link, cf-verify3's live runs before the
in-flight fix and the implementer's local runs, marked as such) and its CPU line in the limits table.

Statuses: `confirmed` and `confirmed-from-data` are Verified; `revised` is Verified with the verifier's value (the
lab's is kept as `was` and shown); `not-verified` stays Measured. A key the model reads that the file lacks, or an
input the file marks `estimated`, is Estimated: the build lists them and the page counts them in a banner, so an
estimate never drives the bill silently. Speeds the verifier re-ran or recomputed exactly are Verified; a percentile
its note says it couldn't confirm is marked on the page.

The build stops on a structural problem (not schema 1, `inputs` not an object, a price missing) and drops a bad single
entry with a warning. Lab inputs the model doesn't read are listed as extra measurements. Limits and speeds with ids
the page doesn't know still show: their own `value` text becomes the tooltip. Cloudflare's documented limits the lab's
file doesn't carry come from `prices.json` (`documentedLimits`).

The model reads the lab's own key names. These are still the model's own figures (Estimated), because the lab's file
has no key for them: `editArchiveRowsWritten`, `changeBytes`, `replicaRowsWritten` (from the verifier's fit, not a
file input), `upkeepAlarmPerHour`, `writeCapRowsPerReserve`, and the vault-only `segVaultDoReq`, `pvoSegVaultDoReq`,
`segVaultRowsWritten`, `viewVaultDoReqPerSegment`, `pvoViewVaultDoReqPerSegment`, `viewVaultRowsReadPerSegment`,
`viewVaultGBsPerMiB`.

What the model expects of a few inputs, so they aren't counted twice:

- `editDoReq` is WebSocket messages per edit, billed 20:1 on Paid; connects (`connDoReq`, 3: upgrade, hello, close)
  and alarms are added on their own, at full price.
- `editRowsWritten` is per edit (1.025); the 2 rows a person's first push to a project writes are
  `replicaRowsWritten`, counted once per new shared project (a setting), with the room's `adoptRowsWritten`.
- `gbDoReq` is 0 for a default deployment. The lab's measured value is all the optional daily write cap's counter, so
  the build keeps it as `writeCapDoReqPerGB`, counted only with the "daily write cap on" setting.
- Per-GB inputs (`gb*`) are per 10⁹ bytes. Before the fix, every read goes per segment, so its per-MiB inputs scale
  with the segment's size; optimized reads go per 2 MiB, and only their per-segment GETs (82% of the Class B) scale.
  Optimized appends carry at most 4 parts and 2 MiB (`PV_BATCH`), so appends per segment scale with the part size.
- `segVaultRowsWritten` counts a segment's three vault objects with one chunk row each; the model adds a row per MiB
  past the first, and charges the same rows again when the media expires (a delete is a row written).
- The presence rate is a setting (1 a second: the Cardboard app; 10: the Carton web app), not an input.

New prices: fetch the five pages listed in `prices.json` `sources`, update the numbers and `fetched`, and rebuild. The
model rounds a meter's billable amount up to the next unit only where the tier says `"round": true` (Durable Objects
and R2, per their pricing pages).

`node build-site.mjs` (from `carton/packages/server-cloudflare`) copies `site/` into `dist/site`, the calculator
included and its build script and type declarations left out.
