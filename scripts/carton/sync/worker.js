// Live sync and sharing in Cardboard 1.4.0 (H8, Invite to edit and Join; PLAN §0.1, §5.3, §6.2, §12, §14). build.js
// bundles this file into carton-node.cjs, so it shares the facade's one copy of @carton/*, and it registers with the
// facade's extend(). It runs in every process that loads the facade; only the library worker calls worker(api).
//
// - A project is shared from this computer when it has a sync config (store.js: host, account, session in app data).
// - The library worker's own Carton handle for it is opened with sync (openOptions) and becomes the sync lease holder's
//   engine (live.js), so the worker's saves, cb's writes (handed to it over the holder's socket), the History panel's
//   status words and presence all run on one handle.
// - Share: join the host as its owner, hand the cut to the host's sequencer with its history (Carton.share, §5.3),
//   then write the project's share descriptor (the web client's format) so a teammate can join from an invite.
// - Invite: an invite link for a role, `<host>/#join=<projectId>.<invite>` (opens in the app or in a browser).
// - Join: from an invite, a new bundle in this library holding the shared cut (Carton.open's `join`), which syncs
//   from the host like any shared project.
// Services are carton.<name> for main's carton:call and the pages (letters only).
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { extend, cardboard14 } from "../carton-node.js";
import { Carton, hashDoc } from "@carton/core";
import { cardboardAdapter, materializeProject } from "@carton/cardboard";
import { CartonHolderEngine, localGroup, nodeHasher, openLocal } from "@carton/local";
import { openProjectStore, openSqliteStore } from "@carton/store-sqlite";
import { webSocketTransport } from "@carton/server-node";
import * as host from "./host.js";
import * as store from "./store.js";
import { Live } from "./live.js";
import * as media from "./media.js";
import { headScope } from "./scope.js";
import "./cbproj.js";

const errText = (e) => (e && e.message) || String(e);
const warned = new Set();
const warnOnce = (key, msg) => { if (!warned.has(key)) { warned.add(key); console.warn("[carton] " + msg); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let inWorker = false;
const lives = new Map(); // bundlePath → Promise<Live | null>
const holding = new WeakMap(); // LocalCarton → its Live, once started
const lastError = new Map(); // bundlePath → why live sync last failed to start (said once in the log, and to the caller)
const transport = webSocketTransport();

/**
 * Sync for a handle, resolved when it connects rather than when it opens: a project shared after its handle opened
 * connects without reopening it, and a session refreshed by any process is picked up. Without a config the connect
 * fails, and nothing connects anyway until the holder starts (only for a shared project).
 */
function lazySync(bundlePath, projectId) {
  const session = store.sessionFor(bundlePath, projectId);
  return {
    transport: {
      connect(_url, o) {
        const cfg = store.readConfig(bundlePath, projectId);
        if (!cfg) return Promise.reject(new Error("This project isn't shared from this computer"));
        return transport.connect(host.wsUrl(cfg.host, projectId), o);
      },
    },
    url: "carton-sync:" + projectId,
    token: () => session.token(),
    autoConnect: false,
  };
}

/** The person at this app, in a shared project: their account on the host (R3; null for a local-only project). */
function person(bundlePath, projectId) {
  const cfg = projectId && store.readConfig(bundlePath, projectId);
  return cfg ? { kind: "human", id: cfg.account, name: cfg.name ?? cfg.account, group: localGroup() } : null;
}

// The helper engine factory a cb call starts when the app is closed (H13's headless sync); it loads this bundle.
const helperFactory = () => path.join(__dirname, "sync", "factory.js");

async function startLive(api, bundlePath, lc) {
  // Not shared from here: nothing to start (and nothing remembered, so sharing it later starts it).
  if (!store.readConfig(bundlePath, lc.carton.projectId)) return null;
  let p = lives.get(bundlePath);
  if (p) return p;
  p = (async () => {
    const projectId = lc.carton.projectId;
    if (!lc.carton.sync) {
      warnOnce("nosync:" + bundlePath, `${path.basename(bundlePath)} is shared, but this build can't open it with sync; edits stay on this computer`);
      return null;
    }
    // A clip added while the project is shared (by the person, an agent or cb) is shared as it was at share time.
    const live = new Live({ api, bundlePath, projectId, lc, onChange: () => autoShare(api, bundlePath, projectId), log: (e) => (e.type === "materialize-failed" ? warnOnce("mz:" + bundlePath, "a teammate's change didn't reach project.json: " + e.error) : undefined) });
    await live.start();
    holding.set(lc, live);
    return live;
  })().catch((e) => {
    lives.delete(bundlePath);
    lastError.set(bundlePath, errText(e));
    warnOnce("live:" + bundlePath, `live sync didn't start for ${path.basename(bundlePath)}: ${errText(e)}`);
    return null;
  });
  lives.set(bundlePath, p);
  return p;
}

// ---------------------------------------------------------------- media (H10, media.js)
// One media job at a time per project (hashing and proxies are heavy; two shares of one clip would upload it twice).
// A clip already shared is skipped while its original's size and mtime are unchanged (media-shared.json in the
// project's app-data folder), so nothing is hashed again for no reason.
// The clip's content id is NOT committed into the project (e2e-qa S5-G2): Cardboard 1.4.0's project store drops
// `contentHash` (and `data.content`) from media records, so it never reaches project.json, and every save made from
// the file would then "remove" it again in Carton, credited to whoever saved. Teammates find a clip's shared record
// by its media id (`carton/media/<id>.json` on the host). Asked of cardboard-adapter: carry such host-dropped fields
// over from the base in fromHost; then the commit can come back.
const mediaJobs = new Map(); // bundlePath → Promise
const sharedFile = (bundlePath, projectId) => path.join(store.projectDir(bundlePath, projectId), "media-shared.json");
const readShared = (bundlePath, projectId) => { try { return JSON.parse(fs.readFileSync(sharedFile(bundlePath, projectId), "utf8")); } catch { return {}; } };

/**
 * The project a media id belongs to. The store's index knows clips whose files are in a bundle; a teammate's clip has
 * no file here, so the shared projects' records are looked through as well.
 */
async function projectOfMedia(api, mediaId) {
  const known = api.library.projects.idForMedia?.(mediaId);
  if (known) return known;
  for (const p of await api.library.projects.list()) {
    const bundlePath = api.bundleOf(p.id);
    if (!bundlePath || !store.readConfig(bundlePath, p.id)) continue;
    const doc = await api.library.projects.read(p.id).catch(() => null);
    if (doc?.media?.some((m) => m.id === mediaId)) return p.id;
  }
  return null;
}

function shareMediaOf(api, bundlePath, projectId, { only, force = false } = {}) {
  const run = async () => {
    const lc = await api.open(bundlePath);
    if (!lc || !store.readConfig(bundlePath, projectId)) return [];
    const envelope = JSON.parse(fs.readFileSync(path.join(bundlePath, "project.json"), "utf8"));
    const done = readShared(bundlePath, projectId), out = [];
    for (const m of envelope.project?.media ?? []) {
      if (only && !only.includes(m.id)) continue;
      const file = envelope.media?.find((x) => x.mediaId === m.id)?.nativePath;
      let st;
      try { st = file && fs.statSync(file); } catch { st = null; }
      if (!st) continue; // a teammate's clip, or a missing file: not ours to share
      const was = done[m.id];
      if (!force && was && was.size === st.size && was.mtimeMs === st.mtimeMs) { out.push({ mediaId: m.id, hash: was.hash, proxy: was.proxy ?? null, skipped: "already shared" }); continue; }
      try {
        const r = await media.shareClip({ bundlePath, projectId, mediaId: m.id, envelope });
        if (!r) continue;
        done[m.id] = { size: st.size, mtimeMs: st.mtimeMs, hash: r.record.hash, proxy: r.record.proxy ?? null };
        out.push({ mediaId: m.id, hash: r.record.hash, proxy: r.record.proxy ?? null, skipped: r.skipped });
      } catch (e) {
        out.push({ mediaId: m.id, error: errText(e) });
        warnOnce("media:" + m.id, `a clip of ${path.basename(bundlePath)} wasn't shared: ${errText(e)}`);
      }
    }
    fs.mkdirSync(path.dirname(sharedFile(bundlePath, projectId)), { recursive: true });
    fs.writeFileSync(sharedFile(bundlePath, projectId), JSON.stringify(done));
    return out;
  };
  const p = (mediaJobs.get(bundlePath) ?? Promise.resolve()).then(run, run);
  mediaJobs.set(bundlePath, p.catch(() => {}));
  return p;
}

// One automatic share run waiting per bundle at most: changes that come while one waits add nothing to do.
const autoQueued = new Set();
function autoShare(api, bundlePath, projectId) {
  if (autoQueued.has(bundlePath)) return;
  autoQueued.add(bundlePath);
  const p = (mediaJobs.get(bundlePath) ?? Promise.resolve()).then(() => autoQueued.delete(bundlePath));
  mediaJobs.set(bundlePath, p);
  return shareMediaOf(api, bundlePath, projectId);
}

// R6: a teammate's clip has no file here. Its record in project.json gets where it plays from
// (cardboard-media://media/<id>, which main answers from the host) and what the host's shared record says about it
// (size, duration, picture), as join does for the clips there at share time. A record whose shared record isn't up yet
// gets the rest on a later materialize.
const hostSrc = (id) => `cardboard-media://media/${id}`;
async function fillTeammateMedia(next, { bundlePath, projectId, current }) {
  if (!bundlePath || !projectId || !store.readConfig(bundlePath, projectId) || !next?.media?.length) return next;
  const had = new Map((current?.media ?? []).map((m) => [m.id, m]));
  const now = new Date().toISOString();
  const list = await Promise.all(next.media.map(async (m) => {
    const src = m.data?.src;
    if (src && src !== hostSrc(m.id)) return m; // a file on this computer
    if (src && m.data?.size !== undefined) return m; // filled already
    const rec = await Promise.race([media.sharedRecord(bundlePath, projectId, m.id).catch(() => null), sleep(2000).then(() => null)]);
    const data = { ...m.data, src: hostSrc(m.id) };
    if (rec) {
      const from = { fileName: rec.fileName, size: rec.size, duration: rec.durationSec, width: rec.width, height: rec.height, frameRate: rec.fps, hasAudio: rec.hasAudio, codec: rec.codec };
      for (const [k, v] of Object.entries(from)) if (v !== undefined && data[k] === undefined) data[k] = v;
    }
    const prev = had.get(m.id);
    return { ...m, createdAt: m.createdAt ?? prev?.createdAt ?? now, addedAt: m.addedAt ?? prev?.addedAt ?? now, data };
  }));
  return { ...next, media: list };
}

/** Wait for a cut's hand-off to finish (local → handing off → server), up to `ms`. */
async function handedOff(carton, cut, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const rec = (await carton.cuts()).find((c) => c.id === cut);
    if (rec?.sequencer.kind === "server") return rec;
    if (Date.now() > end) return null;
    await sleep(50);
  }
}

// Cardboard's media record, as a teammate may see it (T0, PLAN §11): what the editor needs to show the clip, never a
// path on this computer.
const T0 = ["type", "fileName", "format", "size", "duration", "width", "height", "frameRate", "hasAudio", "codec"];
function mediaRecords(project) {
  const out = {};
  for (const m of project?.media ?? []) {
    const data = {};
    for (const f of T0) if (m.data?.[f] !== undefined) data[f] = m.data[f];
    out[m.id] = { id: m.id, ...(m.contentHash ? { contentHash: m.contentHash } : {}), data };
  }
  return out;
}

async function uploadDescriptor(bundlePath, projectId, lc, rec, project) {
  const cfg = store.readConfig(bundlePath, projectId);
  const token = await store.sessionFor(bundlePath, projectId).token();
  const doc0 = await lc.carton.checkout(`${rec.id}@0`);
  const d = host.descriptor({ projectId, name: project?.name ?? path.basename(bundlePath, ".cardboard"), cut: rec, doc0, rootHash: hashDoc(doc0, lc.carton.schema), media: mediaRecords(project) });
  await host.putBlob({ host: cfg.host, projectId, token, key: host.DESCRIPTOR_KEY, bytes: new TextEncoder().encode(JSON.stringify(d)), contentType: "application/json" });
}

// A folder moved into the library in one step. Windows refuses while something (an indexer, an antivirus scan) has a
// file in it open: try again for a few seconds.
function renameDir(from, to) {
  for (let i = 0; ; i++) {
    try { return fs.renameSync(from, to); } catch (e) {
      if (i >= 100 || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

// A bundle folder name for a joined project, free in this library.
function freeBundle(root, name) {
  const base = String(name || "Shared project").replace(/[<>:"/\\|?*\x00-\x1f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Shared project";
  for (let i = 1; ; i++) {
    const p = path.join(root, (i === 1 ? base : `${base} ${i}`) + ".cardboard");
    if (!fs.existsSync(p)) return p;
  }
}

extend({
  name: "sync",
  // R1: every process opens a shared project's Carton able to sync, but only the worker connects it (its holder).
  async openOptions({ bundlePath, projectId }) {
    const cfg = projectId && store.readConfig(bundlePath, projectId);
    // S3-1: in a shared project the replica is named after the person (lineage, cut owners, dialogs).
    const helper = cfg ? { name: cfg.name ?? cfg.account, helperFactory: helperFactory(), helperConfig: { sync: { bundlePath, projectId } } } : {};
    if (!inWorker) return helper;
    const actor = person(bundlePath, projectId);
    return { ...helper, sync: lazySync(bundlePath, projectId), ...(actor ? { actor } : {}) };
  },
  // R3
  person: ({ bundlePath, projectId }) => person(bundlePath, projectId),
  // R6
  materializeDoc: (next, o) => fillTeammateMedia(next, o),
  // R2: a commit on a shared cut. The worker's handle is the lease holder: commit there, a clash keeping head's value
  // (the rest lands; the cards go back as a conflicts result, which the facade keeps for the author). Anywhere else
  // (cb), hand it to the holder, or to a headless helper when the app is closed.
  async commitShared(lc, { doc, base, author, intent }) {
    if (holding.get(lc)?.holds()) {
      let resolved = [];
      const r = await lc.carton.commit({ doc, ...(base ? { base } : {}), author, ...(intent ? { intent } : {}), choices: () => "ours" });
      if ((r.status === "pending" || r.status === "confirmed") && r.resolved?.length) resolved = r.resolved;
      return resolved.length ? { status: "conflicts", cards: resolved, ref: r.ref, landed: r.status } : r;
    }
    const w = await lc.write({ kind: "commit", doc, ...(base ? { base } : {}), ...(intent ? { intent } : {}) }, { actor: author });
    if (w.status === "error") throw new Error(w.error);
    if (w.status === "rejected") return { status: "rejected", reason: w.reason };
    if (w.status === "conflicts") return { status: "conflicts", cards: w.conflicts, ref: (await lc.carton.head()).ref };
    return { status: w.status === "pending" ? "pending" : "confirmed", seq: w.seq, ref: (await lc.carton.head()).ref, rebased: 0, empty: !!w.empty, notices: [] };
  },
  worker(api) {
    inWorker = true;
    // Every shared project the worker opens goes live: its holder takes the lease and connects.
    api.onOpen((bundlePath, lc) => startLive(api, bundlePath, lc));
    const liveOf = async (projectId) => {
      const bundlePath = api.bundleOf(projectId), lc = await api.carton(projectId);
      if (!bundlePath || !lc) throw new Error("History isn't available for this project");
      return { bundlePath, lc, live: await startLive(api, bundlePath, lc) };
    };
    return {
      /** Is the project shared from here, with whom, and how is sync doing (the Share panel). */
      async liveStatus({ projectId }) {
        const bundlePath = api.bundleOf(projectId);
        const cfg = bundlePath && store.readConfig(bundlePath, projectId);
        if (!cfg) return { shared: false };
        const { live } = await liveOf(projectId);
        return { host: cfg.host, account: cfg.account, name: cfg.name ?? cfg.account, role: cfg.role, ...(live?.view() ?? { shared: true, status: "offline", pending: 0, label: "Offline", peers: [] }) };
      },
      /**
       * Invite to edit, step 1: share this project through a Carton host. `invite` is an owner invite from the host,
       * or `adminToken` makes one (the host operator's token; used once, never stored). The cut goes up with its history.
       */
      async liveShare({ projectId, host: hostUrl, invite, adminToken, name, withMedia = true }) {
        const bundlePath = api.bundleOf(projectId), lc = await api.carton(projectId);
        if (!bundlePath || !lc) throw new Error("History isn't available for this project");
        if (!lc.carton.sync) throw new Error("This build can't share a project yet (its Carton opened without sync)");
        const h = host.origin(hostUrl);
        const inv = invite || (adminToken ? await host.adminInvite({ host: h, projectId, adminToken, role: "owner" }) : null);
        if (!inv) throw new Error("An owner invite or the host's admin token is needed to share a project");
        const account = host.accountId(name);
        const s = await host.join({ host: h, projectId, invite: inv, account, installKey: store.installKey() });
        store.writeConfig(bundlePath, { host: h, projectId, account, name: name || account, role: s.context.role, cut: lc.carton.cut });
        store.saveSession(bundlePath, projectId, s);
        const live = await startLive(api, bundlePath, lc);
        if (!live) throw new Error("Live sync didn't start for this project: " + (lastError.get(bundlePath) ?? "unknown"));
        const cut = lc.carton.cut;
        await lc.carton.share(cut);
        const rec = await handedOff(lc.carton, cut, 30_000);
        if (!rec) return { status: "sharing", note: "The host hasn't confirmed yet; the project finishes sharing when it is back" };
        await uploadDescriptor(bundlePath, projectId, lc, rec, await api.library.projects.read(projectId));
        // The clips follow in the background (hashing and proxies take a while; editing never waits for them).
        if (withMedia) void shareMediaOf(api, bundlePath, projectId).catch(() => {});
        return { status: "shared", host: h, cut: rec.id };
      },
      /** Invite to edit, step 2: an invite link for a role (owners only; the host checks). */
      async liveInvite({ projectId, role = "editor", ttlMs }) {
        const bundlePath = api.bundleOf(projectId);
        const cfg = bundlePath && store.readConfig(bundlePath, projectId);
        if (!cfg) throw new Error("Share this project first");
        const token = await store.sessionFor(bundlePath, projectId).token();
        const inv = await host.createInvite({ host: cfg.host, projectId, token, role, ttlMs });
        return { link: host.inviteLink(cfg.host, projectId, inv), role };
      },
      /** Join a shared project from an invite link: a new project in this library, synced from the host. */
      async liveJoin({ link, name }) {
        const l = host.parseInviteLink(link);
        if (!l) throw new Error("That isn't an invite link (it looks like https://host/#join=…)");
        const library = api.library;
        if ((await library.projects.list()).some((p) => p.id === l.projectId)) throw new Error("This project is already in your library");
        const account = host.accountId(name);
        const s = await host.join({ host: l.host, projectId: l.projectId, invite: l.invite, account, installKey: store.installKey() });
        const bytes = await host.getBlob({ host: l.host, projectId: l.projectId, token: s.token, key: host.DESCRIPTOR_KEY });
        if (!bytes) throw new Error("The host has no share data for this project yet: ask its owner to share it again");
        const d = host.parseDescriptor(new TextDecoder().decode(bytes));
        if (d.projectId !== l.projectId) throw new Error("This project's share data names another project");
        const root = library.root;
        if (!root) throw new Error("The library folder isn't known");
        const final = freeBundle(root, d.name);
        // Built in a staging folder beside the library, then moved in with one rename, so the library never lists a
        // half-made project.
        const staging = path.join(root, `.carton-join-${randomBytes(4).toString("hex")}`);
        fs.mkdirSync(staging, { recursive: true });
        try {
          const now = Date.now();
          const media = Object.values(d.media ?? {}).map((m) => ({ id: m.id, ...(m.contentHash ? { contentHash: m.contentHash } : {}), createdAt: new Date(now).toISOString(), addedAt: new Date(now).toISOString(), data: { ...m.data, src: `cardboard-media://media/${m.id}` } }));
          // The file starts at the cut's root, with the clips' full records from the descriptor: head (once caught up)
          // goes over it with those records kept by id, as the facade materializes any project.
          const project = { id: d.projectId, name: d.name, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), ...materializeProject(d.doc0, null), media, stateUpdatedAt: now };
          fs.writeFileSync(path.join(staging, "project.json"), JSON.stringify({ format: "cardboard-project", version: 1, project, media: [] }, null, 2));
          // The shared cut, from its root; its rows come from the host once the worker connects.
          const { store: st } = await openProjectStore({ bundleDir: staging, projectId: d.projectId });
          const c = await Carton.open({ adapter: cardboardAdapter, store: st, hasher: nodeHasher, init: { join: { projectId: d.projectId, cut: d.cut, doc0: d.doc0, rootHash: d.rootHash } }, sync: { transport, url: "carton-sync:" + d.projectId, token: s.token, autoConnect: false } });
          // That file is Carton's own (the root's state), not an outside save: its rev goes into the facade's rev map
          // (carton.db's local `views` table, ["rev", ms] → ref and ["ref", cut, seq] → ms). Without it the worker
          // would import the file as a foreign write the moment it reads it: a change taking the timeline back to the
          // root, which then syncs to everyone.
          await st.write([{ table: "views", key: ["rev", now], value: { branchId: d.cut.id, seq: 0, pending: [] } }, { table: "views", key: ["ref", d.cut.id, 0], value: now }]);
          await c.close();
          await st.close();
          store.writeConfig(final, { host: l.host, projectId: d.projectId, account, name: name || account, role: s.context.role, cut: d.cut.id });
          store.saveSession(final, d.projectId, s);
          renameDir(staging, final);
        } catch (e) {
          fs.rmSync(staging, { recursive: true, force: true });
          throw e;
        }
        // The library lists it (list() scans the folder), then its history opens: it goes live, catches up from the
        // host, and project.json follows.
        for (let i = 0; i < 100 && path.resolve(library.projects.bundlePathFor?.(d.projectId) ?? "") !== path.resolve(final); i++) {
          await library.projects.list();
          if (path.resolve(library.projects.bundlePathFor?.(d.projectId) ?? "") !== path.resolve(final)) await sleep(50);
        }
        await api.open(final);
        return { projectId: d.projectId, name: d.name, bundlePath: final };
      },
      /** Share the project's clips (all, or `mediaIds`) now; resolves when they are up. */
      async liveShareMedia({ projectId, mediaIds, force }) {
        const bundlePath = api.bundleOf(projectId);
        if (!bundlePath || !store.readConfig(bundlePath, projectId)) throw new Error("Share this project first");
        return shareMediaOf(api, bundlePath, projectId, { only: mediaIds, force });
      },
      /**
       * Where main streams a clip that has no file on this computer: its shared proxy (or original) on the host, or
       * null (not a shared project's clip, or not shared yet). main asks only after its own lookup found no file.
       */
      async liveMediaSource({ mediaId }) {
        const projectId = await projectOfMedia(api, mediaId);
        const bundlePath = projectId && api.bundleOf(projectId);
        if (!bundlePath || !store.readConfig(bundlePath, projectId)) return null;
        const p = media.playable(await media.sharedRecord(bundlePath, projectId, mediaId).catch(() => null));
        return p ? { bundlePath, projectId, mediaId, ...p } : null;
      },
      /**
       * A loopback URL an ffmpeg-based tool can read a shared clip from (verified bytes only), or null: a file by range,
       * or for a proxy still uploading a live HLS playlist the tool follows until it ends.
       */
      async liveMediaUrl({ mediaId }) {
        const projectId = await projectOfMedia(api, mediaId);
        const bundlePath = projectId && api.bundleOf(projectId);
        if (!bundlePath || !store.readConfig(bundlePath, projectId)) return null;
        const p = media.playable(await media.sharedRecord(bundlePath, projectId, mediaId));
        return p ? { url: await media.toolUrl(bundlePath, projectId, p), ...p } : null;
      },
      /** The person's presence while they edit (the pages send it at most once a second; null when idle). */
      async livePresence({ projectId, state }) {
        const bundlePath = api.bundleOf(projectId);
        const live = bundlePath ? await lives.get(bundlePath) : null;
        const p = person(bundlePath, projectId);
        live?.presence(state, p && { id: p.id, name: p.name });
        return { ok: !!live };
      },
    };
  },
});

// ---------------------------------------------------------------- H13: cb's cloud mode on a Carton-shared project
// With CARDBOARD_CLOUD_PROJECTS=1, cb pulls the whole project.json from Cardboard's storage before each MCP tool call
// and PUTs it back after (`ifVersion`, CloudConflictError on a 412). For a project Carton shares, the document already
// syncs change by change through the lease holder, so (patches/cloud.js):
//   pull: the holder (the app's worker, or a headless helper started now) catches up with the host, then head goes
//         into project.json, so the tool reads the newest state;
//   push: nothing to PUT (each edit went through the holder as it was made). Cardboard's own path stays for every
//         project Carton doesn't share.
const shared = (lib, projectId) => {
  const bundlePath = lib?.projects?.bundlePathFor?.(projectId);
  return bundlePath && store.readConfig(bundlePath, projectId) ? bundlePath : null;
};
const cli = {
  async pull(lib, projectId) {
    const bundlePath = shared(lib, projectId);
    if (!bundlePath) return false;
    const lc = await openLocal({ projectDir: bundlePath, projectId, helperFactory: helperFactory(), helperConfig: { sync: { bundlePath, projectId } } });
    try {
      // Any write reaches the holder; a short pin is one that changes nothing (the holder catches up before it answers).
      await lc.write({ kind: "pin", owner: "cloud-pull", ttlMs: 1000 });
    } finally {
      await lc.close();
    }
    const current = await lib.projects.read(projectId);
    let next = await cardboard14.headProject(bundlePath, current);
    if (!next) return true;
    next = await fillTeammateMedia(next, { bundlePath, projectId, current });
    await lib.projects.updateScoped(next, headScope(current, next));
    return true;
  },
  push: async (lib, projectId) => !!shared(lib, projectId),
};

// For the headless helper's factory (sync/factory.js loads this bundle) and cb's patches: what they need from the
// packages, from this bundle's one copy of them.
// `holds(lc)`: this handle is the live lease holder now (cbproj.js folds on a shared cut only then).
globalThis.__cartonSync = { Carton, CartonHolderEngine, cardboardAdapter, nodeHasher, openSqliteStore, transport, store, host, lazySync, media, cli, holds: (lc) => !!holding.get(lc)?.holds() };
