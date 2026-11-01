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
- **Say whether an `ifAbsent` put created the key** (recommended): mark the info it returns with `markCreated(info,
  created)` from `@carton/blob-memory/rules` (a non-enumerable `PUT_CREATED` symbol, so the info's JSON is unchanged).
  `serveSignedBlob` answers a create-only PUT by it, exactly, even when another writer raced to the same key with
  bytes of the same size. A wrapper that copies the info keeps the mark (`withCreated`). Without it, the host can only
  answer 200 when the client's `X-Carton-Sha256` and size match the kept object, and 412 otherwise. The suite checks
  the mark when a store opts in (`reportsCreated`).
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

A signed PUT takes two optional headers, neither signed, since each can only narrow what the URL allows:
`If-None-Match: *` makes it create-only, applied atomically by the store (`put`'s `ifAbsent`), and
`X-Carton-Sha256: <64 hex>` is `put`'s `sha256`: `serveSignedBlob` refuses a body that doesn't hash to it (400)
before writing, so every store gives the same guarantee (R2 checks it again), and the store keeps it for `head`.
`hostMediaBlobs` sends both. A client of its own (a browser's) should too, rather than a `head` before the PUT.

A signed PUT answers with the stored object's info as JSON (`key`, `size`, `etag`, `contentType`, `sha256`; `etag`
in its header too): 200 when its bytes went in, and 412, as S3 and R2 answer, when `If-None-Match: *` found the key
already there, with the earlier object's info and nothing written. So a create-only PUT needs no read-back: a
client takes the info from either answer (or, reading only the status, heads the key after a 412). The host heads
the key under the same per-key lock its other writes of the key take (host-http locks media keys, `m/<hash>`). A writer
outside that lock that creates the key in between still loses nothing: the store's `ifAbsent` keeps the first object,
and says whether this PUT created it (above), so of two create-only PUTs racing on one key exactly one gets 200,
whatever their bytes. A store that doesn't say gets 200 only when the PUT's `X-Carton-Sha256` proves the kept bytes are
its own, else 412. A `hostMediaBlobs` from before this takes the 412 for an error.

Not every PUT answer holds that info, so a client decides by the answer, not by which host signed the URL. A URL a
host presigns straight to its bucket (S3's or R2's presigned URLs, not `serveSignedBlob`) gets the bucket's answer:
200 with an etag and no body, or 412 with an XML error. So does a host from before this (200 and an etag, whatever
happened). `hostMediaBlobs.put` takes the info only from a JSON body holding a numeric `size`; without it, a
create-only PUT reads back with `head` (after a 200 as after a 412), and a plain PUT reports its own bytes with the
answer's etag. A client of its own should do the same.

On Node, `blob-s3` and host-http's clients (`hostMediaBlobs`, `hostMessageBlobs`) send their requests through
`@carton/http-node`, which uses `node:http` and `node:https` instead of the global `fetch`. When a server ended the
connection while a reader had paused the body, Node's built-in undici either crashed the process with an uncaught
`assert(!this.paused)` (CI #29) or left the read hanging forever; `node:http` rejects the read instead. A streamed
upload is held to its declared length. Redirects are followed as `fetch` follows them: Authorization,
Proxy-Authorization, Cookie and Host never go on to another origin, a Location with credentials is refused, and a
streamed body ends the request at any redirect but a 303. Workers and browsers use `fetch`, and a `fetch` passed in
the options is used as given. `packages/blob-s3/bench/transport.ts` compares the two transports' throughput (see its header to run it).

### One bucket, many projects

Wrap a store with `scopedBlobStore(store, "projects/<id>/")` (`@carton/blob-memory/scoped`), so a project can't name
another project's keys. Both hosts go one step further and give each project two scopes that no route can cross:
`projects/<id>/seq/` for the sequencer's keyframes, archived segments and large change bodies, and
`projects/<id>/media/` for what the HTTP API signs and uploads. An editor can write media, but never a record the
sequencer relies on, which may belong to a cut they may not write. A signed URL's MAC also covers its route
(`/blob/<id>/`), so a URL for one project never opens the same key under another.

S3 and R2 cap the whole key at 1,024 bytes, prefix included, so a scoped store takes keys up to 1,024 bytes less its
prefix: about 1,000 in a project's media scope. It refuses a longer one with `InvalidKey`, naming that limit.

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
`m/<hash>` over an object of the manifest's size is a no-op. Bytes need their manifest first, and must be the
manifest's size. A write that found nothing there is create-only, so if a teammate's upload lands first, even in
another process, that copy stays. A damaged object is removed only through the repair path, below. Proxy pointers
(`px/`) stay per project, because they don't verify themselves.

Known limits, on hosts of many processes (Workers) only: a multipart complete can't be made conditional, and neither
can the replacement of a wrong-sized object. So a teammate racing an upload there can leave bytes of the right size
but the wrong content. Every reader verifies each leaf against the manifest, so those bytes are never used. They are
reported, removed by the repair path and uploaded again. server-node serializes these writes per team.

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
   socket follows, its dead epoch, the actors it shows). If your host can evict a project while sockets stay open,
   as Durable Objects do, save `state` with the socket after each message that changed it.
   - **Presence leaves.** A client that crashes or loses its network never sends its `presence(null)`, so
     `disconnect` sends the branch's other subscribers `state: null` for each actor the connection still showed
     (`state.shown`, at most 4 actors). So call it for every way a socket ends, including a timeout. A client
     that lost its network sends no FIN either: drop a socket that has been silent for too long. server-node pings
     after `idleTimeoutMs` (30 s) of silence and drops the socket after as long again. The Durable Object closes a
     socket that shows presence and has neither sent anything nor pinged (its `ping` auto-response) for
     `PRESENCE_TIMEOUT_MS` (120 s). It checks from its alarm, every half of that, only while some socket shows
     presence. A socket's last message time rides in its attachment (written at most once a second), so a wake
     from hibernation is never taken for its activity. Maintenance keeps its own due time
     (`carton_room.maintain_at`), so these checks never run it early; a room whose alarm was set before that row
     existed takes the alarm as its due time. Presence still queued when its connection goes is dropped, never
     relayed. The conformance host suite drops a client and silences one (also across wakes), and checks that its
     peers see the leaves.
   - **People** (windows-sync R3). A GUI save's author is the generic person; the sequencer keeps each device
     credential's person (`hello.identity`, `identity`), so teammates resolve it by the change's replica id, which the
     sequencer already binds to that credential (§6.3). A host needs nothing more: the record is two of the
     sequencer's own tables (`people`, and an index on `rids` by credential), created like the rest on any storage,
     the Durable Object's included. The sequencer's rules: an identity's `id` must be the session's account
     (`forbidden` otherwise; the connection goes on), and its name is the person's own choice, 1–200 characters with
     no control characters (`bad-request`). Changes to a person are capped per connection (5, then one every 12 s),
     since any role may set one and each is a row and a message to everyone; the cap rides in the connection's state,
     so a Durable Object's wake doesn't reset it. Every welcome page that subscribes
     carries `people` (every person, with every rid bound to them; `[]` says the host keeps them); a person set or
     renamed, and a rid newly bound to a credential with a person (a hello's claim, a push, a hand-off's rows once its
     transaction commits), go to every connection of the project before the row the rid binds (as an envelope when
     big: a hello claims up to 4,096 rids). A reader scoped to some cuts (a Published cut's watch link) gets
     `people: []` and no `people` messages: a link never tells a stranger the team's accounts and names. The
     conformance host suite checks the refusal, the order, a rename, the cap across a wake, and that the people survive
     a hibernation and a restart.

     **Known limit: a watch link's viewers see the generic person.** The privacy rule above has a cost: in a Published
     cut, every change saved from the GUI shows its author as the generic person, never by name, while editors of the
     same project see the names. A later option is to send a watch link only the display names of the authors in its
     cut, keyed by the rids of that cut's rows and never with account ids, so its viewers see who made the cut without
     learning the team's accounts or anyone outside the cut.
4. **Keeps the rest thin:**
   - pass the newest document `schemaVersion` it accepts to `createSequencer`, so a newer client is refused at
     `hello`. Take the default from the adapter the host ships with (`CARDBOARD_SCHEMA_VERSION` from
     `@carton/cardboard`), as server-node and server-cloudflare do: a hard-coded number goes stale at the adapter's
     next bump and the host then refuses every client (H-SV). An operator may pin a version (server-node's
     `schemaVersion`, the Worker's `SCHEMA_VERSION`). The rule for a client newer than the host: it is refused with
     an error saying to update the server, and the sync client emits it as an `error` event for the app to show. A
     host never accepts a version it wasn't built for, because it can't vouch for documents it doesn't know;
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
   ranged reads and PUTs, resumable multipart through the session's routes, `reportDamaged(key, leaf)`, and
   `heads(keys)`.
   `handleHttp` stops reading a body at its budget and answers 413 with the rest of the body unread. A host on
   `node:http` must then close the connection, or a client that keeps it in its pool sends its next request on it
   and gets ECONNRESET; and it must close in stages (RFC 9112 §9.6), never at once: closing a socket with unread bytes
   resets the connection, and on Windows the reset loses the 413 before the client reads it. server-node answers
   `connection: close`, half-closes after the answer, then reads and drops the rest (never kept) until the client
   closes its side, 16 MiB have come or 5 s have passed. The body's reader must stop without destroying the request
   (cancelling `Readable.toWeb(req)` does): node's parser stops reading the socket for a destroyed request, so a
   chunked body's rest sits unread and the close ends in a reset.

   **Many heads at once (REQ-11).** Media parts live in one flat namespace (`m/<hash>`), so checking that a long
   stream's parts are all there took one HEAD each, about 2,000 requests for a 2,000-part stream.
   `POST …/blobs/heads {keys}` takes up to 1,000 keys and 1 MiB of JSON (1,000 keys of the longest a store takes
   fit), and answers `{blobs}`: one entry per key, in order, `{size}` or null. HEAD's rules hold for the whole
   batch: one key that is invalid or outside the session's scope (a watch link reads only media named by content and
   its cut's files) refuses all of it (400, 403) before any store call, and an editor's batch claims team objects as
   its HEAD does. Keys are checked by the store's own rules where it states them (`checkKey`, `ChecksKeys` in
   `@carton/blob-memory/rules`: a scoped store's prefix leaves less than 1,024 bytes). A store call that fails ends
   the batch: no head starts after it, and the answer waits for those already started. A host
   answers for at most `maxBlobHeads` keys (default 1,000), a prefix of them, and the client asks again for the rest.
   The Worker checks 200 a request (`BLOB_HEADS_PER_REQUEST`), since each key costs one to four R2 calls and
   Cloudflare limits a request's subrequests. `hostMediaBlobs.heads(keys)` does the splitting, follows a smaller
   budget, and on a host from before the route makes one HEAD per key. It isn't part of BlobStore, so code that takes
   any store looks for it (`hasHeads(store)` from `@carton/host-http/client`). Through server-node, a 2,000-part
   check is then 2 requests; through the Worker, 10.

   **The repair path (§11).** A reader whose leaf never verifies reports it with `POST …/blobs/damaged {key, leaf}`.
   The host loads the manifest, which the hash itself verifies, re-reads that leaf, and removes the object only if
   its stored bytes really are wrong and it wasn't replaced meanwhile. The owner's next share then finds it missing
   and uploads it again. A report can't remove a sound object. Writes of that key through the API wait for a check
   in progress, and the check waits for them, within one process. The lock is per store scope: a team's media, which
   its projects share, or one project's. Another project's write of the same hash doesn't wait. On a host of many processes (Workers) a write
   served by another one can still land between the check and the delete, since BlobStore has no conditional
   delete; that write is undone, and the uploader's next share uploads it again.

   **Signed URLs** are built from the request's origin, so build the `Request` with the address the client used. A
   URL carrying an internal address can't be reached from outside. server-node takes, in order: `publicOrigin`;
   `X-Forwarded-Host`/`-Proto`, only with `trustProxy` (a client could otherwise choose them); a well-formed `Host`
   header; the listen address. A Worker's request URL already carries the client's host. So a Node host that clients
   reach directly (as `localhost`, a LAN name or an IP) needs no setting; behind a reverse proxy or a tunnel that
   rewrites `Host`, set `trustProxy` if the proxy sets `X-Forwarded-Host`, or else `publicOrigin` to the address
   clients use.

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
answered by the runtime without waking the room, so idle sockets cost nothing. While a socket shows presence, the
alarm wakes the room every `PRESENCE_TIMEOUT_MS / 2` (60 s) to check for silent sockets. Each check reads one row,
the maintenance due time, and sets the alarm; it writes no table rows.

Each `POST …/blobs/heads` key is one R2 call (a team project's editor: up to four, for the claim and the grant
check). The Worker checks at most 200 keys a request, under Cloudflare's per-request subrequest limit; raise
`BLOB_HEADS_PER_REQUEST` (to 1,000 at most) if your plan's limit allows more.

## Windows

The hosts and stores are written for Windows too, though this repo can test them only on Linux:

- `blob-fs` retries renames and deletes on EPERM, EBUSY and EACCES while another handle has the file open (see
  `scripts/rename-retry.js`). Windows can't fsync a directory, so it skips that, and NTFS journals the rename.
- Keys and project ids map to file names that are safe on NTFS and case-insensitive volumes.
- `server-node` uses only `node:*`, and the wrangler test harness kills its process tree with `taskkill /T`.

Still unchecked on Windows: the EPERM retry timing under a real reader, paths longer than 260 characters through
Node's long-path handling, and `wrangler dev` itself.
