## About

We are working to showcase our skills to the team behind cardboard. Hence, we are building features, performance improvements, bug fixes etc. over the existing cardboard application.

## Rules to follow:

1. Our goal is to make the best agentic video editor in the world.
2. There must never be a net negative. Changes made by us must never hinder performance, cause regressions, produce bugs, etc.
3. We must always design performant features and provide the best in class performance to our users.
4. You must test the application as close to a real user would as possible, including testing the real instance of the app whenever it makes sense.
5. You must always lead by proving things. For example: actual performance benchmarks, before/after states, comparisons, etc.
6. Never state a measured number (sizes, timings, ratios, percentages, benchmarks) as fact until a separate subagent has independently re-run the measurement or verified your measurements and confirmed them; until then don't quote those numbers.

## Working in this repo

**What this is.** Cardboard only ships for Apple Silicon Macs. This repo turns its macOS release into a
Windows app: Cardboard's compiled app code runs on the Windows build of the same Electron version, with
Windows builds of the tools it bundles. We don't have Cardboard's source. Every change is a patch applied
to its minified bundles at build time.

**How a change is made.**

- `scripts/patch-*.js` each read a pristine bundle and change it with `replace(from, to, count)`: exact text
  in the minified code, which must match exactly `count` times or the build stops. Larger code goes into
  helpers injected at the top of a bundle (`__cb…` names; `media-helpers.js`, `rename-retry.js`,
  `strip-titlebar.js`).
- Minified names (`jTe`, `oJ`, `Dp`) are only valid for Cardboard 1.4.0, the version the patches target.
  Find targets by searching the pristine bundles; `scripts/mac-scan.js` lists the macOS-only calls.
- Keep Windows-only behaviour behind `__cbWin` (in the pages, `window.desktop?.platform === "win32"`), so
  the same code still runs on a Mac.
- Every patch has a comment saying what it fixes and why, and the README describes it for users. Update
  both with each change.
- Never commit Cardboard's code or the built app (`Cardboard-win/`, `asar-src/`, `dl/`, `extracted/`,
  `*.orig.*`, `out/`). `.gitignore` keeps them out: they're not ours to redistribute.

**Building.**

- On Windows: `cd tools && npm ci`, then `node scripts/build-windows.js`. It downloads what the app is made
  from into `dl/` (Cardboard 1.4.0 for Mac from cardboard.ai, Electron, ffmpeg 8.1, uv, Claude Code) and
  builds `out/Cardboard-win`.
- Anywhere else (Ubuntu): the "Build Windows app" workflow runs the same build on a GitHub Windows runner.
  `gh workflow run build-windows.yml --ref <branch>`, then `gh run watch`. A patch that no longer matches
  fails the build. It publishes the app as the release `windows-latest`, replacing the previous build:
  `gh release download windows-latest` gets `Cardboard-1.4.0-windows-x64.exe`, which unpacks the app.
  Builds go to that release, never to workflow artifacts. The same release also holds
  `Cardboard-1.4.0-windows-x64-baseline.exe` (`build-windows.js --baseline`): Cardboard's own pipeline without our
  speed changes, which the benchmarks compare against. A new speed change goes behind `speed` in its patch script.

**Testing.** The app runs only on Windows, and its GPU paths need an NVIDIA card, so checks in the real
app happen on the Windows machine.

- Run Cardboard with its own profile and library, never the user's: `CARDBOARD_USER_DATA`,
  `CARDBOARD_HOME`, and `--remote-debugging-port` to drive it over the DevTools protocol (`scripts/cdp.js`).
- `scripts/test-shortcuts.js`: 25 page tests, and 9 more with real keys (`--os`). The project under test
  must be the second tab; the script closes the tabs after it.
- Back performance claims with before/after runs against the previous build: alternate the builds, and
  report medians along with every run. `scripts/bench/run.js` does this (`--build baseline=… --build ours=…`).
  There is no Mac to measure on, so never claim "faster than the Mac". Claim "faster than Cardboard's own
  pipeline on the same machine" (the baseline).

**Pitfalls learned the hard way.**

- Don't open a project's `project.json` while Cardboard runs: on Windows a reader makes its saves fail
  (EPERM). Watch the bundle's `cache/` and `proxies/` folders instead.
- DevTools key events don't reach the window menu's accelerators (Ctrl+T, Ctrl+W…); real keys do
  (`scripts/sendkeys.ps1`).
- Electron's `input-event` gives mouse down, move and up no `modifiers`, only `button` (`"none"` on a move
  with no button held).
- The CLI imports `fs/promises` as ES module bindings: replacing a function on the module object reaches
  them only after `syncBuiltinESMExports()`.
- cmd reads `.cmd` files in the console's code page, not UTF-8: write non-ASCII paths as
  `%LOCALAPPDATA%\…` (see `__cbCmdPath`).
- The activity log records how and when things happened, and failures, never text the user typed.
- Measure on mains only, and check (`root/wmi` `BatteryStatus.PowerOnline`): on battery Windows throttles the
  laptop about 3x, and the build picks a different GPU (patch-main 13).
- On a laptop with two GPUs, Chromium draws on the power-saving one unless asked. Per-process GPU use is in the
  `\GPU Process Memory(pid_*)` counters (the integrated GPU has no dedicated memory); `nvidia-smi` lists nothing
  for it and wakes the discrete GPU just by asking. Windows' per-app "Power saving" choice pins a build to the
  integrated GPU for an A/B.
- During playback a code graphic is a live iframe over the preview, not the captured canvas; the editor's
  timeline canvases are opaque, so a canvas the GPU dropped shows black.
- From Git Bash, Windows tools that take `/flags` (`reg`, `taskkill`) need `MSYS_NO_PATHCONV=1`.
