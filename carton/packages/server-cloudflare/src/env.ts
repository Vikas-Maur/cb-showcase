// The Worker's bindings (wrangler.toml). Secrets (AUTH_SECRET, ADMIN_TOKEN) come from `wrangler secret` or, in local
// dev, `.dev.vars`; never from code or wrangler.toml.

import type { DurableObjectNamespace, Fetcher, R2Bucket } from "./cf.ts";

export interface Env {
  PROJECT_ROOM: DurableObjectNamespace;
  // R2 for media, keyframes and archived segments; without it, the DO-blob fallback (L11) when BLOB_VAULT is bound
  BLOBS?: R2Bucket;
  BLOB_VAULT?: DurableObjectNamespace;
  // the static web client
  ASSETS?: Fetcher;
  // signs session tokens, invites and blob URLs: at least 32 bytes
  AUTH_SECRET: string;
  // enables POST /api/admin/projects/:p/invites, the bootstrap for a project's first owner
  ADMIN_TOKEN?: string;
  // the newest document schemaVersion the sequencer accepts in hello (default 1)
  SCHEMA_VERSION?: string;
  // the largest message a room takes in, inline or as an envelope (default 24 MiB, for a DO's 128 MB)
  MAX_ENVELOPE_BYTES?: string;
  // archiving (§18): rows kept live per branch, rows per segment, how often the alarm runs
  ARCHIVE_KEEP?: string;
  ARCHIVE_SEGMENT?: string;
  ARCHIVE_EVERY_MS?: string;
}
