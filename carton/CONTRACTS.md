# Carton contracts

The types and interfaces every package builds on. They follow the verified prototypes (`proofs/core-v5`,
`proofs/system-v11`) and PLAN v14 §3.1, §4, §5, §6, §7, §8, §9, §12, §15. A stub that throws `not implemented: …`
is a signature its owner fills in. Changing a contract: make it a small `contract(<pkg>): …` commit and note it in
your notes file, so the others can merge it.

## Where each contract lives

| Contract | File | Owner |
|---|---|---|
| Schema: field kinds (scalar, object, atomic, text, ephemeral, blobRef, keyed), field groups, edit algebra, timeline config, validators | `core/src/schema.ts` | foundation-core |
| Doc, Op (`insert`/`remove`/`set`/`unset`, and `remap` as one op), Change, ConfirmedChange, PendingChange, Declaration, Span, Actor, StateRef, pins, cuts, versions, DAG nodes, `.cbproj` exports, conflict cards, merge results, shot diff, undo entries, `CommitResult`, notices, events | `core/src/types.ts` | foundation-core |
| Engine functions (diff, apply, merge3, resolve, compare2, keys, remaps, declare, shots, describe, canonical, hashing) | `core/src/engine/` | foundation-core |
| History (`History`), `StateUnknown`, `STORE_TABLES` / `LOCAL_TABLES` | `core/src/history/` | foundation-core |
| `Carton.open` and the `Carton` handle | `core/src/carton.ts` | foundation-core |
| Plug-in interfaces with their invariants (`@carton/core/plugins`) | `core/src/plugins.ts` | foundation-core |
| Sequencer rule: `overlap`, `LocalSequencer`, `PushResult` | `core/src/sequencer/` | sync-sequencer |
| Sync messages (hello, push, ack, reject, withdraw, confirmed-id list, presence, hand-off) and the sync client | `core/src/sync/` | sync-sequencer |
| `createSequencer`, the §6.3 DDL, demo HMAC auth | `server/` | sync-sequencer |
| Node and Cloudflare hosts, blob stores | `server-node/`, `server-cloudflare/`, `blob-*/` | hosts-plugins |
| SQLite and IndexedDB stores | `store-sqlite/`, `store-idb/` | stores |
| In-memory store | `store-memory/` | foundation-core |
| Cardboard adapter, identity source | `cardboard/` | cardboard-adapter |
| Media | `media/` | media |
| Local machine, `cb` and MCP | `local/`, `cli-mcp/` | local-cli |
| Hooks and components | `react/` | ui |
| Conformance suites | `conformance/src/<area>/`: engine (foundation-core), store (stores), blob and hosts (hosts-plugins), system (sync-sequencer), local (local-cli), cardboard (cardboard-adapter), media (media) | as listed |

## The plug-ins (`@carton/core/plugins`)

Each interface's doc comment lists its **Invariants**; its conformance suite checks exactly those.

| Interface | Shape | Ships as |
|---|---|---|
| `Store` | async `get`, `range`, and atomic conditional `write(writes, conditions)` over ordered keys. Conditions are the cross-process CAS (local sequencer appends, sync lease) | store-sqlite, store-idb, store-memory |
| `SequencerStorage` | sync `exec(sql, ...params)` and `transaction(fn)` (DO `ctx.storage.sql`, node:sqlite) | inside server-cloudflare, server-node |
| `SequencerHost` | `url`, `close()`; feeds authenticated `SequencerConnection`s to `createSequencer` | server-cloudflare, server-node |
| `Transport` | `connect(url, {token})` → ordered, at-most-once message connection | WebSocket, in-process |
| `BlobStore` | put/get (ranges)/head/delete/list, multipart with resume; optional `getWithInfo` (the info and the bytes in one call, so a host's signed read is one storage call, not a head and a get) | blob-r2, blob-s3, blob-fs, blob-memory |
| `AuthProvider` | `verify(token)` → `{account, credential, role, projectId, branches?, expires}` | demo HMAC (server) |
| `Hasher` | async `sha256(bytes)`, optional `sha256HexSync(text)` (core uses it for state hashes) | node:crypto (local), WebCrypto |
| `ProxyEncoder` | `probe()`, `encode(input, output, profile)` | Cardboard proxy, NVENC → QSV → AMF → libx264 |
| `IdentitySource` | `current(env)` → `Actor` | Claude Code hooks / `CARDBOARD_ACTOR` (cardboard) |
| `HostAdapter` | `schema`, `fromHost`, `toHost`, `project`, `projectGuiSave` | cardboard |

## Formats to keep exactly

- **Change ids** are `<rid>.<n>` with a 96-bit random `rid` per process (hex). Dedup is by id; ids survive rebases.
- **Refs** print as `main@57~3f9a1c0e b:<token> p:<printNonce> by <actor>`; a bare 13-digit number is a 1.4.0
  timestamp rev. Node ids are `<branchId>@<seq>`. `<token>` is `branchToken(cutId)` (exported from `@carton/core`, the
  one definition; the adapter's header prints it): the id's first 8 characters when they are lowercase hex (every id
  core makes, so those headers never changed), else the first 8 hex characters of the id's SHA-256, so any cut id (one
  from a `.cbproj` or another host: `b6b.alt`, non-ASCII) reads back. A header names the cut whose token it carries;
  two cuts with one token are told apart by which has the header's state at its seq (confirmed or pinned), then by the
  header's cut name, so a cut renamed since the print keeps its headers when another cut takes its old name.
- **Path keys** join segments with `/`, escaping `~` → `~0` and `/` → `~1`. Field-group paths end in `#<group>`
  (`timelineItems/X/#time`). Sequences order by the `#pos` field.
- **Spans** are half-open `[lo, hi)`; `hi: null` is open-ended (a remap's `[t0, ∞)`).
- **Hashes** are SHA-256 hex over `canonical()` JSON (sorted keys, `undefined` dropped).
- **Policy** is `"merge"` (the plan's `cas`) or `"lww"`; `lww` on a change with a span or group path is rejected.

## Carton handle notes

- **Refs** passed to `checkout`, `diff`, `fold`, `restore`, `preview` may be a printed header, a `StateRef`, a node id
  `"<cutId>@<seq>"`, or a cut id (its head); a commit's `base` takes a header, a `StateRef` or a node id. A ref that
  can't be rebuilt exactly throws `StateUnknown`.
- **Documents are values.** `head()`, `checkout()` and `resolve()` hand out the collection arrays as the caller's own
  (add, remove, reorder freely) and the records and root values frozen: they are History's, shared with every state
  that didn't change them, so an edit in place throws. Replace the record you change (`{ ...rec, name }`). What you
  commit becomes History's the same way: a record or value you passed in (an op's value, or `commit({ doc })`'s
  changed records, which the diff takes as they are) is frozen once a state holding it has been handed out, so keep
  building on copies, not on the objects you committed. The cost is the array copy a head always had: each of
  History's arrays is frozen once, and a change freezes only what it writes.
- **A split** records its lineage in the intent (`{ kind: "split", lineage: { c: ["c", "c-b"] } }`): a concurrent edit
  to the split clip meets the split (the source record is part of its declaration) and reaches every piece, whichever
  lands first: a rebase, a shared cut's commit made on an older version, a fold (each side's maps and lineage composed
  along its path; a fold records the lineage it brings in on its edges, `mergeEdges.lineage`, and a `.cbproj` lineage
  edge carries it as `parents[].lineage`), on local and shared cuts. Field edits and a track change follow the lineage;
  a real retime of the split clip (a move or trim, not a ripple's shift) is a card (`items/<id>/#time`, PLAN §7: "raise
  a card rather than guess"). A ripple on one side moves both pieces. Folds through merges or `.cbproj` edges made
  before this (no `mergeEdges.lineage`, no `parents[].lineage`) don't know the split: an edit there reaches the clip's
  first piece only. `carton.lineage(from, to)` reads the lineage composed between two versions (`{ cut, seq }`, `from`
  before `to`; null: none), for code that maps old ids itself (comments' anchors).
- **Empty versions** (laptop, build 915eb36: Restore of "Started the cut" wrote a project.json with no name, and the
  project left Cardboard's library). A version with nothing in it (`isBlank`: no root field, every collection empty)
  holds nothing of the project: the root an imported project's history starts from (`init.asChange`; the project is
  `main@1`), or a cut made from it. `log()` marks a cut's start that is one (`Version.blank`, read from its keyframe:
  no replay). `restore` of one, and `fork` from one given as `from`, throw `EmptyVersion` (`code: "EMPTY_VERSION"`)
  before anything changes, on local and shared cuts; a UI doesn't offer either on such a row. A `fork` from head takes
  the head as it is.
  - **The schema's own rule** (laptop, final candidate P2-1, P3-2). `SchemaDef.empty(doc)` adds the states a host can't
    open as a project though they have a field or a record (Cardboard: a name with no aspect ratio, tracks, clips or
    media, what the root-restore bug left once the project was named again); `isBlank` takes it beside core's own rule.
    Restore and `fork` from such a version throw `EmptyVersion`, its words saying which it is: a cut's start "(the
    history starts there, before the project was in it)", any later version "(nothing of the project is in it)".
    `undo`, `redo` and `revert` whose result the schema's rule takes for empty, made from a head it doesn't, throw
    `EmptyVersion` ("Can't undo that: the project would be left empty") before anything is written or queued (History's
    `planUndo` and `planRevert`; local's `undoTurn` too). On a shared cut a queued one is rebased onto teammates' edits
    before it is pushed: one that has become empty so is refused at the push (`rejectLocally`, its author told "it would
    have left the project empty"; review of fix/recover-save #1). Not checked: a push the server confirms on a head that
    moved without the client's rebase (the sequencer has no schema rule). Core's own rule never refuses an undo: a
    generic schema reaches no field and no record by undoing its first record.
  - A lease holder's refusal keeps its code across the control socket (`@carton/local`: a thrown error's string `code`
    rides in the JSON-RPC error's `data.code`, and `submit` answers `{via: "error", code}` with it; retries still read
    the transport's code), so the app's undo tells "refused" from a failure wherever the lease is held.
- **Creating a project:** `init: { doc }`, or `init: { import: shallowExport }` for a teammate's `.cbproj` of a project
  this machine doesn't have. `init: { doc, asChange: true }` (§16) makes the empty root and the import change
  (`main@1`, id `import.<projectId>`) in one store write; a project left at its empty root with no change gets the
  import on the next open with `asChange`.
- **A `.cbproj` from a copy of your project folder** (the same cut ids): the sender's versions on a cut you hold that
  aren't yours come in as a separate cut `<cut>.<hash8 of their first such version>`, named "<name> (<sender>)", linked
  to the versions you share; the fold brings them in. A version compaction squashed keeps its state hash, so your own
  versions are still recognized in their copy. The import change (`asChange`) is a lineage point like an export
  (lineage kind `"import"`, its state carried, delta-encoded), so two copies of an imported project fold from it,
  not from the empty root. A hand-off closure lists it without its state.
- **Every exported version is a lineage point**, whichever process exported it. An export writes its row (meta
  `["export", node, at, nonce]`) and the next row of a dense index (meta `["exported", n]`, `{node, to, at}`, written
  only if absent: a concurrent export makes one of them retry). A handle reads all export rows at load, then before
  every write only the index rows after the newest it has seen (usually none; not on `head()` or reads). So the app's
  next `.cbproj` carries a version `cb` sent meanwhile, its compaction keeps that version, and a periodic keyframe
  never replaces that version's keyframe (local-cli request 9). An older process's exports (no index row) are seen at
  the next open.
- **A `.cbproj` with history** ("Include history", §13): after the shallow import, `importHistory(store)` takes the
  file's full-history store (same project, same schema, else it throws). The sender's cuts this replica doesn't hold
  in full become read-only tracking cuts with every version, author and name; a newer file grows a tracking cut it
  already holds by the rows that extend it. The importer's own cuts are never touched. Returns `{ cuts }` taken.
- **Commits** are idempotent by `id`, accept a held base (`{baseDoc, baseSeq, causal}`) and extra Store `conditions`
  (a lease fence); a lost cross-process append race rebuilds from the store and retries. The conditions go with the
  write that keeps the edit: the append on a local cut, the pending row on a shared one. On a shared cut, a commit with
  conditions isn't sent to the server until that write lands (nor what is queued after it), and a condition that
  breaks before then (a lease taken over meanwhile) rejects the commit: nothing is stored, sent or queued, no notice is
  filed, and the id stays unspent for the process that holds the lease (windows-sync review round 3 #1; review R6-2,
  R6-3).
- **Creating a project** also takes `init: { join: { projectId, cut, doc0, rootHash? } }`: a cut a server already
  sequences, from an invite, on a machine that holds nothing of it (forks too). Once connected, the joiner fetches the
  cut's ancestry closure (`history` request) and loads it as read-only lineage. The client asks for it in pages
  (`lineageFrom`, from `{entry: 0, state: 0}`) and follows each reply's `lineageNext` to the end; a server that doesn't
  page sends it whole in one reply.
- **Shared cuts** (`sequencer.kind !== "local"`) go through `SharedCut` (sync-sequencer's queue and client): `commit`,
  `fold`, `foldSome`, `undo`, `revert` and `restore` all queue an ordinary change with its intent, kind and `reverts`
  under a stable id, and come back `pending`, then confirmed (or rebased, absorbed, rejected) with a notice for the
  author. The `absorbed` event comes once the rows that came with it are in History (after their `change` events): a
  handler that reads credits, head or log at it sees the teammate's change behind a card (web-demo REQ-U1). So do a
  settle's `notice` events (a late conflict's cards). After a settle that couldn't store, they come with the one that
  does; after a keyframe catch-up, once the skipped rows are in History (fetched, or loaded from the store). If they
  can't be fetched (offline, a server that can't serve history), or the handle stops or closes first, they come on what
  History holds, and credits for those rows are unknown (review R6-8, R6-10, R6-11, R6-13, R6-15).
  Undo, revert and the undo stack see this replica's pending edits as the newest changes. Change ids on a
  shared cut must be `<rid>.<n>` (`carton.newChangeId()`): the server binds the rid to the device. `share()` uploads
  the cut's rows (with the names given to its versions) and its closure, shallow (PLAN §5.3). A change over the
  client's message limit is refused before it is sent (`rejected` / "too large", its author told; the edits after it
  go on): pass the host's blob store as `sync.blobs` (envelopes over 1 MiB, and the server's declared limit becomes
  the client's), or `sync.maxMessageBytes` to match a host set below the 32 MiB default. An envelope's `sha256` is
  the SHA-256 of its bytes (WebCrypto where there is one, else the portable hash: the same digest). `presence()`
  goes out at most 10 times a second (`PRESENCE_PER_SEC`), coalesced: the latest state always arrives, and one
  still waiting when the handle closes (a leave, `null`) is sent before the close; the relay keeps none. When this
  replica's own connection closes (or it stops), every peer it showed gets a `presence` event with `state: null`: a
  host that restarts keeps no one to send leaves for. This replica's own latest presence (unless it was a leave) goes
  out again after each reconnect's welcome, an update a disconnect caught waiting included, and again (once, coalesced
  by the throttle) when a peer shows for the first time on a connection or relays its connection's first presence
  (`arrived`: a second tab of someone shown already), unless the host sent that peer as `kept`. A connection's first
  presence that isn't a leave says `arrived`; an answer never does, so no round goes on. Peers are told apart by
  kind, id and agentId. The handle's `sync.presence()` shows on its current cut: when that changes (`switchTo`, or
  another process's switch it follows), the cut it showed on gets a leave.
  The sequencer keeps each connection's latest presence per branch and actor in memory (the actors `shown` holds, up
  to 16 KiB each) and sends a connection that subscribes the presence every other connection there shows, right
  after its welcome, marked `kept`. So after a host restart or a join, in either order, each side lists the other
  even when nobody moves (presence P2); a host that lost what it kept (a Durable Object's wake) still converges by
  the clients' answer. A pending edit survives a
  restart as the queue had it (its rebase count, the cards its rebases raised, the bases it was sent on): reported
  when it settles, withdrawn rather than dropped if a rebase emptied it after it was sent. Each stored edit keeps its
  causal base (the confirmed seq and the pending edits it was made on, and what those did as it read them) and is
  rebuilt on it and rebased onto what was confirmed since, with cards for what clashed. While a keyframe catch-up's skipped rows aren't saved yet, the
  confirmed states edits are made on are (meta `["queue-head", cut, seq]`, each while an edit needs it), and a restart
  resumes at the newest, offline too; an edit whose base nobody can rebuild waits, never applied on a guessed one, and
  so do the edits made on it. A retry of an edit already queued (here, waiting, or another process's row) answers
  `pending`. An
  edit absorbed before it was sent spends its id (a retry answers it, never applies it again). One withdrawn after it
  was sent is spent by the server's withdraw row (`ConfirmedChange.withdrawn`, authored `{kind: "system", id:
  "withdraw"}`): every replica stores and syncs it (its seq and the spent id stay), and none shows it as a version:
  `log()` leaves it out (so History, `cb history`, the Compare and restore pickers and version counts do), its `change`
  event only moves the head, and its seq is a gap in the numbering. A settle that fails keeps its outcome for the next one; a wait answers
  `pending` until it is stored. A host that refuses or fails a cut's sync (a hello refused: an older host, "update
  the server"; a token it doesn't accept or that expired; a write refused for its token or cut; no host) is
  `sync.error(cut?)` and a `sync-error` event (`SyncError`: `code`, `message`), until a later welcome, ack or
  acknowledged withdraw clears it (`error: null`). Classified by machine code first (a refusal's `ErrorMsg.code`:
  `schema-too-new`, `unauthorized`, `forbidden`, `bad-request`, `write-limit`, `history-missing`; a failed connect's
  transport code: `unreachable`, `unauthorized`, `protocol`, `closed`), by the words only when there is none.
  `history-missing` (stuck-sync, laptop run 2026-11-03): a catch-up needs history the server's blob store no longer
  has. Keyframes only shorten a catch-up, so the sequencer passes over one whose blob is gone (an older keyframe, or
  the rows alone when the replica holds a state they extend; `SequencerStats.missingBlobs`, a `missingBlob` event);
  only a joiner with no state left to start from, or rows held only in a lost archived segment or body, is refused,
  in words a status line shows ("this project's history can't be loaded: …"; `SyncError` code `server`), and a
  `history` request over such rows gets that as its reply's error. Before, the host's "internal: keyframe … is
  missing" left the replica in "syncing" for good. `write-limit` is a host's
  daily write cap: a blob write refused for a while throws an error with `retryAt` (BlobStore's contract), the
  sequencer drops the rest of that push's epoch for a client whose hello said `writeLimit` and tells it the wait
  (`retryAfterMs`); the client keeps its edits, pushes nothing (nor a hand-off upload) until then, and pushes again
  on its own, with no reconnect. `SyncError.until` says when. An older client gets the limit in plain words, its epoch
  left as it was.
  `carton.media` is null: `@carton/media` calls Carton, not the reverse.
- **People (windows-sync R3).** Cardboard's GUI saves are the generic person `{kind: "human", id: PERSON}` ("person")
  on every computer.
  - `log()` and `credits()` tell such a change as the person behind its replica (the `<rid>` of its id), keeping the
    actor's `group`. The actor as recorded stays in `authoredAs` (`Version`, `Credit`). Agents, subagents and named
    humans are never resolved. Hashes and rows don't change: the people live beside them.
  - `carton.setIdentity({ id, name })` sets this replica's person: `id` is the sync session's account, `name` what
    teammates see. It is kept in the store (meta `["identity"]`) and sent in every hello, and as `identity` on a live
    connection to a host that keeps people.
  - This store's replicas (meta `["rid", …]`, every process that saved here) resolve to it at once, offline too.
  - A teammate's replicas resolve as the host says (`WelcomeMsg.people`, then `people` messages, kept in meta
    `["person", rid]`). The host keeps one person per device credential, takes it only under the session's own account
    (`forbidden` otherwise), and names every replica id that credential used, the edits uploaded by a share included.
    So each replica writes only its own entry; the name is the person's own choice.
  - A fold credits a record to its author on the cut folded in: told by that cut's change, and as recorded where that
    cut isn't held here.
  - Presence goes out as the resolved person.
  - A `people` event says authors may read differently.
- **A `cuts` event (laptop re-check P3 #1)** says the cuts changed: one made (with no edit yet, which moves no head and
  so tells no `change`), renamed, gone, or its kind, protection or sync changed. This handle's own writes, a sync, and
  another process's writes on the same store alike; another process's are told once this handle reads the store again
  (any read: `log()`, `cuts()`, `head()`…). A cut menu reads `cuts()` again on it.
  - An app shows its own edits as "You" by passing its resolved person as `me` (`identity()`, with its `group`).
- **Versions in words (UI audit 2026-11-02).** `log({summary: true})` gives each version one line (`summary`) and,
  when that line doesn't say it all, every change it made (`details`, describe()'s lines). A version of several changes
  is summed up (`describeVersion`: "Moved 'clip.mp4', changed 'W1' and 'W2'"); a fold, the rest of a partial fold, a
  restore and the import say what they were ("Folded 'Client review' into 'Main cut': 3 changes", "Restored an earlier
  version"). Descriptions never print an id or a hash: an id field (`…Id`, `…Ids`, `…Hash`) or a hash-like value is
  told by its field's name, and a collection's `phrases` tell a field in a sentence ("Linked %s for sharing").
  - **A split reads as a split** (laptop re-check P3 #2). One clip removed and, in its place, two or more of the same
    footage (same kind, references and name) on its track, back to back over its range, is one line: "Split
    'clip.mp4' at 4.0 s" (several points: "at 3.0 s and 7.0 s"). A part changed after it in the same version is told
    against what the split made of it: "Split 'clip.mp4' at 4.0 s, moved its right part 4.0 s → 20.0 s" (one part
    where the split left it, the other keeping the cut's source point: moved, or trimmed at its far end). A field the
    split itself drops or rescales (a transition, a fade, keyframes) is no change of its own, nor is a field the host's
    split leaves off every part (`TimelineConfig.splitDrops`; Cardboard: `autoReframe`, which its editor's save doesn't
    write on a new clip; laptop re-check P3: "…, cleared auto reframe on its left part, … on its right part"); a value
    set on a part, or cleared on one part only, is still told. `splits(ops, base, schema)` names them (removed clip,
    parts left to right), so a list by record (the Fold dialog) shows a split as one row, left out whole.
  - **One counting rule for changes** (laptop re-check P3: the Fold dialog said "2 changes", History "1 of 4 changes"
    and `cb history` "merge (3 left out)" for one fold; Compare "3 changes" where Watch said "2"). `countChanges(ops,
    base, schema, among?)` counts a change per record (a root field: one each), a split one, a ripple's remap none:
    the Fold dialog's rows. History's fold titles, `cb history`'s left out (`leftOutChanges` on a partial fold's
    version), Compare (`Comparison.changeCount`) and Watch the changes (`ShotDiff.changes`) all use it. Watch's counter
    steps through the sections of the edit that differ ("Section 1 of 2"), which aren't changes.
  - **A record by what it is** (laptop re-check P3-8, P3-10). `CollectionDef.nounOf(record)` names a record when its
    collection holds several kinds (Cardboard: a text item is a title, a code item a code graphic, a caption a
    caption), or returns null for a record that is part of another (a title's own media entry, "Text: W1"). A version's summary counts by it ("Added 2 tracks, video 'clip.mp4', 6 titles and media 'clip.mp4'": it read "7 clips and 6
    media files"), an add or delete line names it ("Added title 'W1'"), and Compare's clip count leaves titles apart
    ("1 clip, 6 titles").
  - **A part goes with what holds it** (laptop, merge/prod-2 N-1). `CollectionDef.partOf: {collection, field}` says
    whose part a record is (`nounOf` null): the record of `collection` whose `field` holds its key (Cardboard: media
    `partOf: {collection: "timelineItems", field: "mediaItemId"}`; descriptions only, not in the schema fingerprint).
    A part whose holder (the one record naming it by that field, in base or among the change's inserts; never any
    equal value elsewhere) the same change also touches, adding or deleting the part only as it adds or deletes the
    holder (or editing both: a title's text and its entry's), is no change of its own, as a split's parts are the
    split's: describe tells the holder alone ("Deleted title 'W6'"), `countChanges` counts one (regress prod3 P3-C: a
    setup row's "15 changes" listed every title's entry), and `heldBy(ops, base, schema)` names the pairs (`{part:
    [coll, id], holder: [coll, id]}`) so a list by record (the Fold dialog) joins the part to its holder's row, left
    out with it. A part two records name (a duplicated title's shared entry), or whose holder the change leaves
    alone, or added or deleted on its own, is still told, and is its own row. Who names what is read once per call.
  - **Naming from a larger set** (regress prod3 P3-B). `describe(ops, base, schema, intent, names)`: when the ops are
    one row of a larger set (the Fold dialog), `names = namingDoc(base, allOps)`, made once per plan, names the
    records the set adds ("Moved 'W1' to track 'Text 1'", a track the same fold adds). A track nothing names is
    "another track", never "track another track".
  - **The app's change rows (UX redesign 0.1, 0.2; docs/carton-ux DESIGN §8).** `changeList(ops, base, schema, {
    intent, names, value })` is the one sentence table every app surface uses (History, a version's card, the Changes
    view, the Fold dialog, toasts): one `ChangeRow` per change as `countChanges` counts it (same count, always), verb
    first, the record by its name in curly quotes, positions as the timeline's timecodes ("Trimmed “Intro”, now ends
    at 0:05", "Moved “W6” 2 s later (now starts at 0:09)", "Made “W2” bigger (font size 100 → 222)", "Changed “Hello” to
    “Hello world”", "Split “clip.mp4” at 0:04"), never an id or a hash, with `kind` (add, remove, change), the record
    and where it is (`at`/`end`: after the change, before it for a removal). `value` words a field's value as the host
    does (Cardboard: `cardboardValue`). `changeSummary(rows, schema)` sums several up by verb ("Moved “A” and “B”,
    trimmed “C”"); a track added for the clips moved onto it is `minor`, said by their row ("Moved “W6” to a new
    track"). `describe()` keeps its exact lines ("Trimmed 'Intro' end 6.0 s → 5.0 s") for `cb` and agents.
    `describeCard`'s sides use the same words ("Moved it to start at 0:07") and give the record's `name`.
    `log({ summary: true, rows: true })` adds each version's `rows`, a structured `title` (a fold with what it took of
    how many, the rest of a partial fold, a restore with the version it restored, an undo or redo of either) and an
    undo's `undoes`, so the app words them with its own clock ("Restored the 12:41 pm version"). None of this is in the
    history bundle.
  - **A restore says which version it brought back** (`Change.restoreOf`, a node id; not hashed, not in the change's
    identity): set on a local cut's restore of a node or a cut; a held state (a pin's header) and a shared cut's restore
    have none, and read as "an earlier version".
  - **What each version touched** (UX redesign 0.8): `touched({ cut, record?, after?, upTo? })` lists, oldest first,
    the records (`coll/id`, a root field by name) each version touched, from what its change declared when it was saved
    (`paths`; a compacted change's own ops), so a clip's History ("Only “clip”") answers at 10k versions without
    reading a state or diffing. Versions as `log()` lists them: a fold-some is one (its left-out records not touched),
    a withdraw row none. A ripple's shift touches only what it names.
  - **A fold-some is one version.** Its fold and the partial revert right after it are two changes, but `log()` lists
    only the partial revert (the state that was chosen), as a version of kind `merge` with `rejected` (what it left
    out; `change` is the partial revert's id, which "fold in the rest" reverts), titled "Folded 'X' into 'Y': 2 of 3
    changes" (a split one change), its `details` exactly the changes taken. `cb history` shows it as `merge (1 left out)`,
    `leftOut` (the paths) and `leftOutChanges` (how many changes) in JSON. The fold's own state, with what was left out, is no one's version: History, `cb
    history`, the pickers and version counts leave it out, as they leave out withdraw rows. Seqs, ids and the DAG are
    unchanged. A fold and partial revert with a change between them (a shared cut's queue) stay two versions.
    **It is one undo** (laptop P2-1: after it and "fold in the rest", Ctrl+Z ② reverted the partial revert alone, which
    brought the rest back in, and Ctrl+Z ③ undid the fold). The undo stack lists only the partial revert: a fold whose
    partial revert (the `partial-revert` that `reverts` it, not withdrawn) is in effect is never an entry of its own,
    also with a teammate's change between the two. Undoing that entry is one undo change with `reverts: [fold,
    inverse]` (so History reads "Undid the fold of 'X' into 'Y'"), and its redo re-applies both. The two right after
    each other (one version) are inverted as one step, from before the fold to after the partial revert, so what the
    fold left out never meets a teammate's later edit of it as a card (review #1); with a change between them, each in
    turn. An agent turn's changes are inverted newest first by seq (review #2). A partial revert that an earlier build
    undid alone leaves its fold an ordinary entry. `undoStack()` labels the entry by what the fold kept; `undo()`'s
    and `redo()`'s entries and the redo stack's read as a whole fold's (`Undo merge`, `Redo merge`), a shared cut's
    pending ones too (review #3, #4); `@carton/local`'s `undo --turn` undoes a fold-some version from before its fold,
    naming both changes.
    The partial revert's id is always `<fold's id>.inverse` (local and shared), which is how a server, holding only
    ids and flags, pairs them; its count reads archived rows from the segment index, so it holds across an archive.
  - **What was left out.** `leftOut(from, { into })` lists the partial folds of cut `from` into `into` whose left-out
    part is still left out, newest first: the inverse change, its version, who folded and the paths. Folding in the rest
    is `revert(change)` (as `cb fold` does when nothing new is left); a plain `fold` still doesn't bring it in (§5.3).
    `log()` marks that revert's version with `restOf` (the partial fold's `change`), so a list shows it as a fold, not
    an undo (final re-check P3-12b); its undo and the redo of that have none. A redo (a `revert` of an undo change) is
    marked `redoOf` (the undo it takes back) by `Carton.log()`, so a list shows it as a redo: `cb history` says `redo`
    (laptop: it said `revert`), as it says `undo` for an undo.
- **Published cuts are read-only** to every write (`commit`, `undo`, `revert`, `restore`, `fold` / `foldSome` into
  them), local or shared, even one that would change nothing: they change only by publishing again. A shared
  Published cut's welcome carries `source: { branchId, at, head, versions }` (`sync.WelcomeMsg`): the cut it came from,
  the version published, that cut's head now and how many versions it has since (its rows after `at` less withdraw
  rows, and less each fold-some's fold row `X` right before its partial revert `X.inverse`: one version, as `log()`
  lists it; laptop re-check P3), so a watch page can say "newer edits exist" (versions > 0; `head - at` from a host that sends no count) without
  reading them. `publications()` gives the same count as `versions` (and `newer`), as `log()` lists versions. A watch link's invite is scoped to the Published cut (`createInvite(project, "viewer", ttl, [cut])`): a scoped
  reader's hello for any other cut is refused before a row is sent.
- **Processes and the sync lease (§6.2):** many processes open one `carton.db`; only the lease holder (Cardboard's
  library worker, or `@carton/local`'s headless helper) connects and pushes. A write to a shared cut must reach the
  holder: `@carton/local` routes every `cb` and MCP write by the cut it changes (a fold's `into`), and one that
  changes a shared or handing-off cut, or shares one, goes to the live holder over the control socket, or to a
  helper it starts that takes the lease; only a write to a local cut with no holder commits in its own process
  (`local/src/client.ts` `submit`, `local/src/open.ts`; tests R3-03, R4-04, R5-06). A process that commits to a shared
  cut itself, without the lease, gets `pending`: the edit is kept in `carton.db` and pushed by the next holder to
  start, not by one already running (by design; `store-memory/test/shared-settle.test.ts`, "F5"); a running holder's
  settles leave that row alone until its id is confirmed. The holder passes
  its fence as `sync.connect({ nonce, fence, conditions })`: once replaced, it records nothing more and stops.
  `carton.pendingCount(cut?)` counts the edits waiting for a shared cut's server from the store, so any process on
  the project (one without sync too, like `cb` deciding whether a Save As may carry history) sees the holder's.
- **Pins across processes (windows-sync R1):** every pin row write carries a new token, `meta ["pinsGen"]`, in the same
  batch and conditioned on the token the writer holds, so a pin another process wrote since fails the write and the
  retry reads the pins again. The calls that refresh (`head()`, reads, every write) read that one key, and the whole
  pins table only when it moved: their cost no longer grows with the pins (a GUI save prints the shared file and pins
  it). A handle's own pin write leaves its snapshot and token current. A compaction reads the pins table always, as it
  keeps every pinned version, and its write is conditioned on the token it read: a pin another process writes while it
  plans fails that write, and the retry keeps the new pin too. A core from before the token writes pin rows alone: a
  handle of this core sees such a pin at its next open or rebuild, or after another process's pin moves the token; its
  compaction keeps one written before it read the pins, not one landing in between.
- **One schema per project:** the project's meta keeps `schemaFingerprint(schema)`; `Carton.open` refuses a process
  whose adapter has another document schema at the same schema version (its state hashes would differ, so refs and
  pins the processes make couldn't be checked by each other). Give every process on a carton.db the same adapter.
- **Concurrent writers** on one store never fail a write for being busy: a writer that keeps losing the append race
  takes the append turn (`lease` table, `["append-turn"]`), and the others wait for it (`#mutate`).
- **Keyframes (§5.4):** a cut's state is stored every K confirmed changes (`keyframeEvery`, default 64) or after 1 MiB
  of ops, in the same batch as the row, and at every named, fold, export and Published version. A new periodic keyframe
  replaces the previous periodic one; milestone ones stay. Opening reads each cut's newest keyframe and replays only the
  rows after it, and a local cut reads only those rows at open (verify-ci F1): open and `head()` don't grow with the
  log. Its older rows load in the background once open has returned (sync set up and all), newest first, a page of 4,096
  at a time with the event loop free between pages, or all that's left at once as soon as a call waits for them; a
  compaction by another process between two pages, or into rows the handle hasn't read yet, makes it read its history
  again, whole (rebuilds run one at a time: one asked for while another runs starts after it; a cut switch made
  meanwhile stays; one that fails leaves the history and its export cursor as they were). Everything that can reach them
  waits for them, so no call sees part of a history: `log`, `credits`, `diff`, `checkout`/`resolve`/`preview`,
  `undoStack`, every write (commit, fold, undo, restore, exports, imports, pins), `sync.waitFor` of a local change,
  setting up a cut shared since open, and connecting a cut that is handing off (its upload carries the history). A call
  that defaults to the current cut takes it before it waits, so switching cuts meanwhile doesn't move a commit. A commit
  right after open therefore pays the older rows once. A load that fails is the error of every call waiting on it, or of
  the next call if none was; the call after that loads again. `own()` throws until they're in. The handle holds the
  older versions as its background load reads them: a compaction another process makes before then squashes them for
  this handle too, as for one opened after it. Version names from the names table stay as they are (renamed since), and
  creators come out as a whole load at open gives them, with what was confirmed live meanwhile applied after, in its
  order (also through such a rebuild); a later rebuild gives them as a whole load does, as any rebuild did before.
  `head()`, `cuts()`, `pendingCount()` and `notices()` don't wait. `close()` stops the background load after the page
  under way (a call already waiting still gets every row), waits for it and drops its error, and clears the timer that
  starts it: nothing else holds a closed handle, so its history is freed once the caller drops it, also in a loop of
  opens and closes whose reads all resolve at once (route 40). A connect still waiting then gives up. Shared and tracking cuts, and a cut an older fork without its own fork
  state forks from, are read whole as before. Still O(changes), by design for now: that background read, and the
  in-memory log it fills (History indexes the whole log: change ids, creators, credits, undo). The full fix is a store
  index of change ids and an async History that pages old rows from the store on demand. A replica that caught up
  through a server keyframe fetches the rows it jumped and checks that they rebuild it before History takes them.
- **Retention (§5.4):** changes are kept forever. `compact({ cut?, olderThanDays = 90 })` is optional: on local cuts it
  squashes each old auto-version's micro-changes (a run of one actor, in one group and turn) into its last change.
  Named, fold, export, Published, undo, revert and restore versions, what they undid, fork points, folded-in and pinned
  versions, and the last K changes are never squashed. Seqs and ids stay; a squashed version leaves the log and its
  state is no longer held (`StateUnknown`). A fork keeps its own copy of its fork state, so a fork made from a version
  another process (or a handle that hadn't seen the compaction) squashes still opens. A handle holding rows that another
  process's compaction squashed into rows it hasn't taken in yet reads its history again when it takes them in (applying
  the squash on top of what it holds would lose what the run undid).

## Using it

```ts
import { Carton } from "@carton/core";
import { createMemoryStore } from "@carton/store-memory";
import { cardboardAdapter } from "@carton/cardboard";

const carton = await Carton.open({ adapter: cardboardAdapter, store: createMemoryStore(), init: { doc }, actor });
const pin = await carton.pin({ owner: "turn-42" });            // pin.header goes into the printed file
const r = await carton.commit({ doc: edited, base: header });  // {status: "confirmed", seq, ref} | pending | conflicts
const cut = await carton.fork("30s Instagram cut");
const folded = await carton.fold(cut.id, { into: carton.cut });
const { describe } = await carton.diff("main@1");
await carton.undo();                                             // ⌘Z for the actor's group
```

The engine functions (`merge3`, `diff`, `apply`, `shotDiff`, `describe`…) are exported from `@carton/core` for code
that works on docs directly.

## Size

`node scripts/size.mjs` checks the **history bundle** (esbuild minify, ESM, platform-neutral, gzip 9, bundling
`core/src/history/index.ts` so engine parts History doesn't use are tree-shaken, exactly as P4 measured the
prototype's 19.3 KB) against a **32 KB min+gz budget** (raised from 30 KB on 2026-11-01, below). `node scripts/size-attr.mjs packages/core/src <scratch>`
prints what each feature costs by stubbing it out (marginal bytes: a helper shared by two features counts only when both
are stubbed). At `46f4b34` (UNVERIFIED, bytes; deterministic, not load-dependent; each stubbed copy keeps the package's
`package.json`, so `sideEffects: false` applies as in the real package): the bundle is 82,084 min, 29,963 min+gz.

| Feature in the history bundle | min | min+gz | In the prototype's 19.3 KB? |
|---|---|---|---|
| Local sequencer, v11 rule (sync-sequencer's `evaluatePush`, shared with the server) | 11,890 | 3,977 | the v5 rule was 947 |
| `.cbproj` export/import and the hand-off closure, with the lineage walk they share | 5,473 | 1,691 | export/import yes |
| of which `.cbproj` alone (last authors, knowledge, copied-folder ids) | 4,292 | 1,317 | yes, without the last two |
| of which the hand-off closure alone (Stage F2/F3) | 1,046 | 308 | no |
| Undo by actor group, remaps inverted | 1,927 | 620 | no |
| Fold-some (atomic pre-check, inverse) | 1,913 | 610 | yes, without the pre-check |
| Portable SHA-256 (browsers and Workers have no sync digest) | 819 | 468 | no (node:crypto) |
| Pins with owner sets | 1,354 | 411 | simpler pins |
| Revert, restore, log, names | 1,185 | 329 | no |
| Refs: print, parse, any cut id | 771 | 333 | no |
| Views (R4-02) | 741 | 254 | yes |
| Credits (last author per record) | 846 | 236 | no |
| Remap stored as one op (P5) | 479 | 187 | no |
| Soft warnings on confirm (§4.1) | 413 | 128 | no |
| Frozen records handed out | 118 | 29 | no |
| Keyframe milestones | 120 | 29 | no |

The rest, about 20.7 KB (the bundle less these rows; gzip savings don't add exactly), is cuts, commit and rebase,
fold and the merge DAG, states, and the merge engine (merge3, remaps, diff, apply, hashing).
PLAN §7's split lineage, added after the table (a fold composes each side's splits and records them on its edges and on
`.cbproj` lineage edges; a track change reaches every piece; a retime of a split clip is a card): +136, 30,099.

**Why 32 KB (orchestrator, 2026-11-01).** The 30 KB budget was set at `c1d5488` (the bundle then 28,571). By `46f4b34`
it was 29,963: the shared-cut stages F1–F4 (+820), the review rounds and the e2e-qa, kit-docs, local-cli and
cardboard-adapter fixes, less 121 for the slimmed sequencer rule and 58 for one path-escaping helper in place of three.
Looked for and not found: dead code (every History method has a caller). Declined: error messages as codes (at most
about 450 bytes; they are what an app developer gets from public calls, and tests and other packages match them) and
dropping the portable SHA-256 (468; every browser and Worker host would need `setSyncHash` first). PLAN §7's split
lineage (a fold and a `.cbproj` edge carry it; a retime of a split clip is a card) takes the bundle past 30 KB, so the
budget is 32 KB: about 1.9 KB for the work still to come, and each raise is written up like this one. Still about 35
times smaller than Automerge's 1.14 MB gz of WASM (PLAN §19's figure). Verified: the proposal's numbers were re-measured
by a separate agent (`gfv-scratch/carton/verify-size/`).
