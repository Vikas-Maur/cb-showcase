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

From `carton/packages/server-cloudflare`:

```sh
git show origin/lab/cloudflare:carton/bench/cloudflare/results/measured.json > /tmp/measured.json
node site/cost/build-data.mjs /tmp/measured.json            # optional: a second argument for another prices.json
node --test test/cost-model.test.ts                         # the model still prices the new inputs
```

A structural problem (not schema 1, `inputs` not an object, a price missing) stops the build. A bad single entry is
dropped with a warning. An input the file lacks shows as "Not measured" on the page, and the model uses its own
estimate (`INPUT_DEFAULTS` in `model.js`). An input the model doesn't use is listed as an extra measurement. Limits and
speeds with ids the page doesn't know still show: their own `value` text becomes the tooltip.

What the model expects of a few inputs, so they aren't counted twice:

- `editDoReq` is WebSocket messages per edit (push, withdraw, re-push), billed 20:1 on Paid: the room's requests in a
  run less one connect per party. Connects (`connDoReq`) and alarms are added on their own, at full price.
- Per-GB inputs (`gb*`) are per 10⁹ bytes; per-MiB inputs (`view*PerMiB`) are measured with 2 s segments at 2 Mbit/s
  and scale with the segment's size (reads go per segment).
- `segVaultRowsWritten` counts a segment's three vault objects with one chunk row each; the model adds a row per MiB
  past the first, and charges the same rows again when the media expires (a delete is a row written).

New prices: fetch the five pages listed in `prices.json` `sources`, update the numbers and `fetched`, and rebuild. The
model rounds a meter's billable amount up to the next unit only where the tier says `"round": true` (Durable Objects
and R2, per their pricing pages).

`node build-site.mjs` (from `carton/packages/server-cloudflare`) copies `site/` into `dist/site`, the calculator
included and its build script and type declarations left out.
