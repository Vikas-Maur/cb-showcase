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
  // the newest document schemaVersion the sequencer accepts in hello (default: @carton/cardboard's
  // CARDBOARD_SCHEMA_VERSION; set it only to pin a deployment)
  SCHEMA_VERSION?: string;
  // the largest message a room takes in, inline or as an envelope (default 24 MiB, for a DO's 128 MB)
  MAX_ENVELOPE_BYTES?: string;
  // archiving (§18): rows kept live per branch, rows per segment, how often the alarm runs
  ARCHIVE_KEEP?: string;
  ARCHIVE_SEGMENT?: string;
  ARCHIVE_EVERY_MS?: string;
  // a socket that shows presence and sends nothing, not even its keepalive `ping`, for this long is closed, so its
  // teammates stop showing its cursor (default 120000: clients ping every 25 s, a background tab about once a minute;
  // "0" = never). Checked from the alarm, only while some socket shows presence.
  PRESENCE_TIMEOUT_MS?: string;
  // media dedup within a team (§11), with R2 only: a JSON object from project id to team id, e.g.
  // {"film-a":"studio","film-b":"studio"}. A listed project's media bytes and manifests live once under
  // teams/<team>/media/, and the project reads only what it was granted (host-http's team.ts).
  TEAMS?: string;
  // the most keys one POST /blobs/heads checks (default 200; at most 1000): each key is one to four R2 calls (a team
  // store's claim and grant check), and Cloudflare limits a Worker request's subrequests, R2 calls included. The
  // client asks again for the rest, so a lower value costs requests, never answers.
  BLOB_HEADS_PER_REQUEST?: string;
  // Open creation (the free web demo): "1" lets anyone who opens the site make a project and be its owner, with no
  // admin token. Off unless set. OPEN_CREATE_PER_DAY caps the projects one IP address makes per UTC day (default 10).
  OPEN_CREATE?: string;
  OPEN_CREATE_PER_DAY?: string;
  // the largest file one upload stores, in bytes (default: none; 200 MiB when OPEN_CREATE is on)
  MAX_UPLOAD_BYTES?: string;
  // the deployment's daily write cap (write-cap.ts), across every project: bytes stored and blob write calls per UTC
  // day. Over either, writes answer 429 (code DailyWriteCap) until 00:00 UTC; reads and deletes go on. Off unless set.
  WRITE_CAP_BYTES_PER_DAY?: string;
  WRITE_CAP_OPS_PER_DAY?: string;
  // The DO-blob fallback's sweep of abandoned uploads (blob-do.ts): a multipart upload neither completed nor aborted,
  // untouched (made, a part written, its parts listed) for VAULT_UPLOAD_TTL_MS, is deleted with its parts (default
  // 86400000, 24 h, as an R2 lifecycle rule would). VAULT_SWEEP_ROWS is the most rows one sweep alarm deletes (default
  // 500; the next alarm comes a second later while more remain). Set them for tests and the lab; a deployment needs
  // neither.
  VAULT_UPLOAD_TTL_MS?: string;
  VAULT_SWEEP_ROWS?: string;
}
