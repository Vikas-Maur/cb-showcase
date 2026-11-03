# Carton

Git for video, plus live collaboration, for Cardboard. One dependency-free TypeScript module (`@carton/*`) that runs in
Electron and Node (Mac, Windows, Linux), in browsers and in Cloudflare Workers. The plan is
`_inspect/git-for-video/PLAN.md` (v14, not in the repo); the contracts every package builds on are in
[CONTRACTS.md](CONTRACTS.md).

## Words

Carton uses editors' words in the app, the CLI and the docs. Agents think in git, so each word's git name is here.

| Carton word (app and CLI) | git's word | Meaning |
|---|---|---|
| **Version** | commit | A saved point, made after every save batch and every Director turn. It can be named ("Sent to client, Monday"). Chat checkpoints are versions |
| **Cut** | branch | A separate line of the edit: "Main cut", "30s Instagram cut". Only the edit is copied. Cardboard's "3 variants" = 3 cuts |
| **Director's cut** | agent's pull request | Review mode: the Director works in its own cut, and you accept all of it, part of it, or none |
| **Fold in** | merge | "Fold into Main". Partial accept is "fold in some of it" |
| **Conflict card** | merge conflict | Both edits kept; you pick |
| **Published cut** | release tag | What the share link shows |
| **Changes** (Compare with your edit), **Play**, **Before** | diff | The changes between two versions in words, each one playable on the stage, and how it was before at the same moment (`cb compare` lists them) |
| **Restore** | revert / checkout | Saved as a new version |
| **Undo turn** | revert by author | Undo scoped to you and the agents acting for you |
| **Credits** | blame | Who changed a clip, down to the subagent |
| **History** | log | The list of versions (extends `cb history`) |
| **Live** | (none) | People and agents editing one cut at once, with presence |
| **Invite to edit** | clone / remote | The existing share link stays watch-only |
| **Syncing · Up to date · Offline: N edits waiting** | push / pull | Status words only |
| **Bring in their changes** | pull from a bundle | Fold in a teammate's `.cbproj` |

`cb` accepts the git words as aliases: `branch` → `cut`, `merge` → `fold`, `log` → `history`, `blame` → `credits`,
`revert` → `restore`. In code, terms with no UI meaning keep their names: change, sequencer, pin, StateRef, seq.

## Packages

| Package | What it is |
|---|---|
| `@carton/core` | Engine (apply, diff, merge3, sequences, remaps, validators, shot diff, describe), history (versions, cuts, DAG, undo), the sequencer rule, the sync client, and the plug-in contracts (`@carton/core/plugins`) |
| `@carton/store-memory`, `store-sqlite`, `store-idb` | `Store` plug-ins |
| `@carton/server` | The pure sequencer core (`createSequencer`) |
| `@carton/server-node`, `server-cloudflare` | `SequencerHost` plug-ins |
| `@carton/blob-memory`, `blob-fs`, `blob-s3` | `BlobStore` plug-ins |
| `@carton/media` | Media hashing, tiers, uploads, proxies |
| `@carton/cardboard` | `HostAdapter` for Cardboard 1.4.0 |
| `@carton/local` | Carton on one machine: carton.db, lease, materializer, views, `.cbproj` |
| `@carton/cli-mcp` | `cb` commands and MCP tools |
| `@carton/react` | Headless hooks and unstyled components (Preact-compatible) |
| `@carton/conformance` | One suite per plug-in, plus the engine and system suites |

## Working in the workspace

Node 24 runs the `.ts` sources directly, so there is no build step for tests.

```sh
cd carton
npm install
npm test            # every package (node --test, at most 2 files at a time)
npm run typecheck   # tsc per package
npm run size        # min+gz budgets (esbuild)
npm run build       # dist/ for publishing, dependencies first
```

- Erasable TypeScript only (no `enum`, `namespace`, parameter properties); relative imports carry `.ts`.
- Core, the stores, `local`, `cardboard`, `media` and `react` have no runtime dependencies. Hosts use only their
  platform.
- `tsconfig.base.json` compiles against ES2023 + WebWorker (APIs every target has); Node-only packages extend
  `tsconfig.node.json`, browser packages `tsconfig.dom.json`. Tests always get Node types.
