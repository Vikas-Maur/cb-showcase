# @carton/store-sqlite

Carton's `Store` plug-in on `node:sqlite` (Node 24, Electron 43): a project's history in `.carton/carton.db`
(SQLite, WAL), shared by every process on the machine: the app's engine thread, `cb`, MCP, the sync helper.

```ts
import { openProjectStore, importProject } from "@carton/store-sqlite";

// Where the plan says carton.db lives (§6.4, L15), moved there if that changed since the last open.
const { store, location } = await openProjectStore({ bundleDir, projectId, appDataDir });
if (!location.inBundle) showWarning(location.warning); // cloud-synced folder, network share, FAT/exFAT

// An existing 1.4.0 project comes in as main@1 (§16); safe on every open.
const { carton } = await importProject({ bundleDir, projectId, appDataDir, adapter, host: () => readProjectJson() });
```

## Options (`openSqliteStore(path, opts)`, `openProjectStore(opts)`)

| option | default | meaning |
|---|---|---|
| `busyTimeoutMs` | 5000 | How long a read or write waits for another process's lock before `BusyError`. The wait is asynchronous: the event loop keeps running (P3b). |
| `syncBusyMs` | 3 | SQLite's own (blocking) busy wait per attempt. |
| `durability` | `"normal"` | `"normal"`: WAL + `synchronous=NORMAL`. A crash of the app or the OS loses nothing committed; a power cut can lose the last commits, never half of one. The ≤ 5 ms write-lock target (§6.2) is for this mode. `"full"`: every commit is fsynced, **and the write lock is held across that fsync, so lock time depends on the disk** (above 5 ms in 5 of 14 runs on a GitHub runner, verify-ci S3). That is inherent: a commit must be on disk before the lock is released. |
| `readOnly` | `false` | Read without ever writing (no placement move either). |
| `appDataDir` | per-OS local app data | Where carton.db goes when it can't live in the bundle, and the project's placement lock. **Every process opening a project must pass the same value.** |

WAL checkpoints never run inside a commit: SQLite's automatic one is off, and a passive checkpoint runs on its own
turn of the event loop (after 1,000 writes, every 30 s, and at open). It costs the calling thread a few ms to tens of
ms now and then, never the write lock.

## Errors a host should handle

| error | `code` | what to do |
|---|---|---|
| `BusyError` | `CARTON_DB_BUSY` | Another process held the lock longer than `busyTimeoutMs`. Retry later. |
| `MovedError` | `CARTON_DB_MOVED` | This handle's file was moved to `.to` by another process (placement change). Reopen through `openProjectStore`. |
| `PlacementConflictError` | `CARTON_DB_PLACEMENT_CONFLICT` | Two separate histories at `.paths`. Carton never picks one: show both to the user. |
| `UnwritableHistoryError` | `CARTON_DB_UNWRITABLE` | The history at `.path` can't be written (read-only file or attribute, ACL, folder), so it can't be moved where it belongs now. Nothing was copied. Ask the user to make it writable. |

`location.setAside` is set when a carton.db made on another machine was found where this project's history goes: it
was renamed `carton.from-<host>-<time>.db` and a fresh history started. Offer it to the user as that person's history.

## Windows

Paths may be non-ASCII; renames retry while antivirus holds a new file; sync roots come from `reg export`
(UTF-16) and are cached for 10 minutes in app data; mapped network drives are detected through their UNC path.
