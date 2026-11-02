# fix/lap2-share-crash: status (stopped for shutdown, 2026-11-02)

Worktree: C:\Users\vikas\.t3\worktrees\cardboard-showcase\t3-313a9474, branch `fix/lap2-share-crash` (from origin/merge/prod-2-wip 178fb10).
Last commit: `7134f01` (WIP), **local only, not pushed**: the full test suite hasn't run on it yet.

## Done
- Root cause confirmed: `Live.view()` (scripts/carton/sync/live.js) sent each peer's actor as core's `{kind, id, name}`
  (raw data relayed from the teammate), never `key`; `actorColor` hashes `a.key`, so `hash(undefined)` threw.
- Fix at the sender: `peerActor()` in live.js sends `{key, kind, id, name}` (key = core's actorKey, as History's
  toUiActor uses, so the colour matches History). Only strings are kept; an entry with no id is skipped and logged once
  (worker.js routes it to warnOnce, then the activity log).
- Guard at the reader: sync/ui.js `shownPeers()` skips an entry it can't show, logs once (`__cbLog("error")`). Small diff,
  render lines untouched.
- Boundary: `PanelBoundary` in scripts/carton/ui.js around the side panel body ("This panel hit a snag… Try again",
  logs `error` with `panel`); react-shim.js exports `Component`.
- New test scripts/carton/test/sync/share-peers.test.js (real carton-ui on React 19 + happy-dom, fed by the real Live):
  5/5 pass; all 5 failed before the fix (first two with the audit's exact TypeError).

## Left
- Optional: guard from-carton.ts's presence handler (worker side) against a malformed actor or ghosts (was probing it).
- `npm run typecheck`; `npm test -w @carton/react -w @carton/core`; all scripts/carton/test/*.test.js + sync/live.test.js
  (CARDBOARD_PRISTINE=D:\cb-pristine, CARTON_TEST_DIR=D:\cbwork\share-crash\scratch).
- README: activity-log `error` row (it now also covers Carton's caught panel errors and skipped entries).
- `check.js` **not written yet**, so the crash has not been reproduced in the real app.
- Then push, delete the worktree's carton\node_modules, and delete D:\cbwork\share-crash\scratch.
- No Cardboard instance or Carton host was ever started (nothing to clean up).
