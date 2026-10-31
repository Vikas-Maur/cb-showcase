# Writing a Carton plug-in: a new host or blob store

Carton has no favourite cloud. Cloudflare is one host among others, and so is R2 among blob stores. The ordering rules
live in one pure function (`createSequencer` in `@carton/server`). Every outside service sits behind a small
interface in `@carton/core/plugins`. A plug-in is accepted when it passes its conformance suite in
`@carton/conformance`, and nothing else in Carton changes (PLAN §3.1).

This page covers the two plug-ins that face the network:

- a **SequencerHost**: where shared cuts are sequenced, such as Cardboard's own API, Fly, Supabase or on-prem;
- a **BlobStore**: where media, keyframes and archived change segments live, such as Cardboard's GCS, B2 or MinIO.

Two of each ship, so the boundary is tested and not only drawn:

| Interface | Ships as | Suite |
|---|---|---|
| `SequencerHost` + `SequencerStorage` | `server-cloudflare` (Worker + one Durable Object per project), `server-node` (node:sqlite) | `sequencerHostSuite`, `sequencerStorageSuite`, `transportSuite`, `httpApiSuite` |
| `BlobStore` | `blob-r2` (in server-cloudflare), the DO-blob fallback `BlobVault`, `blob-s3`, `blob-fs`, `blob-memory` | `blobStoreSuite` |
| `AuthProvider` | the demo HMAC tokens (`createHmacAuth` in `@carton/server`) | `authProviderSuite` |
| `Transport` | WebSocket (`webSocketTransport`), in-process | `transportSuite` |

## The checklist is the suites

You are done when your plug-in passes these, unchanged:

```ts
import { blobStoreSuite, sequencerHostSuite, transportSuite, sequencerStorageSuite, httpApiSuite, authProviderSuite } from "@carton/conformance";
```

Each suite registers `node:test` tests. Every test checks one invariant written on the interface in
`core/src/plugins.ts`, and its comment says which. Don't skip a test to make a suite pass. A test may skip itself
only when the plug-in doesn't offer an optional feature (`getStream`, `signedUrl`, `restart`, `rows`).

## A new BlobStore

### The interface

```ts
interface BlobStore {
  readonly kind: string;
  put(key, data: Uint8Array, opts?: { contentType?; sha256?; ifAbsent? }): Promise<BlobInfo>;
  get(key, range?: { offset; length? }): Promise<Uint8Array | null>;
  getStream?(key, range?): Promise<ReadableStream<Uint8Array> | null>;
  head(key): Promise<BlobInfo | null>;
  delete(key): Promise<void>;
  list(prefix, { cursor?, limit? }): Promise<{ blobs: BlobInfo[]; cursor? }>;
  createMultipart(key, { contentType? }): Promise<MultipartUpload>;
  resumeMultipart(key, uploadId): Promise<MultipartUpload>;   // after a restart or a cut link
  signedUrl?(key, { method: "GET" | "PUT"; expiresIn }): Promise<string>;
}
```

### Rules every store keeps

Use `@carton/blob-memory/rules` for the argument checks, so a bad call fails the same way everywhere, before any I/O:
`checkKey`, `checkRange`, `checkPartNumber`, `checkCompleteParts`, `BlobError`.

- **Keys** are opaque, up to 1,024 bytes of UTF-8, and case-sensitive: `Clip.MP4` and `clip.mp4` are two objects. A
  store on a file system must encode keys itself; see `blob-fs/src/keys.ts` for NTFS and APFS (case-insensitive),
  Windows device names, `..`, and long names.
- **Two things Carton's keys never need**, because POSIX-backed S3 servers refuse them (VersityGW, MinIO): an object
  at `a` beside objects under `a/`, and a single path segment over 255 bytes. AWS, R2 and blob-fs allow both. The
  suite checks the first only when a store doesn't opt out (`objectsBesideFolders`), and builds its 1,024-byte key
  from short segments.
- **Ranges** return exactly `[offset, offset + length)`, clipped at the end. A range at or past the end, or of length
  0, is an empty array, not an error. R2 throws there, so `blob-r2` translates.
- **Replacing** is atomic: a reader sees the old bytes or the new, never a mix. `ifAbsent` never touches existing
  bytes.
- **Your buffers are yours.** A blob is the bytes at put time: copy, or never keep the caller's array.
- **Multipart:** parts are numbered 1–10,000. All parts but the last have the same size, and the last is no larger,
  as R2 requires. S3 and R2 need parts of at least 5 MiB except the last. `complete` joins the parts in part-number
  order. Re-uploading a part replaces it, and the old etag no longer completes. `listParts` must work on a handle made
  with `resumeMultipart(key, id)` alone. A bogus, aborted or completed id fails. An upload is bound to its key:
  through another key, `listParts` and `complete` fail and `abort` leaves it alone. Behind a scoped store an upload
  id is all another project would need otherwise.
- **`sha256`** is the real hash of the bytes. A store may verify it, as R2 does, and refuse a mismatch.

### Running the suite

```ts
// my-store.test.ts
import { blobStoreSuite } from "@carton/conformance";
blobStoreSuite("my-store", async () => createMyStore(config), {
  minPartSize: 5 * 1024 * 1024,        // if your service has a minimum part size
  cleanup: async () => { /* drop the bucket or folder */ },
});
```

The suite puts every key under a random `conf-…/` prefix and deletes them afterwards, so a real shared bucket is fine.
For signed URLs, pass `fetch` (or let it use the global one) and `expiryWaitMs` to also check expiry.

### Stores that can't presign

R2's binding, the DO-blob vault and `blob-fs` can't presign. They take a signer from `@carton/blob-memory/signed`
(`createBlobUrlSigner`), and the host mounts `serveSignedBlob` on `/blob/<project>/…`. That route serves GET and HEAD
with single HTTP ranges, so a `<video>` element or ffmpeg can seek, and also PUT. `blob-s3` presigns with SigV4
instead.

### One bucket, many projects

Wrap a store with `scopedBlobStore(store, "projects/<id>/")` (`@carton/blob-memory/scoped`), so a project can't name
another project's keys. Both hosts go one step further and give each project two scopes that no route can cross:
`projects/<id>/seq/` for the sequencer's keyframes, archived segments and large change bodies, and
`projects/<id>/media/` for what the HTTP API signs and uploads. An editor can write media, but never a record the
sequencer relies on, which may belong to a cut they may not write. A signed URL's MAC also covers its route
(`/blob/<id>/`), so a URL for one project never opens the same key under another.

### Media dedup within a team

§11 dedups whole files within a team. It is off by default: without a team, each project's media stays in
`projects/<id>/media/`. Give a host the team of each project (server-node's `teamOf(projectId)` option; on Cloudflare
the `TEAMS` var, a JSON object from project id to team id, R2 only) and a project's media bytes and manifests
(`m/<hash>`, `mf/<hash>`) are kept once under `teams/<team>/media/`, through `projectMediaStore` from
`@carton/host-http`.

**The grant model.** A project reads a team object only after it holds a grant for that hash
(`projects/<id>/grants/<hash>`, a scope no route reaches). Ideally a grant would follow the project's own media
records, but a host can't read documents. A project gets a grant in two ways:

- it uploads the object, so it had the bytes;
- one of its editors checks for the object (the media API's `head`) and the team already holds it. Editors are the
  people who write media records: an editor could put that hash into a record, and every reader of the project
  would then stream it. So this gives editors nothing a record wouldn't, and it is what lets a second project's
  upload find a teammate's copy and send nothing.

What follows from that:

- Grants never cross teams. A project only ever sees its own team's scope.
- Viewers and commenters can't claim. They read only what their project was granted, and every read checks the
  grant, so a signed URL for an ungranted hash finds nothing.
- Grants are never revoked. A project that drops a media record keeps access to bytes it once had.

A sound team object can't be replaced from another project: a manifest must verify against its hash, and a write of
`m/<hash>` over an object of the manifest's size is a no-op. A damaged object is removed only through the repair
path, below. Proxy pointers (`px/`) stay per project, because they don't verify themselves.

## A new SequencerHost

### What a host does, and what it never does

A host is storage plus socket glue. It never orders, validates or merges; `createSequencer` does all of that, and
every host runs the same function. The host:

1. **Gives the sequencer storage.** A `SequencerStorage` is synchronous SQL: `exec(sql, ...params) → rows` and
   `transaction(fn)`. It needs SQLite semantics: `WITHOUT ROWID` tables, primary-key range reads, and BLOBs as
   `Uint8Array`. Commits must be durable before the next message is answered, because an ack promises the change is
   confirmed. Use one database per project, the unit the Durable Object has. If you can count rows read and written,
   offer `stats()`; the suites then check that the host adds no rows of its own.
2. **Authenticates before the sequencer sees anything.** Get the token from `Authorization: Bearer`, or from the
   `carton.auth.<token>` WebSocket subprotocol, which browsers need (`tokenFromRequest`). Run `auth.verify`, check
   that `projectId` is the project in the URL, and answer the subprotocol `carton.v1` only. Never echo the token.
3. **Feeds connections.** A connection is `{ id, auth, state, send }`. Call `sequencer.handle(conn, msg)` for each
   JSON text message, `sequencer.disconnect(conn)` on close, and `sequencer.attach(conn)` for every socket that
   survives a restart or hibernation, with its saved `state`. The sequencer mutates `conn.state` (the branches a
   socket follows, its dead epoch). If your host can evict a project while sockets stay open, as Durable Objects do,
   save `state` with the socket after each message that changed it.
4. **Keeps the rest thin:**
   - pass the newest document `schemaVersion` it accepts to `createSequencer`, so a newer client is refused at
     `hello`;
   - pass `blobs` to `createSequencer`. Any message over 1 MiB, either way, then travels as an envelope through the
     blob store, so no message gets near a WebSocket's limit, whatever the project's size. The host carries
     envelopes like any other message; `@carton/host-http` gives clients the two routes they need (below). Cap one
     message by what your host can hold, since a message of N bytes holds about 3N while it is handled. server-node
     takes 64 MiB, the sequencer's default. A Durable Object, with 128 MB, takes 24 MiB (`MAX_ENVELOPE_BYTES`) on
     its socket, on its envelope reads and on the Worker's upload route alike;
   - answer a `ping` text frame with `pong`;
   - close a socket whose token expired with 4001, so the client refreshes and reconnects with the same credential
     and its replica ids. Check before every outgoing message, so a silent subscriber stops getting rows too;
   - call `sequencer.maintain()` on a timer or alarm, never on a push. It archives old rows to gzip segments (§18's
     defaults: rows older than the newest 10,000, in segments of 10,000) and sweeps expired envelope blobs. Envelope
     blobs expire hours after they were made, so keep sweeping after activity stops, and also when an upload came
     with no socket. The Durable Object re-arms its alarm while envelopes remain, and an upload arms it. server-node
     sweeps every project from a host-level timer;
   - never close a project's storage, or let a second sequencer open it, while a `handle` or `archive` is still
     waiting on the blob store.
5. **Serves the HTTP API** by mounting `handleHttp(request, deps)` from `@carton/host-http` (web-standard
   Request/Response). It covers join, refresh, invites, signed media URLs and resumable uploads, so clients talk to
   every host the same way. Supply your WebSocket upgrade and two blob scopes per project: `blobsFor` (media) and
   `sequencerBlobsFor` (the sequencer's own). Of the sequencer's scope, the API reaches only the envelope keys:
   `PUT /api/projects/<p>/messages/messages/c/…` (a writer's upload) and `GET …/messages/messages/s/…` (the
   server's). A client passes `hostMessageBlobs({ origin, projectId, token })` from `@carton/host-http/client` as
   its sync client's `blobs`, and `hostMediaBlobs({ origin, projectId, token })` as `@carton/media`'s store: signed
   ranged reads and PUTs, resumable multipart through the session's routes, and `reportDamaged(key, leaf)`.

   **The repair path (§11).** A reader whose leaf never verifies reports it with `POST …/blobs/damaged {key, leaf}`.
   The host loads the manifest, which the hash itself verifies, re-reads that leaf, and removes the object only if
   its stored bytes really are wrong and it wasn't replaced meanwhile. The owner's next share then finds it missing
   and uploads it again. A report can't remove a sound object. Writes of that key through the API wait for a check
   in progress, and the check waits for them, within one process. On a host of many processes (Workers) a write
   served by another one can still land between the check and the delete, since BlobStore has no conditional
   delete; that write is undone, and the uploader's next share uploads it again.

   **Signed URLs** are built from the request's origin, so build the `Request` with the address the client used. A
   URL carrying an internal address can't be reached from outside. server-node takes, in order: `publicOrigin`;
   `X-Forwarded-Host`/`-Proto`, only with `trustProxy` (a client could otherwise choose them); a well-formed `Host`
   header; the listen address. A Worker's request URL already carries the client's host.

The two shipped hosts are short and worth reading first:

- `server-node/src/host.ts`: `node:http`, one room per project, rooms closed when idle.
- `server-cloudflare/src/room.ts` and `worker.ts`: the Hibernation API, alarms, and the Worker in front.

`@carton/server`'s `createInProcessHost` is the smallest reference.

### Running the suites

```ts
import { sequencerHostSuite, transportSuite, sequencerStorageSuite, httpApiSuite } from "@carton/conformance";

sequencerHostSuite("my-host", async () => ({
  host,                                  // { kind, url: "wss://…/api/projects/<p>/ws", close }
  transport: webSocketTransport(),       // from @carton/server-node: standard WebSocket, any runtime
  auth,                                  // an AuthProvider that can issue tokens for the tests
  token: (role) => auth.issue({ … }),    // a fresh device credential per call
  tokenFor: (o) => auth.issue({ … }),    // this exact credential: a reconnect of the same device
  restart: async () => { /* restart on the same storage */ },
  rows: async () => ({ rowsRead, rowsWritten }),
  close: async () => {},
}));
transportSuite("my-host", sameFixture);
sequencerStorageSuite("my-sql", async () => myStorage(), { reopen });
httpApiSuite("my-host", async () => ({ origin, adminToken, minPartSize }));
```

If your SQL only runs inside your platform, the way DO SQLite runs only in workerd, run `storageChecks()` from
`conformance/src/hosts/storage-checks.ts` there. It needs no test runner. `server-cloudflare/test/test-worker.ts`
does this and returns the results to Node.

The system suite (`systemSuite` in `@carton/conformance`, by sync-sequencer) then runs the full protocol scenarios
through the same fixture.

## Running the shipped hosts locally

**Node:**

```ts
import { startNodeHost } from "@carton/server-node";
import { createHmacAuth } from "@carton/server";
import { createFsBlobStore } from "@carton/blob-fs";

const secret = process.env.CARTON_SECRET!;                  // at least 32 random bytes, from the environment
const host = await startNodeHost({
  dataDir: "./carton-data", auth: createHmacAuth({ secret }), secret,
  blobs: createFsBlobStore({ root: "./carton-blobs" }),     // or createS3BlobStore({...}) for S3, R2, GCS, B2
  adminToken: process.env.CARTON_ADMIN_TOKEN, port: 8787, staticDir: "./web",
});
```

blob-fs's object paths and server-node's room files are pre-release layouts: until Carton's first release they may
change without a migration. After it, any change to them ships with one.

**Cloudflare, local only:** run `npm run dev` in `packages/server-cloudflare`, which starts `wrangler dev`. Copy
`.dev.vars.example` to `.dev.vars` first. `wrangler.toml` binds R2. Remove the `[[r2_buckets]]` block to run on the
DO-blob fallback (L11). Deploying needs the user's go-ahead; `wrangler deploy` is never part of the build.

The first owner of a project comes from the admin token:

```sh
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -d '{"role":"owner"}' http://127.0.0.1:8787/api/admin/projects/my-project/invites
```

The answer holds an invite. Exchange it with `POST /api/projects/my-project/join {invite, account, installKey}` for a
session. The install key is the device's own secret, kept in the OS keychain or app data and never in the bundle.
The session's credential is `account/<hash of the install key>`, and replica ids are bound to it (§6.3).

## Cost on Cloudflare's Free plan

Durable Object SQLite bills rows written: 100,000 a day on the Free plan (L6). The host suite checks that the hosts
add none of their own. Measured in a local `ProjectRoom`, with wrangler dev counters:

| Message | Rows written |
|---|---|
| Style edit, trim, LWW edit, remap (P5) | 1 |
| Clip insert or remove | 2 |
| A device's first `hello` (its replica-id claim) | 1, once |
| A later `hello` | 0 |
| Presence | 0 (relayed, never stored; a client sends at most 10 a second, coalesced, and the sequencer drops anything over 20 a second per connection) |
| Archiving a change to a blob segment | +1 (a DELETE is billed like an INSERT) |

Archiving is the line to watch: every archived row costs one more row written. `maintain()` follows §18 (rows
older than the newest 10,000, in gzip segments of 10,000), so a branch pays it only once it has more than 20,000
live changes. `ARCHIVE_KEEP` and `ARCHIVE_SEGMENT` override it. The WebSocket keepalive (`ping` → `pong`) is
answered by the runtime without waking the room, so idle sockets cost nothing.

## Windows

The hosts and stores are written for Windows too, though this repo can test them only on Linux:

- `blob-fs` retries renames and deletes on EPERM, EBUSY and EACCES while another handle has the file open (see
  `scripts/rename-retry.js`). Windows can't fsync a directory, so it skips that, and NTFS journals the rename.
- Keys and project ids map to file names that are safe on NTFS and case-insensitive volumes.
- `server-node` uses only `node:*`, and the wrangler test harness kills its process tree with `taskkill /T`.

Still unchecked on Windows: the EPERM retry timing under a real reader, paths longer than 260 characters through
Node's long-path handling, and `wrangler dev` itself.
