# Wiring Carton into Cardboard's source

This page is for Cardboard's engineers and their coding agents. It says where Carton goes in Cardboard's own source,
hook by hook: what Cardboard does there today, which Carton call replaces or wraps it, what must stay true, and which
test proves it.

It uses the names of Cardboard's own code: the project store and its `applyMutation`, `writeNow` and `updateScoped`;
the timeline mirror and its `apply`, `applyEdits`, `recordRevision` and `history`; the editor store's save path; and
so on. These are the names of Cardboard 1.4.0, read from the shipped app. Our Windows build makes the same changes by
patching the minified bundles, and [`carton/docs/INTEGRATION-1.4.0.md`](../docs/INTEGRATION-1.4.0.md) maps every hook
below to its exact place there. In your source the changes are simpler: no bridges, no anchors.

Hook numbers H1–H13 are the plan's (§16). Every Carton call on this page is real. The samples under
"[Samples that run](#samples-that-run)" are checked by `kit/test/samples.test.ts`. Snippets that call Cardboard's
own functions use them by role (`projectStore.latest(id)`), and say so.

**Contents:** [The model](#the-model-in-one-minute) · [Opening a
project](#opening-a-project-cartonopen-on-each-platform) · [The hooks](#the-hooks) · [Swapping
backends](#swapping-backends) · [Migration](#migration-of-existing-projects) · [Rolling out](#rolling-it-out-safely) ·
[Samples that run](#samples-that-run)

## The model in one minute

- **One change pipeline.** Every writer goes through `carton.commit({ doc, base, author })`: the app's GUI save, the
  Director, every `cb` process, host agents, and imports. `base` is the exact version the writer read. Carton
  computes the change (base → doc), checks it against what landed since, and either confirms it or rebases it with a
  three-way merge. A clash becomes a **conflict card**, never a silent overwrite.
- **One history per project:** `<bundle>/.carton/carton.db` (SQLite in WAL mode). Its writes are compare-and-swap, so
  two processes can't lose each other's change (B1). In cloud-synced folders, on network shares and on FAT/exFAT it
  lives in app data instead (`locateCartonDb`, L15).
- **The document Carton versions** is a slice of `project.json`'s `project`: `name`, `description`, `aspectRatio`,
  `tracks`, `timelineItems` and the media records' content fields. Everything else (`id`, `stateUpdatedAt`,
  `updatedAt`, `cast`…) stays Cardboard's and never becomes a change. `@carton/cardboard` converts both ways:
  `fromHost(project, base)` and `materializeProject(doc, currentProject)`.
- **Documents are values, and frozen.** The records `head()`, `checkout()` and `resolve()` give you are frozen, with
  their nested values: an edit in place throws a `TypeError`. Replace the record you change (`{ ...clip, endTime: 4 }`)
  in a copy of its array, and commit that. Carton shares unchanged records between versions. Don't change an object
  after you commit it: Carton may keep it, or values in it, and freeze them. (Carton doesn't look inside an object
  that was already frozen, so don't commit a frozen object with values inside it that aren't.)
- **One schema per project.** Every process that opens a project (the app, its library worker, the helper, `cb`)
  must use the same adapter. Carton stores the schema's fingerprint with the project and refuses, at open, a process
  whose schema differs at the same schema version: its states would hash and merge differently.
- **Files are views of head.** Carton writes `project.json` and `timeline.tsx` with **displace-then-install**: it moves
  whatever is at the path aside, then links its new file in. A write Carton didn't make is never overwritten; it is
  imported as an attributed change (`external:project.json`), §6.4.
- **Who is acting** travels as `CARDBOARD_ACTOR`: `person`, `director/<chat>/<turn>[/sub-<type>-<id>]`, `claude/<chat>`,
  `codex/<name>`… Every change records its actor, so History and credits go down to the subagent.
- **Ctrl+Z behaves like the editor's own:** your edits and the agent turns you started in the app, from this session
  only. It never goes back past the session's start and never undoes a terminal's `cb` (those are undone from
  History's "Undo turn" or `cb undo --turn`). A teammate's edits are never in it. `cb undo` and History's Undo see the
  machine's whole actor group (§8).

## Opening a project: `Carton.open` on each platform

```ts
Carton.open({
  adapter,        // HostAdapter: cardboardAdapter, or createCardboardAdapter({ projection }) with the GUI's projection
  store,          // Store: store-sqlite (desktop, CLI), store-idb (web), store-memory (tests)
  hasher,         // optional: nodeHasher (node:crypto); core has a portable SHA-256 otherwise
  actor,          // the default author: an Actor, or an IdentitySource asked per commit
  init,           // only when the store has no project: { doc, asChange: true } (main@1) or { import: shallowExport }
  sync,           // only for shared cuts: { transport, url, token, autoConnect }
});
```

### Desktop: the library worker (Electron utility process)

The library worker owns the project store, the timeline mirror and the bundle watcher, so Carton lives there too.

- **Open** each project on first use with `importProject` (`@carton/store-sqlite`). It finds where `carton.db` goes,
  creates the history on first open (the current document becomes `main@1`), and is safe to call on every open, from
  any process. Pass the same `appDataDir` (Electron's `userData`) from every process: it keys the placement lock.
- **Run the engine on its own thread.** A `node:sqlite` call that waits for another process's lock blocks its thread
  (P3b). `EngineThread.start({ dbPath, factory, config })` (`@carton/local`) runs the engine, the sync-lease holder and
  its control socket on a `worker_thread`, so pings and the worker's main loop never wait on each other (R5-06).
  `cb` processes find it through the lease row in `carton.db`, so Cardboard's control socket needs no Carton method.
- **Write the files through the materializer.** `new Materializer({ bundle, engine, host: cardboardFilesHost, codec })`
  from `@carton/cardboard/node` owns `project.json`, the shared `timeline.tsx`, the per-agent views
  `.scratch/views/<name>.tsx` and their `.status` sidecars. `engine` is `cartonMaterializerEngine(carton)`. `codec` is
  Cardboard's own timeline printer and parser: `{ print(project, rev), parse(text, project) }`. Call `mz.start()` and
  `mz.watch()` once, `mz.onHeadChange("local" | "gui" | "remote")` when head moves, and `mz.onCb()` on every `cb`
  call.
- **Give the adapter the GUI's projection.** The editor saves through a lossy serializer: a field whitelist plus 0.1 s
  rounding (B10). `createCardboardAdapter({ projection })` takes the per-item function, so a GUI save is diffed
  through the same projection and only the person's real edits become changes.

```ts
// Library worker. Cardboard's parts: readProjectJson (role: read and parse project.json), app.getPath, fmsvItem.
import { createCardboardAdapter } from "@carton/cardboard";
import { importProject } from "@carton/store-sqlite";
import { nodeHasher } from "@carton/local";

const adapter = createCardboardAdapter({ projection: fmsvItem });   // the editor's per-item save projection
const { carton, store, location } = await importProject({
  bundleDir, projectId, appDataDir: app.getPath("userData"),
  adapter, hasher: nodeHasher,
  host: () => readProjectJson(bundleDir).project,                   // read only when an import is needed
});
if (location.warning) showWarning(location.warning);               // history is outside the bundle (L15)
```

### CLI: `cb` and `cb mcp`

Each `cb` call opens the project, does one thing and exits. Reads run in the calling process. Writes go to the process
that holds the sync lease (the app's engine thread, or a headless helper `cb` starts when the app is closed and the
cut is shared). For a cut that is only local, `carton.db` itself orders the writes and nothing else is needed.

- **Open** with `openLocal({ projectDir, projectId, actor: identify(), dataDir })` (`@carton/local`). Its `write(op)`
  routes the write and answers the `cb` contract: `confirmed`, `pending` or `conflicts` (§6.2). `dataDir` must be the
  same folder the app passes as `appDataDir` (Electron's `userData`): where a project's history lives outside its
  bundle (synced folders, network shares, FAT), every process must look in the same place. The standalone `carton`
  command takes it as `--data-dir`.
- **Commands.** `register(program, { open, out })` (`@carton/cli-mcp`) adds `cut`, `fold`, `credits`, `restore`,
  `compare`, `conflicts`, `resolve`, `publish`, `activity` and the git aliases to your commander program, and extends
  `history` and `undo` in place (`undo --turn`). `out(json, text)` is your result writer.
- **MCP.** `registerMcp(tool, { z, projectParam, open, result })` adds `timeline_cuts`, `timeline_fold`,
  `timeline_credits` and `timeline_publish`, and Carton-backed `timeline_history` and `undo_timeline`, to your
  `tool(name, description, shape, readOnly, handler)` table. It leaves your `check_timeline` alone by default, because
  H3 already routes it through Carton.
- **Who is acting.** `identify({ declared })` reads `CARDBOARD_ACTOR` first, then Claude Code hook input, then a
  self-declared `--as codex/fix-captions`, then the terminal. `--as` can never claim `director/…`.
- **The standalone build** of the same commands is the `carton` bin (`packages/cli-mcp/src/bin.ts`), which the kit's
  quickstart uses. It also serves `carton mcp` over stdio and the Claude Code hooks (`carton hook pre-tool-use`,
  `carton hook stop`, `carton hook-settings`).

```ts
// cb's program setup. Cardboard's parts: program (its commander program), resolveBundle (role: project id, name or
// path to its bundle folder), writeResult (role: its --json/text printer), userDataDir (role: the app's userData
// folder, the same one the library worker passes as appDataDir).
import { register } from "@carton/cli-mcp";
import { identify, openLocal } from "@carton/local";

register(program, {
  open: async (project, { as }) => ({
    project: await openLocal({ projectDir: resolveBundle(project), dataDir: userDataDir, actor: identify({ declared: as ?? null }) }),
    actor: identify({ declared: as ?? null }),
  }),
  out: (json, text) => writeResult(json, text()),
});
```

### Web: `store-idb` in the browser

The web app keeps its history in IndexedDB. `openIdbStore(projectId)` (`@carton/store-idb`) is the Store; every tab
of the project shares it and hears the others' writes (BroadcastChannel). Only one tab may push a shared cut at a time:
wrap the sync connection in `withPushLock(projectId, fn)` (Web Locks). Browser only: the same calls run in
store-idb's own tests in headless Chromium (`packages/store-idb/test/`).

```ts
// Browser. Cardboard's parts: currentProjectDoc (role: the editor's project record), sessionToken (role: your auth).
import { Carton } from "@carton/core";
import { cardboardAdapter, fromHost } from "@carton/cardboard";
import { webSocketTransport } from "@carton/server-node/transport";   // the WebSocket API alone: no Node code
import { openIdbStore, withPushLock } from "@carton/store-idb";

const store = await openIdbStore(projectId);
const carton = await Carton.open({
  adapter: cardboardAdapter, store,
  init: { doc: fromHost(currentProjectDoc, null), asChange: true },  // used only the first time
  sync: { transport: webSocketTransport(), url: `wss://${host}/api/projects/${projectId}/ws`, token: sessionToken, autoConnect: false },
});
void withPushLock(projectId, async () => {              // one pushing tab per project; the others wait their turn
  await carton.sync!.connect();
  await new Promise(() => {});                           // hold the lock while this tab lives
});
```

## The hooks

Each hook: what Cardboard does there today, what Carton changes, what must stay true, and how to prove it. "Proof"
names the conformance tests that pin the behaviour Carton gives the hook (run them with
[CONFORMANCE.md](CONFORMANCE.md)) and the integration test to write in your repo. Our own versions of those
integration tests, against the shipped 1.4.0 bundles, are in `scripts/carton/test/`.

### H1 · The project store: one change per mutation

**Today.** The project store serializes a project's mutations (`chain`). `applyMutation(id, mutate)` applies one to
`latest()`, which re-reads the disk when the file's stamp changed. Writes are coalesced (`enqueue`), and `writeNow`
renames a temp file over `project.json`. `updateScoped(doc, scope)` overlays `scope.ownedFields`, so a GUI save
replaces the whole `tracks` and `timelineItems` arrays (B3). There is no lock and no compare-and-swap across processes
(B1).

**With Carton.**
- In `applyMutation`, keep the document the mutation was applied to: it is the exact **base**. If the mutation changed
  anything, commit before the write is queued, through `@carton/local`'s write path, the same one `cb` uses:
  `lc.write({ kind: "commit", doc: fromHost(next, baseDoc), base: baseRef }, { actor })`. `base` is the `StateRef`
  Carton gave you for that document (or a printed header).
- If head moved meanwhile, Carton rebases. A clash keeps head's value and becomes a card, and **the rest of the save
  still lands**: the result is `{ status: "conflicts", landed: "confirmed", conflicts }`. The cards are stored for
  their author in the same atomic write as the change, where `cb conflicts`, the Stop hook and the History panel find
  them. Then keep the merged head as the mutation's result (`byId`), so the next mutation and the queued write both
  start from it.
- Calling `carton.commit` directly is lower level: without `choices`, a clash returns `conflicts` and **saves
  nothing**, not even the edits that didn't clash, and nothing keeps the cards. If you call it directly, pass
  `choices: () => "ours"` (keep head's value per card, land the rest) and `cardsWrite(cards, change)` (store the cards
  in the same batch), as `@carton/local`'s `runWrite` does. Commit with a stable `id`, so a retry never lands twice.
- Fields Carton doesn't version (timestamps, thumbnails) are written as before.
- `writeNow`'s rename becomes **displace-then-install**: rename what is at `project.json` into `.carton/displaced/`,
  then `link(tmp, project.json)`. `EEXIST` means a foreign write landed in between: displace it too and loop. Then
  `unlink(tmp)`. `displaceThenInstall(target, tmp, nextSlot, { noLinks })` (`@carton/cardboard/node`) does this. The
  materializer does it for you when it writes `project.json` (`writeProject: true`).
- A displaced file Carton didn't write is imported as an `external:project.json` change, never deleted.
- Two processes install one bundle's files one at a time, in commit order: never install a version that is no longer
  head.
- If a commit fails (a bug, a full disk), the write still happens as before and the failure is logged. The next
  commit imports that file as an outside change. Carton must never stop a person from saving.

**Invariants.**
- Each mutation is its own change, with its own actor and its exact base, even when file writes coalesce.
- A stale base is rebased, never applied as a two-way diff against the newest document.
- No write Carton didn't make is ever overwritten or deleted. It is imported, attributed, or kept and reported.
- With Carton off, the bytes written equal today's.

**Proof.**
- Conformance: engine `B1 lost update`, `B3 GUI save of the whole doc`, `B5`, `B12`, `B13`; system `G1` (`g1-gui.ts`),
  `R7-01`, `Displacement`, `in-place writer` (`r7-r8-shared-file.ts`); the store suite's CAS cases; the race harness
  `carton/bench/race` (P10).
- Your integration test: four concurrent `cb source apply` on different clips keep all four edits; a GUI save during
  an agent's apply keeps both; a GUI save of a stale array doesn't revert an agent's clip; with Carton off, the bytes
  equal the old ones.

### H1b · Other writers of `project.json`

**Today.** The CLI's cloud pull writes `project.json` with its atomic-write helper. Open Project (bundle or `.cbproj`)
writes it into a staging folder, then renames the folder into the library.

**With Carton.** A cloud pull goes through sync instead (H13). An opened project's document becomes its first
version, `main@1` (see [Migration](#migration-of-existing-projects)).

**Invariant.** Nothing writes `project.json` around Carton while it is on. A writer that does anyway is a foreign
writer: displaced and imported (H1).

**Proof.** Store suite and `importProject`'s process-race tests (`packages/store-sqlite/test/import.test.ts`: main@1
is recorded once, even when several processes open a new project at the same moment).

### H2 · Revisions, history and undo

**Today.** The timeline mirror's `recordRevision` keeps the newest 20 slices in `.revs/`. `listRevisions` and
`readRevision` read them. `history(id)` lists them, and `undo(id, rev?)` writes an older slice as a new revision.
These back `cb history`, `cb undo`, MCP `timeline_history` and `undo_timeline` (B6: 20 snapshots, 50 undo steps in
memory).

**With Carton.**
- `listRevisions` and `readRevision` read Carton's versions first, in the same `{ rev, at, doc }` shape:
  `carton.log({ cut, limit })` and `carton.checkout(ref)`. Older `.revs` files follow. Every caller then gets unlimited
  history unchanged.
- `history` adds who made each version and on which cut (the `Version.author` and its cut).
- `undo(id, rev)` becomes `carton.restore(ref)`: the old state, saved as a new version.
- `undo --turn <turn>` reverts every change of one agent turn as one inverse change at head (`write({ kind: "undoTurn",
  turn })`, or `cb undo --turn`). What someone else changed again since keeps their newer value: each such path becomes
  a card for the actor who asked for the undo (status `conflicts`, stored like a save's cards, so `cb conflicts` lists
  them), and the rest of the turn is undone. A card's `theirs` is the value from before the turn, so picking it finishes
  the undo there.
- Keep `recordRevision` writing `.revs` while you roll out, so switching Carton off loses nothing.
- Name versions after the user's words: when a Director turn ends, `nameTurn(carton, { chat, turn }, label)`
  (`@carton/cardboard`) names its last version ("Make the intro tighter"). The label goes into the project's history
  only, never into a log.

**Invariants.**
- Every state that was ever confirmed can be rebuilt exactly; a ref that can't is an error (`StateUnknown`), never a
  guess.
- An undo is a new change, never a rewrite of history.
- An agent turn undoes as one change, and never reverts a later edit by someone else.

**Proof.** Engine `B6`, `B7`; system `R2-08 external cb then ⌘Z` (`r2-08-undo.ts`); the cardboard suite's `wording.ts`
(History in Cardboard's words, turn names); cli-mcp's `test/carton.test.ts` (undo by actor group, `undo --turn` as
one change).

### H3 · Timeline apply and print (`timeline.tsx`, MCP `apply_timeline`)

**Today.** `apply(id, source, { prefer, dryRun })` parses `timeline.tsx`. The base is the `.revs` slice at or before
the file's `// cardboard:rev` header, and **falls back to the current document when that slice was pruned (B2: a silent
revert)**. It merges three ways with item-level conflicts, replacing whole nested values (B4), and writes through
`writeTimeline` → `updateScoped`. `applyEdits` does the same for MCP's `{ oldText, newText }` edits at a `rev`.

**With Carton.**
- **Print** pins the state it prints: `carton.pin({ owner, by })` returns `{ ref, header }`, where `owner` is what
  holds the pin (a turn, a view, an MCP ref) and `by` who printed it. The header goes into the file:
  `// cardboard:rev Main cut@57~3f9a1c0e b:<cut8> p:<nonce> by <actor>`. Release the pin when the turn ends
  (`carton.release(ref, owner)`). 1.4.0's numeric revs keep working through a map from rev to ref.
- **Apply** commits on exactly the version the header names: `carton.commit({ doc, base: header, author })`. A header
  Carton can't rebuild throws `StateUnknown` ("This timeline was printed from a version that's no longer available.
  Print it again and redo the edit.") A file with no header keeps today's meaning: edits on top of head.
- The merge is Carton's `merge3` with the Cardboard schema: field by field, nested values per key, a clip's time fields
  decided together (B13), recorded ripples applied as intents. Its result keeps today's `{ ops, conflicts }` shape, so
  `cb`'s printer and MCP's results don't change. `--prefer file` keeps the file's side and records a card;
  `--prefer editor` keeps head's.
- The apply's result adds `carton: { status, ref }`: `confirmed`, `pending` or `conflicts`.
- **Per-agent views** replace the shared file for agents: `cb source print --view` prints `.scratch/views/<name>.tsx`,
  which only its owner edits, and Carton applies every save of it live and writes `<name>.status` (`confirmed`,
  `pending`, `conflicts`, `rejected` or `error`). The base of each save is that view's last applied save, so nothing is
  merged twice (R4-02). The materializer does all of this.
- A stock `cb` that doesn't know Carton must not be left able to apply a Carton-headered file. It would parse no rev
  and two-way merge. Route `apply` through Carton in every copy of the mirror (CLI and worker), and MCP's
  `apply_timeline` too.

**Invariants.**
- Principle 9: a ref that can't be reconstructed is an error, never a two-way merge.
- An edit is applied once, even when it is re-sent or rebased.
- The header contract stays: `// cardboard:rev` on its own line, regenerated after every applied save.

**Proof.** Engine `B2 pruned base`, `B4 nested values`, `B13`; system `R1-01 four-step`, `§5.2 expired ref`,
`R4-02` (`r4-02-view-base.ts`), `R4-03` (`r4-03-edit-loop.ts`), `R5-04` (`r5-04-status.ts`), `R3-01 ripple-once`;
the cardboard suite's `real-codec.ts` (Cardboard's own printer and parser under Carton's header) and its CLI-made
fixtures.

### H4 · The GUI save

**Today.** The editor store arms a 300 ms timer on every timeline change. The timer copies the editor timeline into the
project record and calls `updateProjectScoped(project, { ownedFields: ["tracks", "timelineItems"] })`, which
serializes through the lossy whitelist-and-round projection and sends `project:patch { document, scope }` to main. The
renderer has no usable base: `stateUpdatedAt` moves with every local edit.

**With Carton.**
- The editor store gets `cartonBase`: the version the editor shows. Set it at load and in the same store step as every
  adopt (H5). On a save's acknowledgement, move it to the saved version, but only if it still equals the base the save
  sent.
- The save carries `carton: { base, actor: "person", intents, group }`. `intents` are the ripples recorded since the
  last save (H7); `group` is the person's undo group.
- The worker diffs the owned fields through the GUI projection against the version `base` names:
  `projectGuiSave(baseDoc, guiDoc, projection)`. A GUI save then carries only the person's edits (B3, B10).
- **Read-only preview.** Compare and the A/B toggle load an earlier version with `carton.preview(ref)` (read-only).
  While previewing, the editor's "editing blocked" check refuses every edit, with "Previewing an earlier version.
  Return to current to edit." The 300 ms timer doesn't arm.

**Invariants.**
- A GUI save never reverts what it didn't change, even with 0.1 s rounding and the whitelist.
- The save is built in the same tick that reads `cartonBase`, so no adopt can slip in between.

**Proof.** Engine `B3`, `B10/S6` (with Cardboard's real projection, see [CONFORMANCE.md](CONFORMANCE.md)); system
`G1` (`g1-gui.ts`). Your integration test: our `scripts/carton/test/renderer-bridge.test.js` covers the same points on
1.4.0's pages ("a timeline save names the version the editor shows", "a preview is read-only").

### H5 · Adopting changes from elsewhere

**Today.** On `project:changed`, the renderer re-reads the project, cancels the pending save, pushes "Timeline updated
from disk" onto undo, and adopts the timeline. A clock check drops an event older than the local record, which silently
ignores a CLI write whenever the person edited after it, and the next GUI save then overwrites it. Then the toast "Some
of your edits were replaced" (B11).

**With Carton.**
- Listen to `carton.on(e => …)`: `{ type: "change", local: false }` for others' changes, `absorbed` for a pending edit
  that turned out to be there already, and `notice` for late conflicts. On a shared cut, `sync-error` says why the
  host refused or couldn't be reached (`error.code`: `update-server`, `unauthorized`, `unreachable`, `unknown-cut`,
  `too-large` or `server`); a later welcome or ack clears it (`error: null`). `carton.sync?.error(cutId)` reads it
  (no id: the current cut). `carton.sync` is `null` when the project was opened without `sync`.
- The echo of the page's own save only moves `cartonBase`.
- Otherwise, if a save is armed, send it first, with its base. The worker rebases the person's edits on head: on a
  clash head's value stays and the edit becomes a card. A coupled field group (a clip's times) is decided as one unit,
  so a remote trim is never half-reverted.
- Then adopt head **once**, setting `cartonBase` in the same raw store call. No `pushHistory`, no
  `cancelPendingSave`, no toast. The person's cards show in the History panel.

**Invariant (G1).** A change from elsewhere is never re-committed under the person's name, and no local edit is
dropped without a card.

**Proof.** System `G1 logic: 3 remote writers × 1/s × 10 min` and its two controls (`g1-gui.ts`), `H2`
(`v14-holes.ts`). Your integration test: "a change from elsewhere: the armed save goes first, then head and its base in
one adopt, no undo entry" (`scripts/carton/test/renderer-bridge.test.js`). On the real app: gate G1 (3 remote writers
at 1/s for 10 minutes).

### H6 · Undo and redo

**Today.** `pushTimelineHistory(label)` pushes a whole-timeline snapshot (50 kept). `undo` and `redo` swap snapshots.
Ctrl+Z, the toolbar and Edit › Undo all end there.

**With Carton.** `undo()` sends the pending save first, then `carton.undo(group, { app: true, since })`: the inverse
of the newest change of the person's actor group that was made from the app (`Actor.app`: the person at the editor, or
an agent the app started, which main names in `CARDBOARD_ACTOR`) since the editor's session began (`since`, set when
the editor opens the project), saved at head. A terminal's `cb` is in the machine's group but never `app`, so Ctrl+Z
skips it, as it never goes back past the session. `redo()` is `carton.redo(group, { app: true, since })`: a revert of
the newest undo, re-applying exactly what it took back as a new change; a newer edit in that scope clears it. The
answer carries the project the worker wrote, which the editor adopts at once, and what is left to undo and redo, which
the undo and redo buttons show (`cartonCanUndo`, `cartonCanRedo` in place of the snapshot stacks' lengths). An undo
whose inverse clashes with a later change changes nothing: its cards go to the person's conflict stack, each saying
why. Keep the snapshot push: the caption editor detects a push by the identity of `historyPast`. Without history for a
project, today's undo runs.

**Invariant (C10).** Ctrl+Z undoes the person's own edits and the agent turns they started in the app, in this session
only; never a terminal's `cb`, never a teammate's, never past the session's start. Redo re-applies what the last undo
took back until the next edit.

**Proof.** `scripts/carton/test/sync/undo.test.js` (the real worker: scope, redo, the clash card); store-memory's
`undo-scope.test.ts` and local's `undo-app.test.ts`. (System `R2-08` in `r2-08-undo.ts` still models the rule this
replaces, where ⌘Z took an external `cb` agent's edit; its owner updates it.)

### H7 · Ripple, split, remove silences, ripple trim

**Today.** These store actions shift or cut clips with pure operations between the history push and the state write.

**With Carton.** Each records its intent, and the next save passes it as `commit({ …, intent })`. An `Intent` is
`{ kind, maps, lineage }`: `maps` holds one remap chain per track (`{ [trackId]: chain }`), built with core's helpers,
and `lineage` maps a cut-up clip's old id to its pieces' ids.

```ts
import { rippleDelete, rippleInsert, step } from "@carton/core";

// ripple delete of [start, end) on track t: later clips on t pull left
const ripple = { kind: "ripple-delete", maps: { [t]: rippleDelete(start, end - start) } };
// delete all gaps on t (gapsOnT: [start, end][]): one step that removes every gap at once
const gaps = { kind: "delete-gaps", maps: { [t]: [step(gapsOnT)] } };
// split: record which pieces the old clip became (see the note below)
const split = { kind: "split", lineage: { [clipId]: [leftId, rightId] } };
// remove silences: the removed spans, and the old clip's pieces
const silences = { kind: "remove-silences", maps: { [t]: [step(silent)] }, lineage: { [clipId]: pieceIds } };
// ripple trim of a clip's end from e to e2: rippleDelete(e2, e - e2) when it shortens, rippleInsert(e, e2 - e) when it
// lengthens
```

A concurrent edit is then mapped through the intent once, not guessed: an agent's trim of a later clip, made before the
ripple, lands on the moved clip. Record lineage too. When a commit is rebased over a split (on a local cut, a shared
cut's queue, or a shared cut's commit made on an older version), a split over an edit, or a cut folded into one that
split the clip, an edit made on the old clip also reaches the other pieces, a move to another track included. A retime
of a clip the other side split (its time fields: `startTime`, `endTime`, `trimStart`, `trimEnd`, `playbackSpeed`) is a
conflict card instead, by design. Merges and `.cbproj` links made before this lineage was recorded carry none
([LIMITS.md](LIMITS.md)). Save several
intents of one save as one (a later one composes after the earlier, `composeMaps`). A commit with an `intent` skips
inference; without one, Carton infers a ripple only when it is unambiguous (`inferRipple`, L9).

**Invariant.** A ripple is applied exactly once, however often it is rebased or re-sent.

**Proof.** Engine remap tests and `TP1` (fuzz); system `R3-01 ripple-once` (both suites), `R4-02 ripple …`,
`P9/S2` (`p9-contention.ts`).

### H8 · The library worker: watcher, engine thread, RPC

**Today.** The worker watches the library and each bundle (150 ms debounce). A `project.json` it didn't write is
re-read and announced as `changed`. A `timeline.tsx` it didn't write goes through `mirror.apply`. Its RPC table is
built from a list of namespaces.

**With Carton.**
- Start `EngineThread.start({ dbPath, factory, config })` per open project, and the materializer (`mz.start()`,
  `mz.watch()`): it applies per-agent view saves live and writes their `.status`. Give it to the lease holder's engine
  (`materializer`), so `cb`'s `printView` and `hook` writes reach it.
- **Per-agent views.** `cb source print <project> --view <name>` (cli-mcp's `register` adds `--view` to Cardboard's
  `source print`; without it, Cardboard's own command runs) prints `.scratch/views/<name>.tsx` and answers its path and
  its `.status` file. A hooked agent's view is named after the agent, whatever name it asks for. With no materializer
  running (the app closed) it answers "views need the app open".
- **The freeze.** While an agent's turn runs, the shared `timeline.tsx` doesn't move under it: the agent's Read of the
  file, or its `cb` call, starts the freeze (`mz.hookRead(actor)`), and its Stop lets go (`mz.hookStop(actor)`: a
  subagent's Stop releases only what it pinned; the turn's Stop releases the whole turn's). Once no agent holds the
  file, the person's and remote teammates' changes reach it; the app always shows head. Local agents' saves still go
  into the frozen file, each merged on its own base, and so do their confirmed `cb` changes; on a shared cut, only those
  of agents hooked here (cardboard-adapter's head; not yet in the snapshot the kit runs on). **Read-your-writes:** a
  `cb` write that changed the timeline asks the holder to show it before it answers (`carton.shown`, `showOnHolder`;
  the holder's engine `show`, the materializer's `showChange`), so an agent reading `timeline.tsx` next sees its own
  change; the answer (`shown`, `held`, `elsewhere`, `later`) goes into the write's result. A plain `cb source print`
  and a cut switch reprint it from head. A save that repeats an edit the file hides, or whose check for that reads more
  than its limit of changes or fails, restarts the freeze from that save's state; a `cb` change restarts it from that
  change's state when merging it wouldn't add exactly its edits (it repeats, overwrites or builds on an edit the file
  hides). Each can show newer edits before the Stop. Claude Code sends no Stop when the user interrupts a turn, so a
  hooked agent quiet for 60 s (`freezeIdleMs`) no longer holds the file; its next hook event holds it again.
- **Hook events reach the holder as a write:** `lc.write({ kind: "hook", event: "read" | "write" | "stop", file },
  { actor })` (`file`: project-relative, for `write` only). The holder calls its materializer's `hookRead`,
  `hookWrite` or `hookStop`. The answer is `confirmed`, with `hook: { event, delivered }` (`delivered: false` when no
  materializer runs); a hook never fails the turn. A process that only sends hook events can use
  `@carton/local/hook-send` (no engine; `carton.db` read only).
- Add a `carton` RPC namespace (head, checkout, undo, redo, notices, the History panel's calls) that main forwards
  from a `carton:call` IPC channel.
- A commit that merged someone else's change is announced as `changed`, so the pages adopt it (H5).
- A `timeline.tsx` save the watcher applies is credited `external:timeline.tsx`, or to the agent that announced it
  (`mz.hookWrite(actor, rel)` from the PreToolUse hook on Write, Edit and MultiEdit).

**Invariants.** A ping or a lock wait never waits on the worker's main loop (P3b). Only the lease holder pushes a shared
cut, and a holder that was replaced stops before it pushes again (fencing).

**Proof.** System `R4-04 helper` (`r4-04-helper.ts`), `R5-06 fencing` (`r5-06-fencing.ts`), `R5-05`
(`r5-05-rewrite-spacing.ts`); the local suite (`leaseSuite`); `@carton/local`'s own process tests.

### H9 · Agents: who is acting, and conflicts after a turn

**Today.** Host agents are spawned per chat with the bundle as their working directory. Host Claude Code runs with
`--append-system-prompt`. The in-process Director has a `PreToolUse` hook on Bash (the credit gate). The prompt says to
edit `timeline.tsx` or use `cb source apply`.

**With Carton.**
- Every agent process gets `CARDBOARD_ACTOR` in its environment: `director/<chat>`, `claude/<chat>`, `codex/<chat>`…
- The Director's `PreToolUse` hook adds the turn and, inside a subagent, `/sub-<agent_type>-<agent_id>` (Claude Code
  puts both in the hook input): `prefixCommand(input, { chat, turn })` and `preToolUseOutput(...)` from
  `@carton/local/hooks` (a light entry with no engine and no SQLite). It composes with the credit gate's rewrite.
- `Stop` and `SubagentStop` hooks read that actor's notices and block once per conflict set with the conflict text,
  and never again while `stop_hook_active` is set: `new StoreNoticeBox(store).run(actorIdForHook(input, turn), b =>
  stopHook(input, b, turn))`. Cards an agent leaves unresolved go to the person.
- Host Claude Code gets the same hooks through `--settings`: `hookSettings({ command, projectDir })` builds the JSON:
  PreToolUse on `Bash` (the prefix) and on `Read|Write|Edit|MultiEdit` (the freeze and credits of H8), Stop and
  SubagentStop. The matcher starts the hook on every such call, any file. To start it only for the project's files, add
  Claude Code's `if` condition to each hook, one per tool and file (`Read(**/timeline.tsx)`, `Write(**/timeline.tsx)`,
  `Edit(**/project.json)`…), as our Windows build does ([LIMITS.md](LIMITS.md)).
- Agents may not edit `project.json`: the PreToolUse hook (`preToolUse` from `@carton/local/hooks`) refuses a Write,
  Edit or MultiEdit of it (`permissionDecision: "deny"`), with a reason that points to `cb source print --view`.
- The system prompt names the per-agent view flow (`cb source print --view`) and the skill in [SKILL.md](SKILL.md).
- When a turn ends, name its version (`nameTurn`, H2).

**Invariants.**
- Attribution goes down to the subagent; an agent can never claim `director/…` by itself.
- Conflicts that turn up after a turn reach that agent once, then the person.

**Proof.** System `R2-02` (statuses, late conflict, Stop hook: `r2-02-cb-status.ts`), `R2-03 two parallel subagents ×
three dependent edits` (`r2-03-subagents.ts`); the local suite (`identitySuite`); cli-mcp's `test/bin.test.ts` (the
hooks as separate processes). Claude Code's `updatedInput` without a permission decision was checked once, on Claude
Code 2.1.314 (see `@carton/local`'s `hooks.ts`).

### H10 · Media: ingest and `cardboard-media://`

**Today.** Ingest copies or references a file and gives it a random id. Main serves `cardboard-media://` with range
support.

**With Carton** (shared projects only; nothing changes for local ones). The calls are `@carton/media`'s; `hashFile` and
`startRangeServer` come from `@carton/media/node`.
- Media get a content id: SHA-256 over 1 MiB leaves (`mediaHash`, `hashFile` in a worker thread). Hashing is lazy:
  `HashScheduler` hashes only what a share needs, and pauses during playback and export.
- `uploadMedia` sends the tiers the project needs (records, then previews, then the proxy, originals only when asked)
  through any BlobStore, resumably.
- A teammate plays first and verifies after: `MediaReader` serves bytes as they arrive and checks each leaf.
  `serveMedia(reader, hash, request)` answers `protocol.handle("cardboard-media", …)` with ranges.
  `startRangeServer({ source: reader.toolSource() })` serves verified bytes to ffmpeg-based tools on 127.0.0.1.
- Collab proxies: Cardboard's own proxy when it fits, else NVENC → QSV → AMF → libx264 (`encodeProxy`).
  `shareMedia` (`@carton/media/node`) shares it as a segmented stream: a teammate plays the segments while the upload
  runs. `proxyStreams: false` keeps the older whole-object proxy.

**Invariants.** Footage stays local unless shared (C8). A leaf that doesn't match its hash is never served as verified.

**Proof.** The media suites: `hasherSuite`, `mediaStoreSuite`, `browserParitySuite` (the same ids in Chromium and
Node), `proxyEncoderSuite` (GPU encoders need an NVIDIA, Intel or AMD GPU and are skipped without one).

### H11 · `.cbproj`

**Today.** Save As writes a stored zip of the bundle minus a set of top-level names (`cache`, `converted`, `proxies`,
`.revs`). The walk compares only top-level names. Open Project refuses a project id already in the library ("This
project ID already exists in your library", C9).

**With Carton.**
- **Export.** Leave out `.carton/` and the view files Carton wrote in `.scratch/views/`: a `<view>.tsx` whose `//
  cardboard:rev` line is Carton's (`Main cut@3~5e1f0c2a b:…`; 1.4.0's is a bare number) and a `<view>.status` in the
  materializer's format. A person's or an agent's own files there travel, as in 1.4.0. The rule is
  `excludedFromExport(path, foldCase, content)` (`cartonViewFile`; `walkBundle` reads each candidate's head for you);
  with no content, a name Carton could have written is left out. These apply even with Carton off: `.carton/` holds
  local paths and device pins. Write the shallow export as its own entry, with the version it ends at as the file's
  `project.json`: `const shallow = await carton.exportShallow()`, then `exportCbproj({ bundle, out, shallow, head: {
  doc: await carton.checkout(shallow.head), toProject: materializeProject } })`. The opt-in "Include history" adds
  `history.db` (`fullHistory: (to) => store.exportCopy(to, [...LOCAL_TABLES])`, with `LOCAL_TABLES` from
  `@carton/core`).
- **What an export holds.** Its history ends at a confirmed version: edits still waiting for a shared cut's server
  aren't in it. `exportCbproj` writes whatever `head.doc` you give it, so give it that version
  (`checkout(shallow.head)`), not `head()`, which includes waiting edits. `carton.pendingCount(cut)` says how many there
  are, whichever process made them (it reads the store, so `cb`'s handle, which has no sync, sees the app's); wait for
  0, or export the confirmed head. Before each write (an export included), a handle reads the export records other
  processes wrote since it last looked, so the app's next `.cbproj` knows a version `cb` exported meanwhile; `head()`
  and reads don't.
- **Open a project you don't have:** `Carton.open({ …, init: { import: contents.shallow } })`. Their cuts arrive
  read-only, and a cut of your own starts from their head.
- **Open a project you have:** instead of the error, offer "Bring in their changes":
  `bringInTheirChanges(carton, await readCbproj(file), { check })`. It folds their head into your cut, with cards.
  No shared lineage forks a new project id; a missing common state shows the explicit dialog (§13), never an older
  base.
- **A file with "Include history"** (`readCbproj(file).hasFullHistory`): `extractFullHistory(file, toPath)` writes its
  history to a file of your own. Open that with `openSqliteStore(toPath)` and call `carton.importHistory(store)`. The
  sender's cuts arrive as read-only cuts with their versions, authors and names. History from another project is
  refused, and so is history made with another schema at the same schema version. Or let "Bring in their changes" do it:
  `bringInTheirChanges(carton, contents, { history: { file, openStore } })` (with `openStore: (p) => openSqliteStore(p,
  { readOnly: true })`) imports it, except with `check`.
- View files and Carton's database in a received file are never applied or unpacked (`readCbproj` lists them as
  `ignored`).

**Invariants.** A `.cbproj` never contains `.carton/` or a view file Carton wrote. A round trip, twice, then a third
fold finds the right common version and reverts nothing.

**Proof.** The cardboard suite's `cbproj.ts` (Alice → Bob → Alice twice, then a third fold; ignored entries; the
full-history entry; a person's files in `.scratch/views/` travel, Carton's don't); engine `cbproj` tests (shallow
export). Your integration test: open the zip and assert there is no `.carton/` entry and no view file Carton wrote.

### H12 · Web `DocumentSyncService`

**Today** (dormant on desktop). An IndexedDB outbox commits whole documents: `POST /api/sync/document { projectUid,
mutationId, expectedVersion, document }`. On a version conflict it keeps a local copy named "… (recovered conflict)"
and takes the server's (B9).

**With Carton.** The outbox becomes Carton's pending queue on `store-idb`, and the POST becomes a push of changes with
their base over the WebSocket (`Carton.open({ sync })`, see [Web](#web-store-idb-in-the-browser)). A conflicting push
is rebased and confirmed on the one cut, with cards where edits clash. No "(recovered conflict)" copies.

**Invariant.** One project, one history: a conflict never forks a copy.

**Proof.** Engine `B9`; system `shared-cuts.ts`, `chaos.ts` (loss, outages, jitter: converged, exactly once),
`v11-server.ts`, `envelope.ts` (a 33 MiB change through a 32 MiB transport). The host suites (`sequencerHostSuite`,
`liveSyncSuite`) on your host.

### H13 · The CLI's cloud mode

**Today** (`CARDBOARD_CLOUD_PROJECTS=1`). The CLI PUTs the whole `project.json` with `ifVersion`, and fails with a
conflict error on a 412. `cb mcp` pulls before each tool call and pushes after.

**With Carton.** Headless sync replaces the whole-file PUT: the pull is catching up confirmed changes, and the push is
the pending queue. When the app is closed, `cb` starts a helper that holds the sync lease and pushes
(`@carton/local`'s helper); `cb` writes then answer `pending` until the server confirms (it waits up to 5 s, L14).

**Invariant.** A `cb` write is pushed exactly once, even when its helper dies mid-call (stable change ids).

**Proof.** System `R4-04 helper`, `R3-03 handoff` (`r3-03-handoff.ts`), `R2-02` (statuses), `v11 reconnect`.

### People and presence on shared projects

**Today.** A GUI save has no author. With Carton it is the generic person, `{ kind: "human", id: "person" }`, on every
computer, so in a shared project every teammate's GUI edits would read as "You".

**With Carton.**
- When a person shares or joins, call `carton.setIdentity({ id, name })`: `id` is their sync session's account, and
  `name` what teammates see. It is kept in the store and sent to the host. `carton.identity()` reads it back.
- `log()` and `credits()` then tell a change by the generic person as the person behind the device that made it, and
  keep the actor as recorded in `authoredAs`. A teammate's devices are told by the host. Agents, subagents and named
  humans are never resolved. Hashes and history don't change.
- Pass the person as the History panel's `me` (`{ kind: "human", ...carton.identity(), group }`), so their own edits
  show as "You". A `people` event says authors may read differently: read the history again.
- Presence goes out as the resolved person. When a connection closes, the host tells the others that its people left,
  and the client drops the presence it was showing from others.
- A watch link (a reader scoped to a Published cut) gets no people from the host: there, every GUI edit shows as the
  generic person ([LIMITS.md](LIMITS.md)).

**Proof.** `store-memory/test/people.test.ts` (this store's person in log and credits, agents as recorded, a restart);
`kit/test/samples.test.ts` "People"; the quickstart's `live.ts` (Bob's GUI edit, as "person", reads "Bob" at Alice's).

### UI · The History panel and conflict cards

`@carton/react` has headless hooks and unstyled components that work under React and `preact/compat`: History,
cuts, fold in (all, some, none), Compare, credits, the preview banner and conflict cards. They read one view model, a
`CartonUi`, which you give to `<CartonProvider ui={ui}>`:
- **In the browser**, over the Carton handle itself: `const ui = fromCarton(carton, { me })`.
- **In the desktop app**, Carton lives in the library worker and the panel in the page, so the view model travels as
  messages. In the worker: `const ui = fromCarton(carton, { me })` and `const server = serveUi(ui, send)`, which
  returns `{ receive, close }`. In the page: `const page = remoteUi(send)`, which returns `{ ui, receive, ready }`.
  Each side's `send` posts to the other side's `receive` over your IPC; await `page.ready` before the first render.
  When the panel goes away, call `server.close()` and `ui.dispose()`: the view model listens to Carton and runs a
  timer until it is disposed.

Load the panel only when it first shows, and subscribe only while it shows. `kit/test/ui.test.ts` runs this wiring
with structured clones delivered later, as IPC does. See `packages/react/README.md`.

## Swapping backends

Carton names no cloud. Every outside service sits behind an interface in `@carton/core/plugins`, and a replacement is
accepted when it passes the same conformance suite. Nothing else in Carton changes.

| What | Interface | Ships as | To use your own |
|---|---|---|---|
| Where shared cuts are ordered | `SequencerHost` + `SequencerStorage` | `@carton/server-cloudflare` (a Durable Object per project), `@carton/server-node` (node:sqlite) | Run `createSequencer` from `@carton/server` inside your API |
| Media, keyframes, archived changes | `BlobStore` | `blob-r2` (in server-cloudflare), `@carton/blob-s3` (S3, R2, GCS interop, MinIO, B2), `@carton/blob-fs`, `@carton/blob-memory` | Implement `BlobStore`, or point blob-s3 at GCS |
| Accounts and tokens | `AuthProvider` | the demo HMAC invites (`createHmacAuth`) | Implement `verify(token)` over your accounts |
| Client ↔ host messages | `Transport` | WebSocket (`webSocketTransport`), in-process | Long-poll, WebRTC… |
| History on the client | `Store` | store-sqlite, store-idb, store-memory | |

How to write and test a host or a blob store is in [`carton/docs/plugins.md`](../docs/plugins.md). The short version:

**The Node host, with S3-compatible storage** (AWS S3, R2's S3 API, GCS interoperability, MinIO, B2):

```ts
import { startNodeHost } from "@carton/server-node";
import { createHmacAuth } from "@carton/server";
import { createS3BlobStore } from "@carton/blob-s3";

const secret = process.env.CARTON_SECRET!;                 // at least 32 random bytes; from the environment
const host = await startNodeHost({
  dataDir: "/var/lib/carton", auth: createHmacAuth({ secret }), secret,
  blobs: createS3BlobStore({
    endpoint: process.env.S3_ENDPOINT!, bucket: "carton", region: "auto",
    accessKeyId: process.env.S3_KEY!, secretAccessKey: process.env.S3_SECRET!,
  }),
  adminToken: process.env.CARTON_ADMIN_TOKEN, port: 8787,
});
```

Swap `createS3BlobStore(...)` for `createFsBlobStore({ root })` to keep everything on disk (the quickstart does).
blob-s3 passes the blob suite against a strict SigV4 S3 server (VersityGW); it has not been run against AWS, R2 or GCS
themselves.

**Cloudflare.** `@carton/server-cloudflare` is a Worker plus one `ProjectRoom` Durable Object per project, on DO
SQLite, with R2 bound as `BLOBS` (remove the binding to fall back to DO-stored blobs, L11). Its `wrangler.toml` and
`.dev.vars.example` are in `packages/server-cloudflare/`. `npm run dev` there runs it locally under `wrangler dev`, and
its tests run every host suite inside workerd. We have not deployed it: deploying needs your own account.

**Inside Cardboard's API.** A host is storage plus socket glue around one pure function. Authenticate the socket
(`auth.verify`), check the token's project, then hand each message to `sequencer.handle(conn, msg)`, and call
`sequencer.disconnect(conn)` on close. Run `sequencer.maintain({ keep: 10_000, segmentRows: 10_000 })` on a timer.
Mount `handleHttp(request, deps)` from `@carton/host-http` for invites, sessions, signed media URLs and resumable
uploads. `server-node/src/host.ts` is a complete example. Then run the host suites on it
([CONFORMANCE.md](CONFORMANCE.md)). What the host API does, in short (details in `carton/docs/plugins.md`):
- **Presence leaves.** `sequencer.disconnect(conn)` tells the cut's other subscribers that each actor the connection
  showed has left (a client that crashes never sends its own leave). Call it for every way a socket ends, and drop
  sockets that go silent: server-node pings after 30 s of silence and drops the socket after as long again. A client
  whose own connection closes drops the presence it was showing from others.
- **Signed uploads.** A signed PUT answers with the stored object's info as JSON (`key`, `size`, `etag`,
  `contentType`, `sha256`). With `If-None-Match: *` it is create-only: 412 when the key is already there, with the
  earlier object's info and nothing written. `X-Carton-Sha256` makes the host refuse a body that doesn't hash to it.
- **Many heads at once.** `POST /api/projects/<id>/blobs/heads { keys }` answers `{ blobs }`, one `{ size }` or `null`
  per key, in order: up to 1,000 keys a request (a host may answer a prefix; ask again for the rest). One invalid or
  out-of-scope key refuses the whole batch. `hostMediaBlobs.heads(keys)` splits and retries for you.
- **Key length.** S3 and R2 cap a key at 1,024 bytes, prefix included. A host keeps a project's media under
  `projects/<id>/media/`, so a media key gets 1,024 bytes less that prefix, and a longer one is refused as
  `InvalidKey`.

**Your accounts.** An `AuthProvider` turns a session token into who is connecting:

```ts
import type { AuthContext, AuthProvider } from "@carton/core/plugins";

// Cardboard's part: lookupSession (role: your session store; null for an unknown, revoked or expired token).
export const cardboardAuth: AuthProvider = {
  kind: "cardboard",
  async verify(token): Promise<AuthContext | null> {
    const s = await lookupSession(token);
    if (!s) return null;
    return {
      account: s.userId,
      credential: `${s.userId}/${s.deviceId}`,   // the same for every token of one install: it owns the replica ids
      role: s.role,                              // "owner" | "editor" | "commenter" | "viewer"; only the first two push
      projectId: s.projectId,
      expires: s.expiresAt,
    };
  },
};
```

What must hold: `verify` returns `null`, never throws, for a token it didn't issue, a tampered one or an expired one;
and the same install always gets the same `credential`. `authProviderSuite` checks the first on any provider. Give it a
provider with `issue` (a test-only one is fine) and it also checks round trips, tampering and expiry. The sequencer
itself refuses pushes from viewers and commenters; the host suites test the viewer case only, so test commenters on
your host yourself. A token can also be limited to some
cuts (`branches`), for remote agents.

## Migration of existing projects

- **Local projects.** The first time Carton opens a project, its current document becomes **`main@1`**: one change
  that inserts everything, by `{ kind: "system", id: "import" }`, with the stable id `import.<projectId>`. History
  starts there. `importProject` (`@carton/store-sqlite`) does it, and finishes an import whose process stopped half-way.
  Several processes may open a new project at once: `main@1` is recorded once. The quickstart's `import.ts` is this
  call.
- **`.revs` history.** The newest 20 slices stay readable through `listRevisions` (H2), after Carton's versions. They
  are not imported as versions.
- **Cloud projects.** Import the current document as `main@1` on the first client that opens it with Carton, then
  `carton.share()` hands the cut to the host: the log is uploaded and the host orders it from then on (§5.3). A second
  client must not import the same project on its own, or the project has two unrelated histories. Other clients join
  the shared cut: `Carton.open({ init: { join: { projectId, cut, doc0, rootHash } }, sync })` opens it on a device that
  holds nothing, and the rows come from the host. The invite carries `cut` (the shared cut's record) and `doc0` (its
  state at seq 0, with `rootHash = hashDoc(doc0, schema)`) from the inviting machine, as the quickstart's `live.ts`
  does; the host's API doesn't serve them yet ([LIMITS.md](LIMITS.md)).
- **Opening a 1.4.0 `.cbproj`** without Carton's entry imports its document as `main@1` like any project.
- **Numeric revs.** 1.4.0's `// cardboard:rev <13 digits>` and `cb undo <rev>` keep working if you keep a map from
  each rev to the version it was written with (our facade keeps it in `carton.db`'s local `views` table).

## Rolling it out safely

- **A switch.** Keep Carton behind a flag that main reads once at start and passes to every process it starts (our
  build: `CARDBOARD_CARTON=1`). With it off, every hook runs today's code, and the bytes written are today's.
- **Mixed versions are safe.** An old `cb`, a text editor, or a terminal `cb` without the flag is a foreign writer:
  displaced and imported, never overwritten (H1). The `.cbproj` exclusions (H11) stay on even with Carton off.
- **Gates before turning it on by default** (§16, [GATE] = measured on real machines):
  - G1: 3 remote writers at 1/s for 10 minutes: 0 lost local edits, 0 remote changes re-committed under the person's
    name, the undo stack holds only the person's group, frame time within noise of Carton off;
  - G2: the 99th-percentile GUI save latency, with 4 agents running `cb source apply` at once, no worse than without
    Carton;
  - the displace/install race on the platform's file system (NTFS, APFS).
- **Run the conformance suite in CI** on your adapter, your projection and your hosts
  ([CONFORMANCE.md](CONFORMANCE.md)).

## Samples that run

`kit/test/samples.test.ts` runs the Carton calls of this page on this machine, with stand-ins for Cardboard's own
functions:
- opening with `importProject` (main@1 once, placement in app data);
- H1: mutations committed against their base: a stale base rebased, a clash carded, a retried id deduplicated, the file
  as a view of head, an in-place edit throwing (records are frozen) and a replaced record committed; through the `cb`
  write path, a save that clashes on one clip lands the rest and keeps its card for its author, across a restart;
- H4: a GUI save through a lossy projection carries only the person's edit;
- H2: history with authors, undo by actor group, restore; `undo --turn` landing the rest with a card for a clip changed
  again since, and a retried one getting its first answer back;
- H3: a print pin and an apply on its header; a header nothing can rebuild is `StateUnknown`;
- `cb`'s commands registered on a stand-in for commander, as cli-mcp's own tests do;
- H9: the hooks' settings (the Bash and file-tool matchers) and the Director's command prefix; H8/H9: an agent's write
  of `project.json` refused, its Read and Write of `timeline.tsx` turned into hook events;
- H7: a ripple recorded as an intent maps a concurrent trim of a later clip once;
- H11: what a `.cbproj` leaves out (by a view file's content), and a file with "Include history" read back, directly
  and through "Bring in their changes";
- people: `setIdentity` telling the generic person by name, `authoredAs`, and `pendingCount` on a local cut;
- the Node host with blobs on disk;
- a custom `AuthProvider` through `authProviderSuite`.

`kit/test/ui.test.ts` runs the UI wiring (`serveUi` ↔ `remoteUi`). The quickstart's test (`kit/test/quickstart.test.ts`)
runs `.cbproj` export, open and "Bring in their changes", and two live replicas through the Node host (with
`setIdentity` and `pendingCount`). Browser-only and Cloudflare-only samples are marked where they appear, with the tests
that run them. The S3 sample isn't run here (it needs an S3 service); blob-s3's own tests run the blob suite against
one.

```sh
cd carton
node --test kit/test/samples.test.ts kit/test/ui.test.ts
```
