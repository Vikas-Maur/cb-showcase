// Media dedup within a team (PLAN §11 "whole-file within a team"; e2e-qa S5-3), as the BlobStore a host hands the
// media API for one project (HttpDeps.blobsFor).
//
// The bytes and manifests of media (`m/<hash>`, `mf/<hash>`) live once per team, so a file two projects use is
// stored and uploaded once. A project reads a team object only once it holds a grant for that hash, so a project
// can't read, or learn of, media that none of its own people brought in:
// - writing an object (a signed PUT or a multipart upload) grants it: the writer had the bytes;
// - an editor's `claim` (the media API's `head` calls it for editors) grants a hash the team already holds. An editor
//   can put any hash into the project's media records anyway, and every reader of the project then streams it, so
//   this gives editors nothing the document doesn't; it is what lets an upload find a teammate's copy and skip.
// Viewers and commenters only read what the project was granted. Every read checks the grant, so a signed URL for an
// ungranted hash finds nothing.
//
// A team object can't be overwritten by another project once it is sound: a write of `mf/<hash>` must verify against
// the hash, and a write of `m/<hash>` whose stored object already has the manifest's size is a no-op (media's own
// upload replaces only a wrong-sized object, and the §11 repair path removes a damaged one). Bytes come after their
// manifest, as media's upload already does it: an `m/<hash>` write needs the team's verified manifest, and its size
// (a PUT's body, a multipart upload's parts) must be the manifest's. Proxy pointers (`px/`) and everything else stay
// per project: a pointer isn't self-verifying, so one project could otherwise steer another's proxy reuse.
//
// Grants live outside the media scope (`grants` is a host-only store), so no client can write one. They are never
// revoked: a project that drops a media record keeps the right to the bytes it once had.

import type { BlobInfo, BlobStore, ByteRange, MultipartUpload } from "@carton/core/plugins";
import { BlobError } from "@carton/blob-memory/rules";
import { scopedBlobStore } from "@carton/blob-memory/scoped";
import { decodeManifest, manifestKey, webCryptoHasher, type Manifest } from "@carton/media";

const SHARED = /^(m|mf)\/([0-9a-f]{64})$/;
const hasher = webCryptoHasher();
const EMPTY = new Uint8Array(0);

export interface TeamMediaStore extends BlobStore {
  /** For an editor: grants this project `key` (`m/<hash>` or `mf/<hash>`) when the team already holds it. */
  claim(key: string): Promise<boolean>;
}

export interface TeamMediaOptions {
  /** The project's own media scope: everything that isn't a team object. */
  project: BlobStore;
  /** The team's media scope, shared by its projects. */
  team: BlobStore;
  /** The project's grants, out of every client's reach (one empty object per granted hash). */
  grants: BlobStore;
}

export const isTeamMediaStore = (s: BlobStore): s is TeamMediaStore => typeof (s as Partial<TeamMediaStore>).claim === "function";

const TEAM_ID = /^[A-Za-z0-9._~-]{1,128}$/;

/**
 * The media store a host gives one project's HTTP API, from its bucket: `projects/<p>/media/` alone, or with a team
 * its media bytes and manifests under `teams/<team>/media/` and its grants under `projects/<p>/grants/`.
 */
export function projectMediaStore(root: BlobStore, projectId: string, team?: string | null): BlobStore {
  const project = scopedBlobStore(root, `projects/${projectId}/media/`);
  if (!team) return project;
  if (!TEAM_ID.test(team)) throw new Error(`bad team id for project ${projectId}: ${JSON.stringify(team)}`);
  return teamMediaStore({ project, team: scopedBlobStore(root, `teams/${team}/media/`), grants: scopedBlobStore(root, `projects/${projectId}/grants/`) });
}

export function teamMediaStore(o: TeamMediaOptions): TeamMediaStore {
  const { project, team, grants } = o;
  const shared = (key: string): string | null => SHARED.exec(key)?.[2] ?? null;
  const granted = async (hash: string) => (await grants.head(hash)) !== null;
  const grant = async (hash: string) => {
    await grants.put(hash, EMPTY, { ifAbsent: true });
  };
  // The team's manifest for a hash, verified; null when it is absent or doesn't verify.
  const manifestOf = async (hash: string): Promise<Manifest | null> => {
    const bytes = await team.get(manifestKey(hash));
    if (!bytes) return null;
    try {
      return await decodeManifest(bytes, hasher, hash);
    } catch {
      return null;
    }
  };
  // The stored object when it is sound enough that no other write may replace it: a verifying manifest, or bytes of
  // the size the manifest gives. (A wrong-sized `m/` object is broken, and media's upload replaces it.)
  const keeper = async (key: string, hash: string): Promise<BlobInfo | null> => {
    const info = await team.head(key);
    if (!info) return null;
    const m = await manifestOf(hash);
    if (key.startsWith("mf/")) return m ? info : null;
    return m && m.size === info.size ? info : null;
  };
  // the team's verified manifest, which a write of `m/<hash>` needs
  const manifestFor = async (hash: string): Promise<Manifest> => {
    const m = await manifestOf(hash);
    if (!m) throw new BlobError("PreconditionFailed", `no verified manifest for ${hash}: write mf/${hash} first`);
    return m;
  };
  const wrap = (u: MultipartUpload, hash: string): MultipartUpload => ({
    key: u.key,
    uploadId: u.uploadId,
    uploadPart: (n, d) => u.uploadPart(n, d),
    listParts: () => u.listParts(),
    async complete(parts) {
      const kept = await keeper(u.key, hash);
      if (kept) {
        // someone completed a sound copy meanwhile: keep it, drop this one
        await u.abort().catch(() => {});
        return kept;
      }
      const m = await manifestFor(hash);
      const sizes = new Map((await u.listParts()).map((p) => [p.partNumber, p.size]));
      const total = parts.reduce((n, p) => n + (sizes.get(p.partNumber) ?? Number.NaN), 0);
      if (total !== m.size) throw new BlobError("InvalidPart", `the parts hold ${total} bytes; the manifest says ${m.size}`);
      return u.complete(parts);
    },
    abort: () => u.abort(),
  });

  const store: TeamMediaStore = {
    kind: `${team.kind}+team`,
    async claim(key) {
      const hash = shared(key);
      if (!hash || !(await team.head(key))) return false;
      await grant(hash);
      return true;
    },
    async put(key, data, opts) {
      const hash = shared(key);
      if (!hash) return project.put(key, data, opts);
      if (key.startsWith("mf/")) {
        try {
          await decodeManifest(data, hasher, hash);
        } catch {
          throw new BlobError("PreconditionFailed", `a manifest that doesn't verify against ${hash}`);
        }
      }
      await grant(hash);
      const kept = await keeper(key, hash);
      if (kept) return kept;
      if (key.startsWith("m/")) {
        const m = await manifestFor(hash);
        if (data.byteLength !== m.size) throw new BlobError("InvalidPart", `${data.byteLength} bytes; the manifest says ${m.size}`);
      }
      return team.put(key, data, opts);
    },
    async get(key: string, range?: ByteRange) {
      const hash = shared(key);
      if (!hash) return project.get(key, range);
      return (await granted(hash)) ? team.get(key, range) : null;
    },
    async head(key) {
      const hash = shared(key);
      if (!hash) return project.head(key);
      return (await granted(hash)) ? team.head(key) : null;
    },
    async delete(key) {
      // only the host's repair path deletes, after verifying the damage itself
      const hash = shared(key);
      if (!hash) return project.delete(key);
      if (await granted(hash)) await team.delete(key);
    },
    // a project lists its own scope; team objects belong to no one project
    list: (prefix, opts) => project.list(prefix, opts),
    async createMultipart(key, opts) {
      const hash = shared(key);
      if (!hash) return project.createMultipart(key, opts);
      // a manifest is small and written whole; bytes need their manifest first (and multipart is only for bytes)
      if (key.startsWith("mf/")) throw new BlobError("InvalidKey", "a manifest is written whole, with put");
      await manifestFor(hash);
      await grant(hash);
      return wrap(await team.createMultipart(key, opts), hash);
    },
    async resumeMultipart(key, uploadId) {
      const hash = shared(key);
      if (!hash) return project.resumeMultipart(key, uploadId);
      if (!(await granted(hash))) throw new BlobError("NoSuchUpload", "no such upload");
      return wrap(await team.resumeMultipart(key, uploadId), hash);
    },
  };
  if (project.getStream && team.getStream) {
    const ps = project.getStream.bind(project), ts = team.getStream.bind(team);
    store.getStream = async (key, range) => {
      const hash = shared(key);
      if (!hash) return ps(key, range);
      return (await granted(hash)) ? ts(key, range) : null;
    };
  }
  return store;
}
