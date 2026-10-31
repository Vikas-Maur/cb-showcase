// SequencerHost for Cloudflare (PLAN §3.1, §17): a Worker (auth, API, static web client) in front of one SQLite-backed
// Durable Object per project (`ProjectRoom`, Hibernation API), with R2 blobs or a DO-blob fallback. The DO is storage
// plus socket glue around `createSequencer`. Deploying needs the user's go-ahead. Owner: hosts-plugins.
import type { BlobStore, SequencerStorage } from "@carton/core/plugins";

const todo = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

/** The Worker's bindings (wrangler.toml). Secrets come from the environment, never from code. */
export interface Env {
  PROJECT_ROOM: unknown;
  BLOBS?: unknown;
  AUTH_SECRET: string;
}

/** `ctx.storage.sql` as SequencerStorage. */
export function doSqlStorage(storage: unknown): SequencerStorage {
  return todo("doSqlStorage");
}

/** R2 bucket binding as a BlobStore. */
export function r2BlobStore(bucket: unknown): BlobStore {
  return todo("r2BlobStore");
}

/** One project's sequencer: a SQLite-backed Durable Object using WebSocket hibernation. */
export class ProjectRoom {
  constructor(state: unknown, env: Env) {
    todo("ProjectRoom");
  }
  async fetch(request: Request): Promise<Response> {
    return todo("ProjectRoom.fetch");
  }
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    return todo("worker.fetch");
  },
};
export default worker;
