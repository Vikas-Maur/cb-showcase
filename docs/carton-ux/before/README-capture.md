# Carton UI capture rig: how to re-run

The rig itself is `docs/carton-ux/capture-rig.patch` (gallery code only). `git apply docs/carton-ux/capture-rig.patch` from the repo root adds it.

The rig is `carton/packages/react/gallery/capture/` (gallery code only; `capture-rig.patch` here adds it to a checkout
with `git apply capture-rig.patch`). `entry.js` mounts the app's own `CartonSide`, `CartonStage` and `JoinDialog` from
`scripts/carton/ui.js`, the Share panel from `scripts/carton/sync/ui.js` and the title-bar icons from
`scripts/carton/strip-buttons.js`, in stand-ins for Cardboard's window, on Cardboard 1.4.0's own stylesheet, over a fake
bridge that serves @carton/react's mock through the real `serveUi`/`serveComments` protocol; `clock.js` pins the clock
(Tue 3 Nov 2026, 2:30 PM) so runs compare pixel for pixel; `shoot.mjs` lists every state (scenario + clicks/typing) and
shoots it; `run.mjs` builds, shoots React and preact/compat, compares the pairs and writes `INDEX.md`. To take the
"after" shots, from `carton/packages/react` (after `cd carton && npm ci`):

```sh
CARTON_CARDBOARD_ASSETS=/home/ubuntu/.t3/projects/cardboard-showcase/_inspect/cardboard-1.4.0/app-asar/dist/renderer/assets \
CARTON_PLAYWRIGHT=/home/ubuntu/job-finder/node_modules \
CARTON_CHROMIUM=$HOME/.cache/ms-playwright/chromium-1248/chrome-linux-arm64/chrome \
node gallery/capture/run.mjs <an empty output folder>   # not docs/carton-ux/after: that holds the mockups
```

About 7 minutes for 143 shots × 2 runtimes. `--only '<regex>'` limits it to some shots, `--widths 384` to one width.
To look at a state by hand, open `gallery/dist/capture/capture.react.html?s=<scenario>&w=<width>` in Chromium (scenarios
are the `S[...]` entries in `entry.js`). A new state is one line in `SHOTS` (shoot.mjs) and, when the mock can't make it,
a scenario in `entry.js` that wraps the mock (never `src/`). If a redesign renames a class or a label the steps click
(`.carton-version-more`, "Compare with current", …), the shot fails with "capture failed" in INDEX.md: update its step.
`notes/` holds evidence crops for findings that aren't a state.
