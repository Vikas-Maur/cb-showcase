// SequencerHost for Cloudflare (PLAN §3.1, §17): a Worker (auth, API, static web client) in front of one SQLite-backed
// Durable Object per project (`ProjectRoom`, Hibernation API), with R2 blobs or a DO-blob fallback (`BlobVault`). The
// DO is storage plus socket glue around `createSequencer`. Deploying needs the user's go-ahead; wrangler.toml is for
// local dev only.

export { default, ProjectRoom, BlobVault, depsFor } from "./worker.ts";
export { doSqlStorage } from "./storage.ts";
export { r2BlobStore, R2BlobStore, R2_MIN_PART_SIZE, type R2BlobStoreOptions } from "./blob-r2.ts";
export { doBlobStore, DoBlobStore, type DoBlobStoreOptions } from "./blob-do.ts";
export { sequencerBlobs, mediaBlobs, AUTH_HEADER, PROJECT_HEADER } from "./room.ts";
export { cappedBlobStore, writeCapOf, WriteCapError, WRITE_CAP_CODE, type WriteCap } from "./write-cap.ts";
export type { Env } from "./env.ts";
export type * from "./cf.ts";
