# A cut shared later reaches every teammate (design, not built)

Found in the demo rehearsals (`scripts/demo/FINDINGS.md` §4.3, branch `demo/remote-peer`). The setup: a project
shared from the app, a teammate joined from its invite, then `cb share "Backstage"` on the owner's computer. The cut
went up to the sharing server, but the teammate's `cb cut list` still showed only "Main cut". Nothing in Carton tells
a teammate about a cut shared after they joined. This page gives the cause, a design for teammates to learn of newly
shared cuts and open them, what changes where (protocol, server, core, app), and an honest size.

## Why it doesn't reach them today

- **A joiner knows one cut.** The worker's `liveJoin` (`scripts/carton/sync/worker.js`) reads the project's share
  descriptor (`host.DESCRIPTOR_KEY`, a blob the owner's worker uploads once: `publishDescriptor` → `uploadDescriptor`).
  That descriptor names exactly one cut, the sync config's `cut`, with its root (`doc0`, `rootHash`). `Carton.open({ init:
  { join } })` makes that one cut in the joiner's store, and nothing else.
- **Sync is per cut.** Every client message names its cut (`branchId`). A connection subscribes to a cut with `hello`,
  and the server fans out rows and presence only to the subscribers of that cut (`packages/server/src/sequencer.ts`).
  A replica sends `hello` only for the shared cuts its own store holds (`Carton.sync.connect` walks `#h.cuts()`).
- **The server knows, but says nothing.** `cb share <cut>` is a `share` write (`cli-mcp` `commands.ts`, local
  `writes.ts`): core's `Carton.share` hands the cut over with `adopt` (§5.3), and the server keeps it in its
  `branches` table, beside the tracking branches of its ancestry closure. No message lists a project's cuts, and no
  message announces an adoption or a server-side `fork` to other connections. The descriptor isn't rewritten either:
  `publishDescriptor` runs only while the config says `descriptor: "pending"`, for the config's cut.

So the cut exists on the server, and only the replica that shared it holds it. A teammate can't even ask for it,
because they don't know its id.

## What a teammate should see

- In the cuts menu and History's cut bar, the new cut appears as shared, named by whoever shared it: "Backstage ·
  shared by Vikas". It is listed, not opened. Nothing is downloaded until the teammate opens it.
- Once, in the toast spot over the stage: "Vikas shared a cut: “Backstage”." with an **Open** button. It shows only if
  the person isn't on that cut, and never for a cut they shared themselves.
- `cb cut list` lists it as `shared`, and `cb cut switch "Backstage"` works, as on the sharer's computer. An agent
  learns it the same way.
- Opening it is a cut switch. The replica sends `hello` for that cut from nothing (`have` 0). The server answers with
  the cut's root keyframe, which `adopt` stored with its `rootHash`, plus the rows after it, or the keyframe plus the
  tail when the cut is long. History, credits and Compare work on it as on any shared cut.
- A watch link (a reader scoped to some cuts: `c.auth.branches`) never learns of any other cut. The server filters, as
  it already refuses messages for cuts outside the scope.

## Design

### Protocol (`@carton/core` `sync/messages.ts`)

This follows the same pattern as shared landmarks (fix/ux2-open): a welcome flag, a request, a reply, and a push to
whoever asked. Older peers on either side never see the new messages.

- `WelcomeMsg.cuts?: true`: the server keeps a project-wide cut list. A client sends `cuts` only after a welcome
  carried the flag.
- Client → server: `{ type: "cuts", branchId, since }`. `branchId` is any cut the connection said `hello` on: every
  message must name a cut, and the scope check runs on it. `since` is the newest cut-list generation the client holds
  (0 at first).
- Server → client: `{ type: "cuts", branchId, gen, rows, reply? }`. Each row is a `SharedCutRow`: `{ id, rec:
  CutRecord, root, rootHash, forkOf, by?: Actor, at }`. A row with `gone: true` is a cut no longer shared. The same
  message, without `reply`, goes to every connection that asked, whenever the list changes.

### Server (`@carton/server`; deployed separately to Cloudflare)

- `tables.ts`: a small `cuts_log` table (`gen INTEGER PRIMARY KEY, branch, at, by`), written in the same transaction
  as a successful `onAdopt` or `onFork`. The branches themselves are already in `branches`; tracking branches
  (`tracking: true`) are never listed. `cutsAfter(gen)` joins the two tables. Shared cuts per project are few: a cap of
  500 rows per reply, with `more`.
- `sequencer.ts`: `onCuts` answers and sets `ConnectionState.cuts = true`. `onAdopt` and `onFork`, once committed,
  send the new row to every connection with `cuts`, filtered by each connection's scope. That is the same fan-out
  helper as landmarks, without envelopes, since a row is small. The welcome says `cuts: true`.
- `server-cloudflare` `room.ts`: `stateKey` must include `cuts`. A field missing from it is lost at the next
  hibernation (the trap fix/ux2-open hit). Nothing else in the Durable Object changes: it runs the same sequencer.
- Deploy: the conformance suite (`sequencerHostSuite` gains two tests: the list after an adopt, and the push to a
  second connection) on server-node and in workerd, then `pnpm run deploy:cloudflare`. Until the deploy, clients see no
  `cuts` flag and behave exactly as today.

### Core (`@carton/core` `carton.ts`, `sync/client.ts`)

- The sync client sends `cuts { since }` after the first welcome that carries the flag, once per connection, on the
  cut it connected first.
- `#takeCuts(rows)`: for a row whose cut this replica doesn't hold, store a cut record with `sequencer: { kind:
  "server", since: root }`, `shallow: true` (nothing of it held yet) and its root's `rootHash`. Store its maker (`by`,
  as `#h.maker` keeps it), then emit `{ type: "cuts" }`. The same store write keeps the generation, in `meta`
  (["cutsGen"]): the next `since`.
- Opening a shallow shared cut (`switchTo`, `head(cut)`, `log({ cut })`) makes `#ensureShared(cut)` connect it with
  `have` 0. The welcome's keyframe is checked against the row's `rootHash`, as join checks the descriptor's.
- `cuts()` returns these records like any other. `cut.shallow` with `sequencer.kind === "server"` reads as "shared,
  not opened yet".
- None of this is in `history/`: the History bundle (32,000 B budget, 31,994 B today) doesn't grow.

### The app and the worker (`scripts/carton`, `@carton/react`)

- `@carton/react` `from-carton.ts`: the `cuts` topic already follows core's `cuts` event, so the menu lists the new
  cut. Add the "shared by …" words, and an `opened` flag so the menu can say "Open" rather than "Switch".
- `scripts/carton/ui.js`: the toast "Vikas shared a cut: “Backstage”." with Open (`ui.switchCut`). New words in
  `words.ts`: `sharedACut(who, cut)`, `sharedBy(who)`.
- `sync/worker.js`: `uploadDescriptor` also writes `cuts: [{ id, rec, rootHash }]` for every shared cut, so someone who
  joins later gets them at once even on a server without the list. The descriptor is uploaded again after a
  `share` write the worker serves; that needs a small hook on the holder's `share` op.
- `sync/live.js`: none. Status follows the current cut, or the shared cut the person left (this branch's §4.4 fix).

### Without a server change (a stopgap, if the deploy has to wait)

The descriptor is a blob that every member can read. If the owner's worker rewrites it with every shared cut (the
`uploadDescriptor` change above), a teammate's worker could read it again at each reconnect and every 5 minutes, and
take its cuts as `#takeCuts` would. That works on today's server, but a new cut reaches teammates minutes late, not at
once. And an editor who isn't the owner can share a cut but may not be allowed to rewrite the descriptor. Worth it
only if the server deploy is blocked.

## Size

Rough, from the code it touches. Not measured:

| Part | Code | Tests |
|---|---|---|
| Protocol messages and types | ~40 lines | in the others |
| Server: table, `onCuts`, fan-out from adopt/fork, scope filter; CF `stateKey` | ~120 lines | conformance +2 tests (~120 lines), run on server-node and workerd |
| Core: client request, `#takeCuts`, shallow shared cuts opening from nothing | ~150 lines | core unit (~200 lines: list, push, open from nothing, scope, old server) |
| Worker: descriptor with every cut, re-upload after a share | ~40 lines | sync test with real workers (~150 lines: share later, the joiner lists and opens it, edits sync both ways) |
| App: menu words, toast, Open | ~60 lines | react (~80 lines) |

About 400–450 lines of code and 550 of tests, plus a Cloudflare deploy. That is two to three working days with one
review round. The main risk is core's shallow-shared-cut path, a state that doesn't exist today: a shared cut held
with no rows. Every reader of a cut (log, credits, compare, fold pickers) must treat it like a joiner's cut before its
first catch-up, which is the case `join` already handles for one cut.
