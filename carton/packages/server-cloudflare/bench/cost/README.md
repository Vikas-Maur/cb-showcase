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

From `carton/packages/server-cloudflare`, with the lab's file and the verifier's verdicts:

```sh
git show origin/lab/cloudflare:carton/bench/cloudflare/results/measured.json > /tmp/measured.json
node site/cost/build-data.mjs /tmp/measured.json site/cost/prices.json \
  --verified /home/ubuntu/gfv-scratch/carton/cf-verify/verified.json
node --test test/cost-model.test.ts
```

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
file input), `upkeepAlarmPerHour`, `writeCapReservesPerSegment`, `writeCapRowsPerReserve`, `segVaultDoReq`,
`segVaultRowsWritten`, `viewVaultDoReqPerSegment`, `viewVaultRowsReadPerSegment`, `viewVaultGBsPerMiB`.

What the model expects of a few inputs, so they aren't counted twice:

- `editDoReq` is WebSocket messages per edit, billed 20:1 on Paid; connects (`connDoReq`, 3: upgrade, hello, close)
  and alarms are added on their own, at full price.
- `editRowsWritten` is per edit (1.025); the 2 rows a person's first push to a project writes are
  `replicaRowsWritten`, counted once per new shared project (a setting), with the room's `adoptRowsWritten`.
- `gbDoReq` is 0 for a default deployment. The lab's measured value is all the optional daily write cap's counter, so
  the build keeps it as `writeCapDoReqPerGB`, counted only with the "daily write cap on" setting.
- Per-GB inputs (`gb*`) are per 10⁹ bytes. Per-MiB playback inputs were measured with the app's 0.626 MiB segments
  (`REF_SEGMENT_MIB`) and scale with the segment's size (reads go per segment).
- `segVaultRowsWritten` counts a segment's three vault objects with one chunk row each; the model adds a row per MiB
  past the first, and charges the same rows again when the media expires (a delete is a row written).
- The presence rate is a setting (1 a second: the Cardboard app; 10: the Carton web app), not an input.

New prices: fetch the five pages listed in `prices.json` `sources`, update the numbers and `fetched`, and rebuild. The
model rounds a meter's billable amount up to the next unit only where the tier says `"round": true` (Durable Objects
and R2, per their pricing pages).

`node build-site.mjs` (from `carton/packages/server-cloudflare`) copies `site/` into `dist/site`, the calculator
included and its build script and type declarations left out.
