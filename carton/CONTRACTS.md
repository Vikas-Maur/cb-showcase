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
| `BlobStore` | put/get (ranges)/head/delete/list, multipart with resume | blob-r2, blob-s3, blob-fs, blob-memory |
| `AuthProvider` | `verify(token)` → `{account, credential, role, projectId, branches?, expires}` | demo HMAC (server) |
| `Hasher` | async `sha256(bytes)`, optional `sha256HexSync(text)` (core uses it for state hashes) | node:crypto (local), WebCrypto |
| `ProxyEncoder` | `probe()`, `encode(input, output, profile)` | Cardboard proxy, NVENC → QSV → AMF → libx264 |
| `IdentitySource` | `current(env)` → `Actor` | Claude Code hooks / `CARDBOARD_ACTOR` (cardboard) |
| `HostAdapter` | `schema`, `fromHost`, `toHost`, `project`, `projectGuiSave` | cardboard |

## Formats to keep exactly

- **Change ids** are `<rid>.<n>` with a 96-bit random `rid` per process (hex). Dedup is by id; ids survive rebases.
- **Refs** print as `main@57~3f9a1c0e b:<branchId8> p:<printNonce> by <actor>`; a bare 13-digit number is a 1.4.0
  timestamp rev. Node ids are `<branchId>@<seq>`.
- **Path keys** join segments with `/`, escaping `~` → `~0` and `/` → `~1`. Field-group paths end in `#<group>`
  (`timelineItems/X/#time`). Sequences order by the `#pos` field.
- **Spans** are half-open `[lo, hi)`; `hi: null` is open-ended (a remap's `[t0, ∞)`).
- **Hashes** are SHA-256 hex over `canonical()` JSON (sorted keys, `undefined` dropped).
- **Policy** is `"merge"` (the plan's `cas`) or `"lww"`; `lww` on a change with a span or group path is rejected.

## Carton handle notes

- **Refs** passed to `checkout`, `diff`, `fold`, `restore`, `preview` may be a printed header, a `StateRef`, a node id
  `"<cutId>@<seq>"`, or a cut id (its head). A ref that can't be rebuilt exactly throws `StateUnknown`.
- **Creating a project:** `init: { doc }`, or `init: { import: shallowExport }` for a teammate's `.cbproj` of a project
  this machine doesn't have.
- **Commits** are idempotent by `id`, accept a held base (`{baseDoc, baseSeq, causal}`) and extra Store `conditions`
  (a lease fence); a lost cross-process append race rebuilds from the store and retries.
- **Shared cuts** (`sequencer.kind !== "local"`) and `carton.sync` are wired by the sync client (sync-sequencer);
  until then they throw. `carton.media` is null: `@carton/media` calls Carton, not the reverse.

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
prototype's 19.3 KB) against a **30 KB min+gz budget**. `node scripts/size-attr.mjs packages/core/src <scratch>`
prints what each feature costs by stubbing it out. At `7e2f3f7` (UNVERIFIED, bytes min+gz; deterministic, not
load-dependent):

| Feature in the history bundle | min+gz | In the prototype's 19.3 KB? |
|---|---|---|
| Local sequencer, v11 rule (sync-sequencer's `evaluatePush`, shared with the server) | 4,069 | the v5 rule was 947 |
| `.cbproj` shallow/full export and import, last authors | 1,814 | yes |
| Fold-some (atomic pre-check, inverse) | 587 | yes, without the pre-check |
| Undo by actor group, remaps inverted | 550 | no |
| Portable SHA-256 (browsers and Workers have no sync digest) | 469 | no (node:crypto) |
| Pins with owner sets | 390 | simpler pins |
| Views (R4-02) | 236 | yes |
| Log, names, restore | 216 | no |
| Remap stored as one op (P5) | 191 | no |
| Soft warnings on confirm (§4.1) | 128 | no |

The whole bundle is 28.6 KB: 3.1 KB over the prototype is the v11 rule, the rest is the behaviour the plan and the
five review rounds require (stable ids and no-op ids, Published-cut guard, lineage checks, atomic fold-some).
