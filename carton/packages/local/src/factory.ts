// The default engine factory for a helper or the engine thread: carton.db through store-sqlite, Carton with the
// Cardboard adapter, and (for shared cuts) its sync client, which the holder starts only once it owns the lease.
//   config: { projectDir, projectId?, dataDir?, name?,
//             sync?: { url, tokenFile, transport?, blobs?: false | <module>, origin?, projectId? } }
// The token is read from a file (app data), never passed on a command line. With sync, the client gets the host's
// blob store (`hostMessageBlobs` of `@carton/host-http/client`, over the host's HTTP API at the sync URL's origin), so
// a change or a share over 1 MiB travels as an envelope instead of being refused "too large". `blobs: false` turns that
// off; a host without that client (or that API) gets none, as before.
import { readFileSync } from "node:fs";
import { Carton } from "@carton/core";
import type { HostAdapter, Transport } from "@carton/core";
import type { BlobStore } from "@carton/core/plugins";
import { openSqliteStore } from "@carton/store-sqlite";
import { nodeHasher } from "./hasher.ts";
import { CartonHolderEngine, replicaName } from "./open.ts";
import type { HelperFactoryOptions } from "./helper.ts";

export async function createHolderEngine({ dbPath, config }: HelperFactoryOptions) {
  const store = await openSqliteStore(dbPath);
  const adapter = ((await import("@carton/cardboard")).cardboardAdapter) as HostAdapter;
  const syncCfg = config.sync as SyncConfig | undefined;
  let sync: { transport: Transport; url: string; token: () => Promise<string>; autoConnect: false; blobs?: BlobStore } | undefined;
  if (syncCfg?.url) {
    const mod = await import(syncCfg.transport ?? "@carton/server-node");
    // server-node exports a factory, `webSocketTransport(opts)`; a module may also export a ready transport
    const made = typeof mod.webSocketTransport === "function" ? mod.webSocketTransport() : mod.transport;
    if (!made || typeof (made as Transport).connect !== "function") throw new Error(`${syncCfg.transport ?? "@carton/server-node"} gave no Transport`);
    const transport = made as Transport;
    const token = async () => readFileSync(syncCfg.tokenFile, "utf8").trim();
    const blobs = await hostBlobs(syncCfg, String(syncCfg.projectId ?? config.projectId ?? ""), token);
    sync = { transport, url: syncCfg.url, token, autoConnect: false, ...(blobs ? { blobs } : {}) };
  }
  // this machine's display name (S3-1): the app's, as its config says, else the OS user name
  const carton = await Carton.open({ adapter, store, hasher: nodeHasher, sync: sync as any, name: replicaName(typeof config.name === "string" ? config.name : undefined) });
  return { store, engine: new CartonHolderEngine(carton), close: () => carton.close() };
}

export interface SyncConfig {
  url: string;
  tokenFile: string;
  /** A module exporting `webSocketTransport()` or `transport` (default `@carton/server-node`). */
  transport?: string;
  /** The host's blob client module (default `@carton/host-http/client`), or false for none. */
  blobs?: string | false;
  /** The host's HTTP origin (default: the sync URL's, ws → http, wss → https). */
  origin?: string;
  /** The project's id at the host (default: this project's). */
  projectId?: string;
}

/** The sync URL's HTTP origin: `wss://host/x` → `https://host`. */
export const httpOrigin = (url: string): string => {
  const u = new URL(url);
  return `${u.protocol === "wss:" ? "https:" : u.protocol === "ws:" ? "http:" : u.protocol}//${u.host}`;
};

/** The host's blob store for the sync client's envelopes, or null when there is no client for it here. */
export async function hostBlobs(cfg: SyncConfig, projectId: string, token: () => Promise<string>): Promise<BlobStore | null> {
  if (cfg.blobs === false || !projectId) return null;
  const mod = (await import(typeof cfg.blobs === "string" ? cfg.blobs : "@carton/host-http/client").catch(() => null)) as { hostMessageBlobs?: (o: { origin: string; projectId: string; token: () => Promise<string> }) => BlobStore } | null;
  if (typeof mod?.hostMessageBlobs !== "function") return null;
  return mod.hostMessageBlobs({ origin: cfg.origin ?? httpOrigin(cfg.url), projectId, token });
}

