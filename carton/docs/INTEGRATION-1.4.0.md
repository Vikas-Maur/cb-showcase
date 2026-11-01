# Carton in Cardboard 1.4.0: integration points

This is where Carton plugs into Cardboard 1.4.0: version history, cuts, fold in, credits, and live collaboration for a
Cardboard project. It has two readers:

- **Cardboard's team**, who would make these changes in their own source. Each hook is described by what Cardboard's
  code does there, using names that survive minification: class methods (`writeNow`, `applyMutation`,
  `recordRevision`, `pushTimelineHistory`), IPC channels, and user-visible strings. That way it can be found in the
  real source.
- **Our Windows build**, which makes the same changes by patching the shipped bundles (`scripts/patch-carton*.js`).
  Appendix A lists the exact text each patch replaces. Every anchor occurs exactly once in the pristine 1.4.0 bundle,
  and again once after our Windows patches.

`§n` references are to `PLAN.md` v14. Hook numbers H1–H13 are the plan's §16 numbers. Minified names (`ti`, `W1`,
`Rde`) are only valid for 1.4.0. They're given so the anchors can be read, not as names to rely on.

## 1. Who writes a project in 1.4.0

Cardboard 1.4.0 has no cross-process lock and no compare-and-swap on a project. The app and every `cb` process read
`project.json`, change it in memory, and rename a temp file over it (B1, lost update). A GUI save replaces whole arrays
(B3). Outside changes are adopted as one undo step that drops a pending save (B11). Carton puts one change pipeline
under all of them.

| Process | Cardboard code there | Carton there |
|---|---|---|
| Library worker (`dist/library-worker.js`, a utility process) | The **project store** (the class with `writeNow`, `applyMutation`, `updateScoped`, `latest`, `seenOnDisk`; `W1` in the bundle). The **timeline mirror** (`apply`, `applyEdits`, `undo`, `history`, `recordRevision`, `writeMirror`; `Cp`). The bundle watcher. `.cbproj` save and open | The engine, on its own thread (a waiting `node:sqlite` call blocks its thread, §6.2). Commits for GUI saves and watched files. The materializer. The per-agent view watcher. Later, the sync client |
| `cb` CLI and `cb mcp` (`resources/cli/`) | Its **own copy** of the same store and mirror (`ti`, `Li` in `chunk-LL26E55H.mjs`). The commander program. The MCP tool table. Cloud mode | The engine, in-process. `cb history` and `cb undo` extended. `cb cut`, `fold`, `credits`, `restore`, `compare`, `conflicts`, `resolve` and `publish`. The MCP tools `timeline_cuts`, `timeline_fold`, `timeline_credits` and `timeline_publish` |
| Main (`dist/main.js`) | IPC (`project:patch`, `library:call`). The control socket. Agent launch. The in-process Director (Claude Agent SDK) and its `PreToolUse` hook | Who is acting (`CARDBOARD_ACTOR`). The Director's turn and subagent ids. The `Stop`/`SubagentStop` conflict hook. A `carton:call` IPC channel, which forwards to the library worker |
| Renderer (`index-*.js`, `EditorRoute-*.js`, `installErrorTelemetry-*.js`) | The editor store (zustand). Its 300 ms debounced save. Adopting outside changes ("Timeline updated from disk"). The 50-snapshot undo stack | The save carries its base, actor and recorded remaps. Adopt moves the base atomically and adds no undo entry. ⌘Z undoes your actor group. The History panel and conflict cards |

## 2. How Carton's code gets into the app

Carton is TypeScript with no runtime dependencies (`carton/packages/*`, published as `@carton/*`).
`scripts/carton/build.js` bundles it with the workspace's esbuild. The hooks reach it through a small bridge object in
each bundle (`scripts/carton/*-bridge.js`), and the bridges reach the packages through one facade
(`scripts/carton/carton-node.js`).

| File in the built app | Built from | Loaded by |
|---|---|---|
| `resources/carton/carton-node.cjs` (CommonJS) | the facade, with `@carton/core`, `store-sqlite`, `cardboard`, `local` and `cli-mcp` | The library worker and main (`require`). The CLI (`require`, from the `createRequire` banner both CLI files already have) |
| `resources/carton/engine-thread-main.js`, `helper-main.js` (ES modules; the folder's `package.json` says so) | `@carton/local`'s engine thread and headless helper, which wait at their top level | `@carton/local`, which finds them beside itself |
| `resources/app.asar/dist/renderer/assets/carton-ui.js` (ES module) | `@carton/react` and the History panel's view model (`scripts/carton/ui.js`) | The editor's History tab, by `import("./carton-ui.js")` the first time it shows |

**Why the Node side lives outside the asar,** next to `resources/cli/`:
- The CLI is outside the asar already, and it must load the same engine. One copy keeps the app and `cb` on one engine
  version, which the conformance suite assumes.
- We can't test here whether a `worker_threads` Worker can start from a file inside an asar archive. A file on disk
  always works.
- Changing Carton then needs no asar repack.

**Why the renderer bundle lives inside the asar,** beside the editor's chunks: the editor loads it with a relative
`import()` under the app's own origin. The editor bundle imports React 19.2.3 as `o` (namespace) and `c` (JSX
runtime). The History tab hands `o` to `carton-ui.js` (`window.__cartonReact`) before importing it, and esbuild maps
`react` to that (`scripts/carton/react-shim.js`). So Carton's components run inside the editor's own tree, theme and
portals. `@carton/react` also works under `preact/compat` for the web client.

**When Carton can't open a project's history,** for example while a package it needs isn't there yet, the facade
answers as Cardboard 1.4.0 would: no commit, `.revs` history, Cardboard's own merge and undo, and project files written
with a plain rename. It says so once in the log. The tests check that `cb` then writes exactly what 1.4.0 writes.

**The on/off switch.**
- **Build time.** `node scripts/build-windows.js --no-carton` leaves out every Carton step, so the output is the build
  as it was before Carton. `--baseline`, the media benchmarks' baseline, implies `--no-carton`.
- **Run time.** `CARDBOARD_CARTON=1` turns Carton on and `0` turns it off. Main reads it once at start. The library
  worker inherits it, and so does every agent main starts, so their `cb` calls agree. A build's default stays **off**
  until gates G1 and G2 pass on Windows.
- **Carton off.** Each hooked method runs Cardboard's original code at once, and nothing of Carton is loaded. The cost
  is one extra property read per hook.
- **Mixed states are safe by construction.** Some writers don't run Carton: an old `cb`, a text editor, a terminal `cb`
  without the variable. Each of those is a *foreign writer*. Carton displaces its save and imports it as an attributed
  change. It never overwrites it (§6.4).
- **Always on.** H11's `.cbproj` exclusions apply even with Carton off. A project that was ever tracked must not ship
  its `.carton/` database, which holds local paths and device pins.

**The bridges.** Each patched bundle gets a preamble that defines `__carton`. That is a small object whose functions
the hooks call, and it loads `carton-node.cjs` on first use. The bridges are the only code that knows 1.4.0's internals
(`seenOnDisk`, `byId`, the mirror's options, the editor store's `_m`). The packages only see documents, refs and actors.

**The live-sync and sharing half** (H8's lease holder and sync client, Invite to edit and Join, H10, H11's "Bring in
their changes", H13) lives in its own files, `scripts/carton/sync/**` and `scripts/patch-carton-sync.js`, and plugs in
at four points:
- **Worker services.** `scripts/carton/build.js` bundles `sync/worker.js` (when present) into `carton-node.cjs`, so it
  shares the facade's one copy of `@carton/*`. It calls the facade's `extend({worker(api)})`; in the library worker its
  services join the `carton` namespace beside the facade's own, never replacing one. `api` gives each project's open
  Carton (`carton(projectId)`, `open(bundlePath)`), `onOpen(fn)` for every Carton the worker opens, `emit`, and
  `materialize(projectId)`. An extension that throws is left out, logged once. `sync/ui.js` is bundled into
  `carton-ui.js` the same way, and the rest of `sync/` (but its tests) is copied to `resources\carton\sync`.
- **Facade hooks** (each optional on the extension; one that throws is skipped, logged once). `openOptions({bundlePath,
  projectId})` adds `openLocal` options for the project's handle: the worker's handle gets the project's sync connection,
  the person's actor and the replica's name; cb's gets the headless helper that syncs. `commitShared(lc, {doc, base,
  author, intent, gui})` takes a commit on a shared cut: the lease holder commits on its own handle (a stale save's
  clashes keep head's value, the rest lands), anyone else hands it to the holder, never committing in-process (its
  pending row would be lost at the holder's next settle). A `pending` result counts as a confirmation, `rebased` included,
  and its `head` is what the file gets when the caller's handle can't read the holder's pending state; `conflicts` carries
  the cards (the rest landed), `kept` when the holder already kept them for the author. A save Carton didn't write
  (another program's `project.json`) is imported the same way. On a local cut a stale save's clashes keep head's value
  and the rest lands too, the clash a card for its author. cb's other writes (restore, revert, undo, fold) ask the holder
  for its head as well (WriteOp `head`), so a write left pending reaches `project.json` with the app closed.
  `materializeDoc(next, {bundlePath, projectId, current})` fills in a record before head goes into `project.json` (a
  teammate's new clip: where it plays from, its size and duration). Head goes into `project.json` with `description` and
  with media through the store's own media scope (`ownedMediaIds` / `removedMediaIds`: 1.4.0's `updateScoped` never
  takes media from `ownedFields`), in the worker and in cb (`headScope`).
- **`carton:call` handlers.** `__cartonMain.handle(name, fn)` answers a method in main (it can still reach the worker
  with `__cartonMain.forward(name, args)`); `window.__carton.handle(name, fn)` answers one in the page. Off, none runs.
- **Patches.** `build-windows.js` (and the tests' `stage.js`) runs `scripts/patch-carton-sync.js --app` and `--cli`
  with the same files as `patch-carton.js`, right after it, when the script exists.

## 3. Hook table

Bundles: **CLI** = `resources/cli/chunks/chunk-LL26E55H.mjs` (the CLI's store and mirror). **cb** =
`resources/cli/cardboard.mjs` (commands and MCP). **Worker** = `dist/library-worker.js`. **Main** = `dist/main.js`.
**S** = `installErrorTelemetry-DxKId8tA.js` (editor store and save path). **I** = `index-DufLJgUU.js`. **E** =
`EditorRoute-CuIqwZKP.js`.

"Anchors" counts the one-line replacements. Their exact text is in appendix A. "Lines [E]" estimates the bridge code
behind the hook, not counting the packages.

| # | Cardboard concept (its source's terms) | Where (anchors) | Carton change | Lines [E] |
|---|---|---|---|---|
| H1 | **Project store mutations and writes.** `chain` serializes a project's mutations. `applyMutation(id, mutate)` applies one to `latest()`. `latest()` re-reads disk when the stamp `ino:size:mtimeNs` changed and nothing is unsaved. `enqueue` coalesces writes. `writeNow` renames `.project.json.<uuid>.tmp` over `project.json`. `updateScoped(doc, scope)` overlays `scope.ownedFields` (the GUI sends whole `tracks`/`timelineItems`) | CLI and Worker: `applyMutation`, `updateScoped`, the rename in `writeNow`, `read`'s `seenOnDisk.set`, the store's construction (`onWritten`). Main: `project:patch` forwards the save's `carton` field into the scope (11) | **Each mutation becomes one change**, committed against the exact document it was applied to (CAS in `.carton/carton.db`). A stale base is rebased with merge3, and the store adopts the merged head. Versioned fields become ops. Ephemeral fields go to the `ephemeral` table in the same transaction. A GUI save's arrays are diffed through the GUI projection against the renderer's own base (B3), not against the worker's latest. The rename becomes **displace-then-install**. A document Carton never wrote is imported as a foreign write | ~80 per copy |
| H1b | **Other writers of `project.json`.** CLI cloud pull writes it with the atomic helper `Ee`. Open Project (`.cbproj` and bundle import) writes it into a staging folder, then renames the folder into the library | CLI: cloud pull, Open Project. Worker: Open Project (3) | Cloud pull goes through the materializer (H13 replaces it with sync). An opened project's document becomes its first version, `main@1` | ~20 each |
| H2 | **Revisions and undo.** `recordRevision` keeps the newest 20 `.revs/<rev>.json` slices. `listRevisions` and `readRevision` read them. `history(id)` lists them. `undo(id, rev?)` writes an older slice as a new revision. These back `cb history`, `cb undo`, MCP `timeline_history` and `undo_timeline` | CLI and Worker: `listRevisions`, `readRevision`, recordRevision's own reads, `history`, `undo`'s write. cb: the history table, the `undo` command, `undo_timeline` (20) | `listRevisions` and `readRevision` read **Carton's history first** (every version, its `rev` = `stateUpdatedAt`), then any older `.revs`. So `history`, `undo <rev>`, the apply base and MCP edits at a `rev` all work on unlimited history through Cardboard's own code (B6). `recordRevision` keeps writing `.revs`, so switching Carton off loses nothing. `history` adds WHO and the cut. `undo --turn <id>` (and `undo_timeline {turn}`) reverts one agent turn as one inverse change at head (C10) | ~40 |
| H3 | **Timeline apply.** `apply(id, source, {prefer, dryRun})` parses `timeline.tsx` (literals only) and ingests new paths. The base is the `.revs` slice at or before the file's `// cardboard:rev` header, **falling back to the current document** when that slice was pruned (B2). It 3-way merges with `rn(base, current, file)`, with item-level conflicts and the whole nested value replaced (B4). It writes through `writeTimeline` → `updateScoped`. `applyEdits` does the same for MCP's `{oldText,newText}` edits at a `rev`. `writeMirror` rewrites `timeline.tsx` in place | CLI and Worker: the parse's rev, the base lookup, the `rn` call, the apply's and `writeTimeline`'s scope, `writeMirror`'s write (14) | The base is the exact version the header names, in either form: 1.4.0's `// cardboard:rev <ms>` (through the rev map) or Carton's `// cardboard:rev <cut>@<seq>~<hash8> b:<cut8> p:<nonce> by <who>`, which the Materializer prints (only the first rev line counts). A header `rev` that Carton and `.revs` can't reconstruct is an **error**, never a 2-way merge (principle 9). A file with no header keeps 1.4.0's meaning: edits on top of head. merge3 replaces `rn`: field-level, field groups decided as units (B13), remaps applied as intents, conflict cards kept as data. Its result keeps `rn`'s shape (`ops`, `conflicts`), so `cb`'s printer and MCP results don't change. The apply's result adds `carton: {status: confirmed\|pending\|conflicts, ref}`. `timeline.tsx` is written with displace-then-install | ~60 per copy |
| H4 | **GUI save.** `de()` arms a 300 ms timer. The timer copies the editor timeline into the project record and calls `updateProjectScoped(project, {ownedFields:["tracks","timelineItems"]})`. That serializes with `fm` (a field whitelist), rounds times to 0.1 s (`sv`), and sends `project:patch {document, scope}` (`Ss.updateScoped`, the only sender). The editor store's gated setter (`tN`) drops writes while `isWriteBlocked` (`Tm`) is true, and calls `onAcceptedDocumentWrite` (`rN`) on every accepted timeline write | S: the `project:patch` send, `de()`, `Tm`, the lock message (2), `initializeEditor`'s load, the gate's installation. Main: `project:patch` (7) | The save carries `carton: {base, actor:"person", intents, group}`. `base` is a new editor-store field, `cartonBase`. It is set at load and in the same store step as every adopt, and moves to the saved version when that save's own change event comes back. The renderer has no usable base today: `stateUpdatedAt` is overwritten by every local edit. **Preview is read-only:** `cartonPreview` joins `Tm`, so every edit path is refused with "Previewing an earlier version. Return to current to edit." `de()` doesn't save a preview | ~40 |
| H5 | **Adopt.** On `project:changed`, the renderer re-reads the project, replaces its record, and (`eV`) calls `cancelPendingSave()`, `pushHistory("Timeline updated from disk")` and `adopt(timeline)`, a raw store merge. A clock gate drops an event older than the local record's `stateUpdatedAt`, which **silently ignores a CLI write whenever the user edited after it but before the event arrived**. The next GUI save then overwrites it. Toast: "Some of your edits were replaced" | I: the per-event handler. Main: the change broadcast (2) | With Carton, main marks the event `carton`. If a save is armed it goes first, with its base: the worker rebases the person's edits on head (head wins a clash, the edit becomes a card). The editor then adopts head **once**, with `cartonBase` in the same raw store step. No `pushHistory`, no `cancelPendingSave`. That is what keeps a change from elsewhere from being saved again under the person's name (G1). The clock-gate race goes away | ~60 |
| H6 | **Undo.** `pushTimelineHistory(label)` pushes a whole-timeline snapshot (50 kept, `Qx`). `undo`/`redo` swap snapshots and restore code-graphic sources. Ctrl+Z, the toolbar and Edit > Undo all end at the store's `undo`/`redo` | S: `undo`, `redo` (2) | ⌘Z undoes **your actor group** as an inverse change at head: your edits, agent turns you started, and windowless local `cb` agents (§8). It arrives back through H5 with no undo entry. The pending save goes first. If Carton has no history for the project, Cardboard's snapshot undo runs. The snapshot push stays, because caption editing detects a push by `historyPast` identity | ~30 |
| H7 | **Ripple, split, remove silences, ripple trim.** Store actions wrap pure ops (`rippleDeleteGap`, `rippleDeleteAllGaps`, `removeSilencesFromClips`, `splitTimelineItem`) between the history push and the state write. The editor's ripple trim shifts later clips by `plan.rippleDelta` | S: four actions (4); E's ripple trim later | Each records its intent: a remap `{tracks, at, delta}` (piecewise for all gaps), or lineage for a split or a silence cut (new ids). The next save carries it, so a concurrent edit is remapped as an intent, not inferred (§6.1) | ~30 |
| H8 | **Bundle watcher and worker RPC.** The worker `fs.watch`es the library folder and each bundle (non-recursive, 150 ms debounce). A `project.json` it didn't write is re-read and announced as `changed`. A `timeline.tsx` it didn't write goes through `mirror.apply` and is announced as `timeline-applied` or `timeline-rejected`. The worker's RPC table is built from the namespaces `projects, media, cache, …` | Worker: the RPC namespace list, the worker's start, the watcher's apply (3) | Adds a `carton` RPC namespace (head, checkout, undo, redo, notices, the History panel's `ui`) that main's `carton:call` forwards to. A `timeline.tsx` the watcher applies is `external:timeline.tsx`. A commit that merged someone else's change is announced as `changed`, so the pages adopt it. Per-agent views and the shared file's freeze (`sync/views.js`): the adapter's Materializer for each project the worker opens from its library, the project's one lease holder, a watcher on `.scratch/views`; the watcher's apply of `timeline.tsx` hands the change to the Materializer there, and the facade drops Cardboard's own print of it. Next: the engine thread | ~40 |
| H9 | **Agents and the control socket.** Host agents are spawned per chat, with `cwd` = the bundle and the environment `o.environment`. Host Claude Code runs as `claude -p … --permission-mode bypassPermissions --append-system-prompt <prompt>`. The Director runs in-process with its own `env`, and has a `PreToolUse` Bash hook: the credit gate, which may rewrite the command. The prompt says to edit `timeline.tsx` or use `cb source apply`. The control socket (`cardboard.sock`, JSON-RPC) has a zod schema table and a handler table. It reads and drives the app, but has no edit method. Worker change events reach the tabs through `onChange` | Main: spawn env, Director env, the Director's hooks (2), the host Claude Code args, `carton:call` (6) | Every agent process gets `CARDBOARD_ACTOR`: `director/<chat>`, `claude/<chat>`, `codex/<chat>`, and so on. The Director's hook adds the turn. Inside a subagent it adds `/sub-<agent_type>-<agent_id>`, since Claude Code puts both in the hook input. It composes with the credit gate's rewrite. `Stop` and `SubagentStop` hooks block once per conflict set, with the conflict text (§6.2). Host Claude Code gets the same hooks through `--settings`. A `carton:call` IPC channel forwards to the worker, and `{kind:"carton"}` events go to the tabs as `carton:event`. `cb` finds Carton's lease holder through `carton.db`'s lease row, so the control socket needs no Carton method. H8: the Director's Read/Write/Edit hooks, an allowed stop and its turn's end reach the worker's Materializer (`carton.agentHook`); its Stop runs @carton/local's late-conflict hook in the worker (`carton.stopHook`); host Claude Code's `--settings` adds a `Read\|Write\|Edit\|MultiEdit` matcher, and `cb carton-hook` sends those events to the lease holder. Every agent's appended prompt (`ju`) and `AGENTS.md` describe the per-agent view, Carton on only | ~60 |
| H10 | **Media.** Ingest copies or references a file and gives it a random id (`Rt` in the CLI, `Ua` in the worker). Main serves `cardboard-media://` with range support (`oGt`) | CLI, Worker: ingest. Main: the media protocol (3) | Lazy SHA-256 manifests (1 MiB leaves) for shared projects, the range cache, and the loopback range server (phase 4, `@carton/media`). Nothing changes for solo local projects | ~60 |
| H11 | **`.cbproj`.** Save As writes a stored zip of the bundle minus the top-level names in a set (`cache`, `converted`, `proxies`, `.revs`). The walk compares only top-level names. Open Project refuses a project id already in the library ("This project ID already exists in your library", C9) | CLI and Worker: the set, the walk, the id check (6) | `.carton` joins the top-level exclusions. Carton's own view files in `.scratch/views/` (a print under Carton's rev line, its `.status` sidecar) are skipped by a nested check in the walk (R6-02); anything else there goes in. Both apply on or off, and Open Project removes the same from a staged bundle. The shallow export (or the opt-in `VACUUM INTO` copy) is written as its own entry. For a known project id with shared lineage, "Bring in their changes" (a DAG merge with cards) replaces the error. Imported view files are never applied | ~40 |
| H12 | **Web `DocumentSyncService`** (dormant on desktop). An IndexedDB outbox commits whole documents: `POST /api/sync/document {projectUid, mutationId, expectedVersion, document}`. On conflict it preserves a local copy named "… (recovered conflict)" and takes the server's (B9) | S: commit, POST, recover, stage. `DocumentSyncStartup`: the copy's name (5) | Kit only: push changes with a base instead of whole documents, and rebase instead of preserving a copy | ~100 |
| H13 | **CLI cloud mode** (`CARDBOARD_CLOUD_PROJECTS=1`). `df` PUTs the whole `project.json` with `ifVersion` and fails with `CloudConflictError` on a 412. `cb mcp` pulls before each tool call and pushes after | CLI: `df`. cb: pull and push around MCP calls (3) | Headless sync replaces the whole-file PUT. Pull fetches confirmed changes; push sends the pending queue (phase 3) | ~60 |
| UI | **Editor left rail and panels.** The rail registry `V_`. The panels kept mounted at idle (`uf`). The panel switch `dP(tab)`. An empty slot above the editor body. The timeline wrapper | E: the rail, the mounted panels, the panel switch (3) | A "History" rail tab, only with Carton on: versions, cuts, fold in, compare, credits, the preview banner and the conflict cards, from `@carton/react`. The panel loads `carton-ui.js` the first time it shows, and subscribes only while it shows, because idle panels stay mounted | ~250 UI |
| CLI | **Commands and MCP tools.** A commander program (`cardboard`, alias `cb`) and an MCP tool table `p(name, description, shape, readOnly, handler)` | cb: after every command is registered, before `list_media`, the banner of both CLI files (4) | `cb cut list\|new\|switch`, `cb fold <cut> [--check]`, `cb credits <clip>`, `cb restore <version>`, `cb compare <a> <b>`, `cb conflicts`, `cb resolve`, `cb publish`, with git aliases. MCP `timeline_cuts`, `timeline_fold`, `timeline_credits` and `timeline_publish` (`@carton/cli-mcp`) | ~30 |

## 4. The hooks in detail

### 4.1 H1: one change per mutation

**What 1.4.0 does.** The store serializes a project's mutations (`chain`). Each one is applied to `latest()` and kept
in `byId`. Writes are coalesced (`enqueue`). `writeNow` renames a temp file over `project.json`. It then records the
content hash in `lastWritten`, so its own watcher ignores the write, and the stamp and document in `seenOnDisk`. Last,
it runs the write listeners: revision, mirror, scaffold. `unsaved(id)` is `byId.document !== seenOnDisk.document`.

**What Carton changes:**

1. **`applyMutation(id, mutate, force)`** runs the original with a wrapped `mutate` that records the document the
   mutation was applied to: its exact base. If the mutation changed anything, the bridge commits it before the write
   is queued:
   - The **base ref** is the state the bridge got back from its own last commit, when the base is that very document.
     Otherwise Carton identifies it by its `stateUpdatedAt` and content hash. A base Carton doesn't know is a foreign
     write, imported first as `external:project.json`. A project with no history yet starts with its current document
     as `main@1`.
   - The **change** is `diff(base, doc)` through the Cardboard adapter: versioned fields, field groups, inferred
     remaps. Ephemeral fields (`updatedAt`, `lastOpenedAt`, thumbnail lists…) are stored in the same transaction.
   - With a **renderer base** in the scope (H4), the owned fields are diffed through the GUI projection `P = fm∘sv`
     against the version that base names, not against the worker's latest. A GUI save then carries only the
     person's edits (B3, B10).
   - The **commit** is a CAS in `.carton/carton.db`. `BEGIN IMMEDIATE` is held only around the check and the inserts
     (§6.2). If head moved, the change is rebased with merge3 and the mutation's result becomes the merged head. The
     store keeps that in `byId`, so the next mutation and the queued write both start from head. Each mutation is its
     own change with its own actor and base, even when the file writes coalesce.
2. **The rename in `writeNow` becomes displace-then-install** (§6.4):
   1. Rename whatever is at `project.json` into `.carton/displaced/`.
   2. `link(tmp, project.json)`. This fails with `EEXIST` if a foreign write landed in between, which is then
      displaced in turn.
   3. `unlink(tmp)`.

   The stamp `writeNow` read from the temp file stays valid, because a hard link keeps the inode. A displaced file
   that isn't Carton's last view is imported as an `external:project.json` change. On Windows a step that finds the
   file busy (another process has it open) is tried again on a timer for up to 5 s, never by blocking the worker's
   thread; every step is awaited, so one that still fails fails the save, as a failed rename did in 1.4.0.
3. **`read(id)`**: a document Carton never materialized is imported at once. A read that finds `project.json` (or
   `timeline.tsx`) missing in a bundle Carton tracks waits for it while an install holds the lock (else 50 ms):
   1.4.0's loader, its rescan and its watcher take a missing `project.json` for a removed project, and Carton's
   install leaves the name missing for a moment. The worker's watcher reads every outside
   save, so a foreign write is attributed when it lands, not when the next edit commits on top of it.
4. **Files follow commit order.** Two processes install `project.json` and `timeline.tsx` one at a time per bundle (a
   lock folder in `.carton/`, with its holder's pid and a heartbeat; a holder that is gone, or silent for a minute, is
   taken over by one rename). A file whose version is no longer head isn't installed, and its writer's store reads the
   disk again, so an older state never lands after a newer one. What the install moves aside is held in
   `.carton/displaced/` and journaled (`displaced.json`: when, and its stamp then); Carton's own files go once unchanged
   after the hold, a foreign `project.json` is imported and a foreign `timeline.tsx` applied through the mirror, and
   anything that can't be is kept and reported.
5. **Conflicts stay data.** A clash keeps head's value and the writer's side becomes a card, kept as a notice for its
   author (`cb conflicts`, the Stop hook). The person's own cards also show in the History panel, passed as core made
   them (`ours` is head, `theirs` the person's edit, shown as "mine"); resolving one removes the kept cards identical to
   it (the panel shows those once) and no other.
6. **If a commit fails** (a Carton bug, a full disk), the write still happens, as in 1.4.0, and the failure is logged.
   The next commit imports that file as an outside change. A Carton failure never stops the person from saving.

**Tests:**
- 4 concurrent `cb source apply` on different clips keep all 4 edits (B1; `research/pretty-extra/race-cb-apply.sh`
  loses some in stock 1.4.0).
- A GUI save during an agent apply keeps both.
- A GUI save of a stale array doesn't revert an agent's clip (B3).
- With Carton off, the written bytes equal 1.4.0's.

### 4.2 H2 and H3: history, undo and apply on Carton's history

- **`listRevisions` and `readRevision`** are the only readers of `.revs`, and `history`, `undo`, `apply` and
  `applyEdits` all go through them. With Carton on, they list and read Carton's versions on the current cut, newest
  first, in the same `{rev, at, doc}` shape. `doc` is the timeline slice: tracks, items and aspect ratio, with code
  sources inlined. Older `.revs` files follow. So every 1.4.0 caller gets unlimited history unchanged.
- **`recordRevision`** keeps reading and pruning its own files.
- **The base lookup.** In 1.4.0 the base is `revisionAtOrBefore(bundle, rev) ?? current`. With Carton, a header `rev`
  that nothing can reconstruct is an error: "This timeline was printed from version N, which is no longer available.
  Print it again (`cb source print`) and redo the edit." A file without a header keeps 1.4.0's meaning.
- **The header has two forms.** Cardboard's own mirror still prints `// cardboard:rev <n>`, so agents and docs need no
  change: every version records the `stateUpdatedAt` it was written with (the rev map, carton.db's `views` table), and
  a merged head gets a new, larger one. The Materializer (per-agent views, and the shared file while it's frozen)
  prints Carton's form on the same line: `// cardboard:rev <cut>@<seq>~<hash8> b:<cut8> p:<nonce> by <who>`
  (`@carton/cardboard`'s `header.ts`). 1.4.0's parse (`rt`/`li`, its `Rw`) reads only a line of digits, so for
  Carton's form it found no rev, or a later line's, and the apply merged against the current document. With Carton
  on, the apply's parse (`g=Nh(r)?rt(r):r` / `h=OC(r)?li(r):r`) goes through `__carton.headerRev(parsed, text)`: when the
  first rev line's body (`header.ts`'s `findRev`/`parseRevBody` grammar) is not all digits, it is a Carton ref and
  becomes the parse's `rev`, a string. The base lookup sends a string `rev` to `__carton.cartonBase(rev, bundle)`
  (the facade's `revision({bundlePath, ref, slice})`: core's `resolve` checks the ref exactly, its state hash
  included, then `checkout` and the bundle's slice) instead of `revisionAtOrBefore`; one core can't rebuild is the
  error above. A numeric first line keeps 1.4.0's lookup. With Carton off, nothing changes.
- **Cardboard's own printer and parser for the Materializer** (the store bridge, both copies). With Carton on, each
  copy sets `globalThis.__cartonTimelineCodec = {print, parse}` (`@carton/cardboard`'s `TimelineCodec`) at bundle
  load, before `carton-node.cjs` loads:
  - `print(project, rev)` is the mirror's own `printTimeline(project, slice(project), rev, [])`: exactly what
    `cb source print` and the mirror write for that project, with `rev` verbatim on the rev line (Cardboard's 4th
    header line) in place of its `stateUpdatedAt`. The media table, cast and LUT list come from the project and its
    library (a video's proxy state, the bundle's `luts/`), as in Cardboard's print.
  - `parse(text, project)` is Cardboard's apply of the file onto a copy of `project` with base = current, without
    writing anything: the literal-only parse (`rt`/`li`), `src` names resolved against `project.media`, the LUT step
    dry (`Lh`/`RC`), code templates read from the bundle, the item conversion (`Ta`/`Iy`) with stored items for what the
    file doesn't print, the apply's reframe of new clips (`dh`/`iC`), media made for text and code items
    (`hs`/`S4`), `rn`/`$f`, then `writeTimeline`'s document through the store's own scoped merge (`pd`/`dw`,
    `qx`/`YZ`, `Jo`/`K1`: code sources move into `media[].data.code.source`). Its result equals what `cb source apply`
    writes into `project.json` for that file, but for `updatedAt` and `stateUpdatedAt`, which stay `project`'s. It
    throws on text that doesn't parse (a half-written file) and on any error diagnostic; and on what only the apply
    can do, which writes: a `src` path to a file not in the project (ingest), a `.cube` outside `luts/` (import),
    `colorGrade.match` (measured from frames). `project` is never changed (the parse works on a structured clone).
    It needs `project.media` to resolve names and `project.id` for the bundle (templates, LUT paths).
  - Each needs the process's library: the store bridge's `attach` records the mirror (weakly); a project is printed
    and parsed by the mirror whose library holds it, else the first. Before any library opens, both throw.
  - The parser's names are only valid in 1.4.0: `patch-carton.js` checks each one where Cardboard's apply,
    `writeTimeline` or store calls it (the `codec.proofs` anchors, Appendix A.1), so another bundle stops the build.
- **merge3 replaces `rn`.** `rn(base, current, file, {prefer})` becomes Carton's merge3 with the adapter's schema:
  - `--prefer file` (the default) keeps the file's side of a conflict and records a card;
  - `--prefer editor` keeps head's side.

  The result has `rn`'s shape. Its `conflicts` are item-level, as `cb` prints them, and the cards are kept in Carton.
- **The apply's write** goes through `writeTimeline`, whose scope carries `{source:"timeline", rev}`. So H1's commit
  for it uses the header's version as its base, and the concurrent changes' recorded remaps apply. A Carton ref is
  the commit's base as it is (core's `commit` and `checkout` take a header string); one that stopped resolving between
  the apply's lookup and its commit fails the commit (the save is kept, as for any failed commit), never a commit
  on head. An `undo <rev>`
  writes with `{source:"undo", rev}`.
- **`undo --turn <id>`** reverts every change of one turn as one inverse change at head. A path someone else has
  changed since gives a card (§8).

### 4.3 H4 to H7: the renderer

**Save (H4).**
- The editor store gets two fields, set only through its raw setter: `cartonBase` (the `rev` of the version the
  editor shows) and `cartonPreview`.
- `initializeEditor` sets `cartonBase` from the loaded project record. Every adopt sets it in the same raw store call
  that changes the timeline (H5).
- The save's `project:patch` payload gets `carton: {base, actor:"person", intents, group}`. The intents come from H7;
  the group is the undo group (H6). Main forwards the payload into the scope (H1).
- The save is built synchronously, in the same tick that reads `cartonBase`, so no adopt can slip in between.
- On the save's ack, `cartonBase` advances to the saved `rev`, but only if it still equals the base that was sent.

**Read-only preview (H4).**
- Compare and the A/B toggle load an earlier version into the editor with the raw setter and set `cartonPreview`.
- `Tm` (the editor's "editing blocked" predicate) then refuses every edit, whether it comes from a store action or the
  gated `setState`. The refusal toast offers "Return to current to edit".
- `de()` doesn't arm a save while previewing.

**Adopt (H5).**
- Main marks every project change it broadcasts while Carton is on (`carton: true`), and the page takes the Carton path.
- The echo of the page's own save (same `rev` as the save it sent) only moves `cartonBase` to that version.
- Otherwise, if a save is armed, it goes first (the store's own flush), with its base. The worker commits only the
  person's edits and rebases them on head: a clash keeps head's value and the edit becomes a card. If the person keeps
  editing during the round trip, that save goes too.
- The page then reads the project, replaces its record and adopts the timeline with one raw store call that also sets
  `cartonBase`. There is no `pushHistory` and no `cancelPendingSave`, so the change is not on the person's undo stack
  and no edit is dropped.
- A change for another project, or a removal, takes Cardboard's own path. During a preview the change waits, and
  "Return to current" takes head.

**Undo (H6).**
- `undo()` and `redo()` first send the pending save, then ask the worker for the inverse of the person's actor group's
  latest change at head. The result comes back through H5.
- With Carton off, or without history for the project, Cardboard's snapshot undo runs.

**Remaps (H7).**
- Ripple delete records `{kind:"remap", tracks:[t], at:end, delta:start-end}`.
- Delete all gaps records a piecewise map.
- Remove silences records one remap per clip, plus lineage from the old clip to its new pieces.
- Split records lineage only.
- Ripple trim records the shift it applies.
- The queue drains into the next save, which is the save that contains the effect.

### 4.4 H8 and H9: the worker, the engine thread and who is acting

- **The engine thread.** `@carton/local` runs the engine, the lease holder and its control socket on a worker thread of
  the library worker, so a lock wait or a ping never waits on the worker's main loop (P3b, R5-06). The `carton` RPC
  namespace serves the History panel, through main's `carton:call`.
- **`cb` commits** directly to `carton.db` while the project is local, and SQLite orders the processes. Once a cut is
  shared, the sync lease decides who pushes (§6.2). `cb` finds the holder through the lease row, so Cardboard's control
  socket needs no Carton method.
- **Actor ids:**
  - `person`: the GUI;
  - `director/<chat>/<turn>[/sub-<type>-<id>]`: the Director, down to the subagent;
  - `claude/<chat>`, `codex/<chat>`: host agents;
  - `cli`: a terminal `cb` with no actor;
  - `external:project.json`, `external:timeline.tsx`: foreign writes;
  - `app`: the worker's own media bookkeeping, which is ephemeral.
- **The Director's hook.** Its `PreToolUse` Bash hook prefixes the command with
  `export CARDBOARD_ACTOR='director/<chat>/<turn>[/sub-…]';`. That covers compound commands too. The turn comes from
  main's record of the chat's running turn. A credit-gate rewrite is kept and prefixed in the same way.
- **Turn names.** When a Director turn ends (`closeTurn`), its last version on the current cut is named with a short
  label from the user's prompt (its first sentence, at most six words: "Make the intro tighter"), so History shows
  turns as the chat shows its checkpoints. The prompt goes only into the project's history, never into a log.
- **The conflict hooks.** The `Stop` and `SubagentStop` hooks read that actor's notices. They block once per conflict
  set with the conflict text, and don't block again when `stop_hook_active` is set.

### 4.5 H11: `.cbproj`

- **The walk.** A nested check runs before the top-level set: `__carton.skipInArchive(dirRel, name, dir)` skips
  `.carton` at the top, and in `.scratch/views` only the files `__carton.cartonView` tells as Carton's: a `<view>.tsx`
  whose first `cardboard:rev` line is Carton's (`<cut>@<seq>~<hash8> b:…`; 1.4.0's is a bare number) and a
  `<view>.status` in the materializer's status format. A person's or an agent's own files there go in, as in 1.4.0.
  Open Project's scrub of a staged bundle removes the same, on or off.
- **Export.** The shallow export, or the opt-in `VACUUM INTO` copy with the local tables dropped, is added as one
  archive entry.
- **Import.** The id check calls Carton first, which compares lineage:
  - shared lineage offers "Bring in their changes": a DAG merge into the current cut, with cards;
  - no shared lineage forks a new id;
  - a missing common state gives the explicit dialog (§13), never an older base.

## 5. The bridge contract

What the hooks need from the packages, by bridge function. `scripts/carton/carton-node.js`, the facade, maps these
onto the packages' APIs, so a package API change touches only the facade.

| Bridge function | Hook | Facade (`cardboard14`) | Packages |
|---|---|---|---|
| `applyMutation(store, id, mutate, force)` | H1 | `commit({bundlePath, base, doc, actor, meta}) → {doc, ref, status, conflicts}`; `doc` is the input itself when nothing was merged in | `local` (`openLocal`, `Carton.commit/head/checkout`), `cardboard` (`fromHost`, `toHost`, `projectGuiSave`) |
| `install(tmp, file, seenStamp)`, `writeFile(file, text)` | H1, H3 | `install`: displace-then-install, the displaced files held and reviewed, a record of what Carton wrote | `cardboard/node` (`displaceThenInstall`, `DisplacedFiles`, `hardLinksWork`) |
| `sawDisk(store, id, doc)` | H1 | `sawDisk({bundlePath, doc})` imports a foreign write | `local`, `cardboard` |
| `listRevisions`, `readRevision` | H2, H3 | `revisions({bundlePath, files})`, `revision({bundlePath, rev, file})` in `.revs`'s `{rev, at, doc}` shape | `local` (`log`, `checkout`) |
| `headerRev(parsed, text)`, `cartonBase(rev, bundlePath)` | H3 | `revision({bundlePath, ref, slice, file})` → `{ref, doc}` for a Carton header ref core rebuilds exactly (`resolve`, then `checkout`); the rev map's `refOf` resolves such a string for the commit's base too | `local` (`Carton.resolve/checkout/commit`) |
| `history(mirror, id, rows)` | H2 | `history({bundlePath, rows})`: rows with `who` and `cut` | `local` |
| `__cartonCli.undoTurn(lib, id, turn)` | H2 | `undoTurn({bundlePath, turn, actor})` | `local` |
| `missingRev(rev, current)` | H3 | (bridge only) the "print again" error | — |
| `globalThis.__cartonTimelineCodec` (`print`, `parse`) | H3, H8 | (bridge only) Cardboard's own printer and parser, for the Materializer | `cardboard` (`TimelineCodec`) |
| `merge3(base, current, file, opts, rn)` | H3 | `merge3({base, current, file, prefer, rn})` in `rn`'s shape | `cardboard` + `core` |
| `status(id)` | H3 | (bridge only) the last commit's `{status, ref, conflicts}` | — |
| `worker(library, emit)` | H8 | `worker({library, emit})`: the `carton` RPC namespace | `local`, `react` (`fromCarton`) |
| `__cartonCli.commands`, `mcp`, `carton-hook` | CLI, H9 | `run(argv, io)`, `mcpTools()`, `hook({event, input, env})` | `cli-mcp` (`runCb`, `mcpTools`), `local` (hooks) |
| `__cartonMain.*` | H9 | (main only) actor env, Director hook wrap, Stop/SubagentStop, `carton:call` | `local` (notices) |
| `window.__carton.*` | H4–H7, UI | (pages) `saveMeta`, `receive`, `undo`/`redo`, `intent`, `preview`, `call`, `onEvent` over `carton:call` | `react` |

## 6. State on 2026-10-31

- **Working, tested on Linux** with Cardboard's real bundles:
  - `scripts/carton/test/` (38 tests): Carton off, `cb`'s output and files equal our Windows build's, and the real
    library worker runs patched. Cardboard's own printer and parser as Carton's codec, in both copies: the print is
    `cb source print`'s with the given rev, the parse gives the project back and equals what `cb source apply` writes,
    a half-written file is refused (`codec.test.js`). An apply of a file under Carton's header, in `cb` and in the
    worker, merges against that exact version, and its commit is based on it; an unknown ref is the "print it again"
    error; with Carton off such a file applies as our Windows build applies it. Carton on, for real (`@carton/local` and `carton.db`): history with authors down to
    the subagent, credits, a cut with `project.json` following the switch, fold, `undo --turn` raising a card, and 4
    concurrent `cb` writers losing no edit (B1). The rev map: 1.4.0's numeric header and `cb undo <rev>` name Carton
    versions. A read that catches an install's gap waits. The staging folder's removal retry. The pages' bridge and
    main's bridge, on stand-ins.
  - `scripts/carton/test/sync/` (two libraries, each with its own app data and its own real library worker, syncing
    through a real host on 127.0.0.1): H8's share, invite and join, live edits both ways, presence, offline and
    rejoin, the Share panel's words; H10 for shared projects (hashing, the collab proxy, play by range and while it
    uploads, tools over the loopback range server); H11 `.cbproj` Save As and Open with history, "Bring in their
    changes", Carton's files never carried or kept; H13 `cb`'s cloud mode through a headless helper; the facade's
    save merges.
  - H8's per-agent views and the shared `timeline.tsx` freeze (`scripts/carton/sync/views.js`), on one library with
    its real worker, real `cb` and main's bridge as `dist/main.js` runs it (`sync/director-turn.test.js`, e2e-qa's
    acceptance test): a Director turn prints its view (`cb source print --view`, through the worker's lease holder);
    the person edits in the GUI; the agent saves its view and reads `.status` (`conflicts`, with the card); all
    through the turn `timeline.tsx` never shows the person's edit (sampled every 50 ms); the Stop hook blocks once
    with the card, the next stop lets the turn end and `timeline.tsx` comes back to head with both edits; the card is
    in the agent's `cb conflicts` and in the History panel; credits and the turn's named version. The worker runs
    cardboard-adapter's Materializer for every project it opens from its library (writeProject off: `project.json`
    stays the facade's), with Cardboard's printer as codec; the facade drops Cardboard's own print of
    `timeline.tsx` there (in `cb`: when the worker holds the project's lease) and the worker's watcher hands the file's
    changes to the Materializer. One lease holder per project (the View's; Live sync uses it). The prompt's view flow:
    `AGENTS.md` (Cardboard's text plus a section, Carton on only) and every agent's appended system prompt.
    Steps 9 and 10 take the same turn through the hooks themselves: the Director's file tools (main's in-process
    hooks) and host Claude Code's (`cb carton-hook`, spawned with the hook's JSON on stdin): a Read of `timeline.tsx`
    freezes it, a Write/Edit of `project.json` is refused with a pointer to `cb source print --view`, the Stop lets go.
    Views are polled (a stat every 250 ms, only the views Carton printed): no watch handle inside the bundle, which on
    Windows can block Cardboard's rename or trash of it. Stopgap until cardboard-adapter merges an agent's own `cb`
    commit into the frozen file: such a commit during a freeze reprints the shared file from head (`printShared`).
- **Built:** `carton-node.cjs`, `engine-thread-main.js`, `helper-main.js`, `factory.js`, `fmsv.cjs` (1.4.0's own GUI
  save projection, cut out at build time) and `carton-ui.js`.
- **Wired, tested on stand-ins only:** the editor's pages (H4–H7, the History tab, the Share panel) and main (H9: the
  actor environment, the Director's hooks, Stop and SubagentStop, host Claude Code's `--settings`, `carton:call`).
  They need the Windows run.
- **Not wired yet:**
  - H3: Carton's merge3 in the apply's preview. `rn` still makes the preview; the commit that follows merges with
    Carton.
  - The engine thread: `engine-thread-main.js` is built but not used; the worker commits on its own thread.
  - H1b has no hook of its own. Open Project of a `.cbproj` scrubs and seeds the staged copy (H11); a project folder's
    copy keeps its history and files (both imports share Carton's release of the staged copy when `prepare` ends). A shared project's cloud pull is H13's. Cardboard's own cloud
    pull of an unshared project writes `project.json`, which the read path imports as an outside change (not tested
    for the cloud pull).
  - H12 is for the kit only: the service is dormant on desktop, so nothing is patched there.
- **Windows only:** the editor's pages (H4–H7, the History tab), gates G1 and G2, the NTFS displace/install race. See
  the README, "Carton" → "Testing Carton".

## Appendix A: every anchor, checked

Counted with `src.split(anchor).length - 1` in the pristine 1.4.0 bundles, and again on the output of our Windows
patches, where `patch-carton.js` applies them (2026-10-31). `@` is the byte offset of the first match in the pristine
file, and the size is the anchor's length in bytes. `CARTON_LIST_ANCHORS=1 node scripts/patch-carton.js …` prints A.1.

### A.1 The anchors patch-carton.js replaces (107)

Each copy's first ten are the timeline codec's proofs, replaced by themselves: each shows a name the codec calls
where Cardboard's own apply, `writeTimeline` or store calls it (§4.2).

```
ok  Worker 1 @1418249   15B  "h=OC(r)?li(r):r"
ok  Worker 1 @1418924   28B  "pathOf:x=>LC(x)?kd(x,i):null"
ok  Worker 1 @1419012   24B  "Q=F?await RC(F,h,K):null"
ok  Worker 1 @1419084   20B  "let fe=await YQ(h,i)"
ok  Worker 1 @1419112  103B  "Ee=Iy(h,{resolveMedia:S,readTemplate:x=>fe.get(x)??null,storedItem:xy(Zs(a)),newId:this.options.newId})"
ok  Worker 1 @1419588  150B  "we=await iC(be,de,B,x=>{let _=I.get(x);return(_&&cw(_))??void 0},n.prefer),qe=S4(xI(we,de),a,this.options.newId),ee=$f(be,de,qe.doc,{prefer:n.prefer})"
ok  Worker 1 @1421883   39B  "writeTimeline(t,r,n){let i={...Ay(t,r),"
ok  Worker 1 @1422013   76B  "a=rd(i);return this.options.bundles.updateScoped(vI(i),{ownedFields:[...My],"
ok  Worker 1 @1262940   18B  "n=>YZ(n,dw(n,t,r))"
ok  Worker 1 @1263655   35B  "this.applyMutation(t,s=>K1(r(s)),n)"
ok  Worker 1 @1263890   27B  "async applyMutation(t,r,n){"
ok  Worker 1 @1262940   18B  "n=>YZ(n,dw(n,t,r))"
ok  Worker 1 @1266073   38B  "l=await G1(c),await(0,Bt.rename)(c,s)}"
ok  Worker 1 @1255225   71B  "try{t=await(0,Bt.readFile)((0,rt.join)(e,Mt),\"utf8\")}catch{return null}"
ok  Worker 1 @1262348   59B  "return this.seenOnDisk.set(t,{stamp:o,document:s.project}),"
ok  Worker 1 @1471612   38B  "n.onWritten((y,x)=>m.afterWrite(y,x));"
ok  Worker 1 @1424720   82B  "let[u]=await this.listRevisions(r),p=u===void 0?null:await this.readRevision(r,u);"
ok  Worker 1 @1425091   59B  "let l=await this.listRevisions(r);for(let u of l.slice(20))"
ok  Worker 1 @1424032   23B  "async listRevisions(t){"
ok  Worker 1 @1424213   24B  "async readRevision(t,r){"
ok  Worker 1 @1421085   17B  "async history(t){"
ok  Worker 1 @1421828   55B  "return await this.writeTimeline(i,s.doc,s.added),o.rev}"
ok  Worker 1 @1418249   15B  "h=OC(r)?li(r):r"
ok  Worker 1 @1419542   46B  "be=await this.revisionAtOrBefore(i,h.rev)??de,"
ok  Worker 1 @1419701   37B  "ee=$f(be,de,qe.doc,{prefer:n.prefer})"
ok  Worker 1 @1420071  155B  "let y=await this.writeTimeline(a,ee.doc,[...b,...qe.added]);return p({applied:!0,ops:J,conflicts:P,diagnostics:re,rev:y?.stateUpdatedAt??a.stateUpdatedAt})"
ok  Worker 1 @1421883   38B  "writeTimeline(t,r,n){let i={...Ay(t,r)"
ok  Worker 1 @1422021   68B  "return this.options.bundles.updateScoped(vI(i),{ownedFields:[...My],"
ok  Worker 1 @1423605   52B  "await(0,Gr.writeFile)(this.mirrorPath(t),r,\"utf8\"))}"
ok  Worker 1 @1267459   37B  "if(o&&(rH.has(a.name)||a.name===Mt)||"
ok  Worker 1 @1414024   58B  "OC=e=>typeof e==\"string\",$C=\"# This is a Cardboard project"
ok  Worker 1 @1416104   15B  "\",HQ=async e=>{"
ok  Worker 1 @1481784  112B  "var IA=[\"projects\",\"media\",\"cache\",\"transcripts\",\"voiceovers\",\"mattes\",\"inspect\",\"timeline\",\"luts\",\"downloads\"];"
ok  Worker 1 @1482325   24B  "kte=e=>{let t=\"\",r=()=>{"
ok  Worker 1 @1469002   52B  "c=async g=>{let T=t.idForBundlePath(g);if(!T)return;"
ok  Worker 1 @1469154   41B  "await t.read(T);let I=await r.apply(T,k);"
ok  Worker 1 @1468657   62B  "k=await(0,_d.readFile)((0,Vn.join)(g,Mt),\"utf8\")}catch{k=null}"
ok  Worker 1 @1477718   90B  "let $=await(0,Ar.readFile)(m.mirrorPath(N),\"utf8\");return m.apply(y,$,{..._,writeBack:!0})"
ok  Main   1 @76        22B  "var cxe=Object.create;"
ok  Main   1 @2875234   56B  "_e.handle(\"project:patch\",async({document:t,scope:r})=>{"
ok  Main   1 @2875450   36B  "St.call(\"projects.updateScoped\",t,r)"
ok  Main   1 @2681412   79B  "e.tabs.broadcast(\"project:changed\",{id:i,stateUpdatedAt:o.stateUpdatedAt,...s})"
ok  Main   1 @2681590   57B  "onChange:async i=>{if(i.kind===\"removed\"){n(i.id);return}"
ok  Main   1 @2767297   58B  "this.deps.spawn(o.path,c.args(p),{cwd:i.bundlePath,env:b})"
ok  Main   1 @2725359   15B  "env:CVt(e,t,c),"
ok  Main   1 @2587228   45B  "PreToolUse:[{matcher:\"Bash\",hooks:[async v=>{"
ok  Main   1 @2588123   52B  "permissionDecisionReason:k.reason}}}],timeout:Tzt}]}"
ok  Main   1 @2766497   44B  "n.turn={state:\"running\",id:s.id,text:s.text}"
ok  Main   1 @2771821   41B  "closeTurn(t,r){t.turn.state===\"running\"&&"
ok  Main   1 @2645491   31B  "\"--append-system-prompt\",ju(e),"
ok  Main   1 @2642960   38B  "Never write `project.json` directly.\","
ok  S      1 @1556833  115B  "ne.setState=tN({getState:ne.getState,isWriteBlocked:Tm,onAcceptedDocumentWrite:rN,onRejectedWrite:xv,setState:_m});"
ok  S      1 @1128812   75B  "updateScoped:(t,e)=>Zp(t.id,cK(e),On(\"project:patch\",{document:t,scope:e}))"
ok  S      1 @1525370   52B  "_m({projectId:n,projectName:r,activeLeftTab:\"media\","
ok  S      1 @1520713   44B  "Tm=t=>ah()||t.timelineLockState!==\"unlocked\""
ok  S      1 @1555464   15B  "ure=t=>ah()?aN:"
ok  S      1 @1555786   26B  "(n===iN||n===sN||n===aN)&&"
ok  S      1 @1559585   46B  "function de(){const e=ne.getState().projectId;"
ok  S      1 @1544606   37B  "undo:()=>{if(me())return;const n=e();"
ok  S      1 @1545211   37B  "redo:()=>{if(me())return;const n=e();"
ok  S      1 @1551117   77B  "e().pushTimelineHistory(\"rippleDeleteGap\"),t({timelineItems:s.timelineItems})"
ok  S      1 @1551349   81B  "e().pushTimelineHistory(\"rippleDeleteAllGaps\"),t({timelineItems:i.timelineItems})"
ok  S      1 @1550578   56B  "return e().pushTimelineHistory(\"removeSilences\"),t(c=>({"
ok  S      1 @1546888   60B  "i?.skipHistory||e().pushTimelineHistory(\"splitTimelineItem\")"
ok  I      1 @1113444   53B  "sV=async(e,t)=>{const{id:a,timeline:n,artefacts:s}=t;"
ok  E      1 @342410    80B  "{id:\"effects\",icon:gw,label:\"Effects\",event:\"filters_panel_opened\"}]],U_=V_.map("
ok  E      1 @350297    92B  "uf=[\"media\",\"layouts\",\"music\",\"captions\",\"voiceover\",\"text\",\"transitions\",\"effects\"].filter("
ok  E      1 @350679    54B  "case\"effects\":return c.jsx(tP,{});default:return null}"
ok  CLI    1 @84        50B  "const require = __createRequire(import.meta.url);\n"
ok  CLI    1 @299554    15B  "g=Nh(r)?rt(r):r"
ok  CLI    1 @300216    28B  "pathOf:y=>$h(y)?Dn(y,o):null"
ok  CLI    1 @300304    24B  "F=D?await Lh(D,g,k):null"
ok  CLI    1 @300376    19B  "let $=await a2(g,o)"
ok  CLI    1 @300402   101B  "q=Ta(g,{resolveMedia:I,readTemplate:y=>$.get(y)??null,storedItem:wa(Cr(i)),newId:this.options.newId})"
ok  CLI    1 @300868   140B  "z=await dh(B,j,R,y=>{let x=S.get(y);return(x&&Xn(x))??void 0},n.prefer),J=hs(km(z,j),i,this.options.newId),Z=rn(B,j,J.doc,{prefer:n.prefer})"
ok  CLI    1 @303124    39B  "writeTimeline(t,r,n){let o={...Aa(t,r),"
ok  CLI    1 @303254    76B  "i=mn(o);return this.options.bundles.updateScoped(Lm(o),{ownedFields:[..._a],"
ok  CLI    1 @157840    18B  "n=>qx(n,pd(n,t,r))"
ok  CLI    1 @158555    35B  "this.applyMutation(t,c=>Jo(r(c)),n)"
ok  CLI    1 @158790    27B  "async applyMutation(t,r,n){"
ok  CLI    1 @157840    18B  "n=>qx(n,pd(n,t,r))"
ok  CLI    1 @160835    28B  "d=await Qo(l),await Bx(l,c)}"
ok  CLI    1 @150270    50B  "try{t=await jm(Pe(e,re),\"utf8\")}catch{return null}"
ok  CLI    1 @157257    59B  "return this.seenOnDisk.set(t,{stamp:a,document:c.project}),"
ok  CLI    1 @344422    38B  "n.onWritten((h,y)=>f.afterWrite(h,y));"
ok  CLI    1 @305827    82B  "let[m]=await this.listRevisions(r),p=m===void 0?null:await this.readRevision(r,m);"
ok  CLI    1 @306180    59B  "let d=await this.listRevisions(r);for(let m of d.slice(20))"
ok  CLI    1 @305183    23B  "async listRevisions(t){"
ok  CLI    1 @305353    24B  "async readRevision(t,r){"
ok  CLI    1 @302326    17B  "async history(t){"
ok  CLI    1 @303069    55B  "return await this.writeTimeline(o,c.doc,c.added),a.rev}"
ok  CLI    1 @299554    15B  "g=Nh(r)?rt(r):r"
ok  CLI    1 @300824    44B  "B=await this.revisionAtOrBefore(o,g.rev)??j,"
ok  CLI    1 @300975    33B  "Z=rn(B,j,J.doc,{prefer:n.prefer})"
ok  CLI    1 @301326   153B  "let h=await this.writeTimeline(i,Z.doc,[...w,...J.added]);return p({applied:!0,ops:se,conflicts:A,diagnostics:_,rev:h?.stateUpdatedAt??i.stateUpdatedAt})"
ok  CLI    1 @303124    38B  "writeTimeline(t,r,n){let o={...Aa(t,r)"
ok  CLI    1 @303262    68B  "return this.options.bundles.updateScoped(Lm(o),{ownedFields:[..._a],"
ok  CLI    1 @304809    39B  "await Uh(this.mirrorPath(t),r,\"utf8\"))}"
ok  CLI    1 @162151    37B  "if(a&&(nS.has(i.name)||i.name===re)||"
ok  CLI    1 @295432    58B  "Nh=e=>typeof e==\"string\",jh=\"# This is a Cardboard project"
ok  CLI    1 @297512    30B  "\",n2=async e=>{let t=await On("
ok  cb     1 @84        50B  "const require = __createRequire(import.meta.url);\n"
ok  cb     1 @752048    14B  "var FN=ak(Ie);"
ok  cb     1 @740630    87B  ".action(async(a,s)=>{let o=await H(r()),i=await I(o,a),c=await o.timeline.undo(i.id,s);"
ok  cb     1 @604506    21B  "p(\"timeline_history\","
ok  cb     1 @604809    18B  "p(\"undo_timeline\","
ok  cb     1 @605113    15B  "p(\"list_media\","
```

### A.2 Mapped for the hooks still to come (H1b, H10, H11 import, H12, H13, the rest of H4–H7 and the UI)

```
ok  H1                CLI    1/1 @157798    62B  "updateScoped(t,r){return this.mutate(t.id,n=>qx(n,pd(n,t,r)))}"
ok  H1                Worker 1/1 @1262898   62B  "updateScoped(t,r){return this.mutate(t.id,n=>YZ(n,dw(n,t,r)))}"
ok  H1                CLI    1/1 @160835    68B  "d=await Qo(l),await Bx(l,c)}catch(p){throw await Ux(l,{force:!0}),p}"
ok  H1                Worker 1/1 @1266073   84B  "l=await G1(c),await(0,Bt.rename)(c,s)}catch(p){throw await(0,Bt.rm)(c,{force:!0}),p}"
ok  H1b               CLI    1/1 @202951    59B  "JSON.stringify(I(O,T,h),null,2);return await Ee(me(T,re),V)"
ok  H1b               CLI    1/1 @238537    36B  "await Zs(ke(a,re),JSON.stringify(u))"
ok  H1b               Worker 1/1 @1351200   58B  "await(0,Rt.writeFile)((0,St.join)(o,Mt),JSON.stringify(d))"
ok  H2                CLI    1/1 @302639    16B  "async undo(t,r){"
ok  H2                Worker 1/1 @1421398   16B  "async undo(t,r){"
ok  H2                cb     1/1 @740243    48B  "me([[\"REV\",\"SAVED\",\"TRACKS\",\"ITEMS\",\"DURATION\"],"
ok  H2                cb     1/1 @740395    30B  "t.command(\"undo\").description("
ok  H2                cb     1/1 @604809    18B  "p(\"undo_timeline\","
ok  H3                CLI    1/1 @301326    58B  "let h=await this.writeTimeline(i,Z.doc,[...w,...J.added]);"
ok  H3                Worker 1/1 @1420071   60B  "let y=await this.writeTimeline(a,ee.doc,[...b,...qe.added]);"
ok  H8                Worker 1/1 @1468541   27B  "var mte=150,TA=(e,t,r,n)=>{"
ok  H9                Main   1/1 @2587228   90B  "PreToolUse:[{matcher:\"Bash\",hooks:[async v=>{if(v.hook_event_name!==\"PreToolUse\")return{};"
ok  H9                Main   1/1 @2645451   70B  "\"--permission-mode\",\"bypassPermissions\",\"--append-system-prompt\",ju(e)"
ok  H9                Main   1/1 @2642826  170B  "Change the timeline by editing `timeline.tsx` in this directory or with `cb source apply`; the app shows edits live as you make them. Never write `project.json` directly."
ok  H9                Main   1/1 @2658216   58B  "\"export.cancel\":l.object({...td,jobId:l.string().min(1)})}"
ok  H9                Main   1/1 @2658862   36B  "kHt=({host:e,relay:t,exports:r})=>({"
ok  H9                Main   1/1 @2875234   26B  "_e.handle(\"project:patch\","
ok  H10               Main   1/1 @2779395   17B  "oGt=async(e,t)=>{"
ok  H10               CLI    1/1 @185657    23B  "Rt=async(e,t,r,n={})=>{"
ok  H10               Worker 1/1 @1296366   23B  "Ua=async(e,t,r,n={})=>{"
ok  H11               CLI    1/1 @161903    29B  "var nS=new Set([Be,jt,ar,sr])"
ok  H11               Worker 1/1 @1267192   29B  "var rH=new Set([Nn,po,Ps,_s])"
ok  H11               CLI    1/1 @237313    96B  "if(i.project.id===t.project.id)throw new Error(\"This project ID already exists in your library\")"
ok  H11               Worker 1/1 @1349836   96B  "if(a.project.id===t.project.id)throw new Error(\"This project ID already exists in your library\")"
ok  H13               CLI    1/1 @197465    28B  "df=e=>{let t=e.fetch??fetch,"
ok  H13               cb     1/1 @597899    25B  "C!==null&&await v.pull(C)"
ok  H13               cb     1/1 @598098    22B  "let N=await v.push(B);"
ok  CLI               cb     1/1 @605113    15B  "p(\"list_media\","
ok  H4.Jt             S      1/1 @1183881  124B  "async function Jt(t,e){if(!(typeof window>\"u\"||typeof indexedDB>\"u\"))try{const n=qj(e);await Ss.updateScoped(Kj(fm(t),n),n)}"
ok  H4.de             S      1/1 @1559585   93B  "function de(){const e=ne.getState().projectId;if(e&&!mv(e)&&De.getState().getProjectById(e)){"
ok  H4.de.save        S      1/1 @1560002   94B  "c=oN(Jt(o,{ownedFields:[\"tracks\",\"timelineItems\"]}),r,\"Failed to save timeline to IndexedDB:\")"
ok  H4.flush          S      1/1 @1558039   85B  "{ownedFields:[\"tracks\",\"timelineItems\"]}),t,\"Failed to flush timeline to IndexedDB:\")"
ok  H4.fre            S      1/1 @1557015   14B  "const fre=300,"
ok  H4.cancel         S      1/1 @1557482   52B  "function Fde(){Or&&(clearTimeout(Or),Or=null),Zo=!1}"
ok  H4.adopt          S      1/1 @1556598   70B  "Rde=t=>{(t.tracks!==void 0||t.timelineItems!==void 0)&&(su=!1),_m(e=>{"
ok  H4.Tm             S      1/1 @1520713   76B  "Tm=t=>ah()||t.timelineLockState!==\"unlocked\"||!!t.projectId&&mv(t.projectId)"
ok  H4.ure            S      1/1 @1555464   50B  "ure=t=>ah()?aN:t.projectId&&mv(t.projectId)?sN:iN;"
ok  H4.rN             S      1/1 @1520790   54B  "rN=(t,e,n)=>{const r=t.projectId;if(!r||!jZ(r))return;"
ok  H4.av             S      1/1 @1182439   38B  "recoveryMode:t.recoveryMode}}const NM="
ok  H4.fm             S      1/1 @1175650   52B  "function fm(t){return{id:t.id,uid:t.uid,name:t.name,"
ok  H4.ho             S      1/1 @1171011   33B  "ho=t=>Math.round(t*10)/10,nx=t=>{"
ok  H4.aspect         S      1/1 @1511545   35B  "Jt(s,{ownedFields:[\"aspectRatio\"]})"
ok  H4.updTimeline    S      1/1 @1194606   32B  "updateProjectTimeline:(r,i,s)=>{"
ok  H5.eV             I      1/1 @1111659   77B  "eV=(e,t,a,n)=>{const s=e.editor.current();if(!s||s.projectId!==t.id)return!1;"
ok  H5.cancel+history I      1/1 @1111825   80B  "e.editor.cancelPendingSave(),e.editor.pushHistory(\"Timeline updated from disk\");"
ok  H5.adopt          I      1/1 @1111968   44B  "return e.editor.adopt({...o,duration:d}),!0}"
ok  H5.W1             I      1/1 @1114463  116B  "editor:{current:()=>Mt.getState(),pushHistory:e=>Mt.getState().pushTimelineHistory(e),adopt:$g,cancelPendingSave:Og,"
ok  H5.JH             I      1/1 @1111262   77B  "if(!s||(s.stateUpdatedAt??0)>=(a.stateUpdatedAt??0))return{outcome:\"ignored\"}"
ok  H5.toast          I      1/1 @1115352   40B  "title:\"Some of your edits were replaced\""
ok  H5.subscribe      I      1/1 @1115555   27B  "a=dt(\"project:changed\",c=>{"
ok  H5.bridge         I      1/1 @1115056   24B  "iV=\"timeline-from-disk\","
ok  H5.coalesce       I      1/1 @1113957   44B  "if(e.loaderBusy(c.id)){a.set(c.id,c);return}"
ok  H5.fV             I      1/1 @1115409   21B  "fV=e=>{const t=cV(e);"
ok  H4.xv             S      1/1 @1555553   45B  "function xv(){const t=ne.getState(),e=ure(t);"
ok  H4.xvClear        S      1/1 @1555786   24B  "(n===iN||n===sN||n===aN)"
ok  H6.toolbar        E      1/1 @1008739   63B  "y=U(_=>_.historyPast.length>0),g=U(_=>_.historyFuture.length>0)"
ok  H6.caption        E      1/1 @668273    49B  "if(i(\"editCaption\"),U.getState().historyPast===u)"
ok  H6.push           S      1/1 @1544531   74B  "pushTimelineHistory:n=>{me()||t({historyPast:Jx(e(),n),historyFuture:[]})}"
ok  H6.Jx             S      1/1 @1518688   62B  "Jx=(t,e)=>{const n=[...t.historyPast,Ky(t,Xy(t.projectId),e)];"
ok  H6.Qx             S      1/1 @1518334   12B  "vd=.4,Qx=50,"
ok  H6.keys           E      1/1 @1038261   29B  "tn(Vt.UNDO,At),tn(Vt.REDO,kt)"
ok  H6.callers        E      2/2 @1009698   19B  "U.getState().undo()"
ok  H6.menu           I      1/1 @1107964   31B  "[\"undo\",\"undo\"],[\"redo\",\"redo\"]"
ok  H7.splitMany      E      1/1 @1010254   42B  "re.splitTimelineItem(J,H,{skipHistory:!0})"
ok  H7.rippleTrim     E      1/1 @990654    48B  "if(O(se.plan.updates,!0),se.kind===\"trim-start\")"
ok  H7.trimPlan       S      1/1 @1163113   71B  "kind:\"trim-end\",itemId:e.id,updates:d,downstreamItemIds:u,rippleDelta:l"
ok  H12.commit        S      1/1 @1262215  136B  ".commitDocument({projectUid:this.options.projectUid,mutationId:e.mutationId,expectedVersion:e.basedOnServerVersion,document:e.document})"
ok  H12.post          S      1/1 @1260738   41B  "fetch(\"/api/sync/document\",{method:\"POST\""
ok  H12.recover       S      1/1 @1293643   25B  "async recoverConflict(e){"
ok  H12.stage         S      1/1 @1521076   22B  "a.stageMutation(()=>o)"
ok  H12.recoveredName DSS    1/1 @2626      46B  "name:`${r?.name||a.name} (recovered conflict)`"
ok  UI.panelList      E      1/1 @350297   111B  "uf=[\"media\",\"layouts\",\"music\",\"captions\",\"voiceover\",\"text\",\"transitions\",\"effects\"].filter(e=>e!==\"voiceover\")"
ok  UI.topSlot        E      1/1 @1073128   89B  "children:[!1,c.jsxs(\"div\",{className:\"flex flex-1 overflow-hidden\",children:[c.jsx(pP,{})"
ok  UI.timeline       E      1/1 @1073360   65B  "\"data-analytics-region\":\"editor-timeline\",children:c.jsx(aZ,{})})"
ok  UI.root           E      1/1 @1072488   22B  "\"data-editor-root\":!0,"
ok  IPC.envelope      styles 1/1 @301276    28B  "r={id:c,channel:a,data:i[0]}"
ok  IPC.library       styles 1/1 @301396    49B  "AT=(a,...i)=>Ag(\"library:call\",{method:a,args:i})"
ok  IPC.event         styles 1/1 @301446    32B  "xT=(a,i)=>Eg()?ks().on(xs.EVENT,"
```
