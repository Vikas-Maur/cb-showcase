// Where carton.db lives (plan §6.4 "Synced and non-NTFS/APFS folders", L15).
//
// By default the database is `<bundle>/.carton/carton.db`. Two kinds of folder must not hold a live WAL database:
//   - folders a cloud-sync client copies (OneDrive, Dropbox, iCloud Drive, Google Drive, Box, Syncthing, Nextcloud…):
//     the client would upload carton.db, -wal and -shm separately and mid-write, and another machine's copy would be
//     a torn database. Bundles synced that way are imported as external changes, never merged as replicas (L15);
//   - FAT and exFAT volumes: no hard links, so the materializer's displace/install has to fall back (L13), and no
//     journaling, so an unplugged drive can tear the file;
//   - network shares (SMB, NFS): SQLite's WAL needs shared memory between the processes using the file, which a
//     network file system does not give (sqlite.org/wal.html). Not in the plan's list; same rule, same reason.
// There the database moves to app data, keyed by project id, and the user is told that file sync is not a
// collaboration channel (Share and `.cbproj` are).
//
// Detection is cheap path and marker checks first, on the path as given and on its physical path (symlinks and
// junctions resolved), so a link can't hide a synced folder. Nothing is written into a folder that looks cloud-synced
// (a probe file would be uploaded). Network volumes are found from the UNC path on Windows and the mount table on
// macOS and Linux. Otherwise one hard-link probe inside `.carton/` decides FAT/exFAT on every OS, because Windows
// reports no file-system type through Node and macOS's statfs type numbers are not stable.
// Everything that touches the OS goes through `LocationProbe`, so the Windows and macOS rules run in tests here.

import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

export type DbPlacement = "bundle" | "cloud-sync" | "network" | "no-hard-links" | "not-writable";

export interface DbLocation {
  /** Absolute path of carton.db. */
  dbPath: string;
  inBundle: boolean;
  /** Why the database is where it is. */
  placement: DbPlacement;
  /** The sync client when placement is "cloud-sync", e.g. "OneDrive". */
  provider?: string;
  /** The sync root or volume that triggered the rule. */
  root?: string;
  /** What to tell the user when the database is outside the bundle (L15). */
  warning?: string;
}

export interface LocationProbe {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
  exists(p: string): boolean;
  readDir(p: string): string[] | null;
  readText(p: string): string | null;
  /** Linux statfs magic number, or null when the OS gives none (Windows) or it means nothing stable (macOS). */
  fsMagic(p: string): number | null;
  /**
   * The physical path: symlinks and junctions resolved, and on Windows a mapped network drive turned into its
   * `\\server\share` path. A path that doesn't exist yet resolves through its nearest existing ancestor.
   */
  realPath(p: string): string;
  /** The mount table: `/sbin/mount` output on macOS, `/proc/self/mountinfo` on Linux; null elsewhere or on failure. */
  mountTable(): string | null;
  /** Try to hard-link a fresh file inside `dir`. "ok", "no-links" (FAT/exFAT and friends), or "not-writable". */
  linkProbe(dir: string): "ok" | "no-links" | "not-writable";
  /** Windows cloud-files sync roots (SyncRootManager), or [] elsewhere. May be slow: called at most once. */
  windowsSyncRoots(): string[];
}

export interface LocateOptions {
  /** The project bundle folder (the one holding project.json). */
  bundleDir: string;
  /** Cardboard's project id; keys the app-data copy. */
  projectId: string;
  /** Overrides the per-OS app-data folder (Cardboard passes its own userData). */
  appDataDir?: string;
  /** Skip the hard-link probe (it creates and removes two files under `.carton/`). */
  skipLinkProbe?: boolean;
  probe?: LocationProbe;
}

const MSDOS_SUPER_MAGIC = 0x4d44;
const EXFAT_SUPER_MAGIC = 0x2011bab0;
// NFS, SMB, CIFS, SMB2, AFS, Coda, 9p (linux/magic.h)
const NETWORK_MAGIC = new Set([0x6969, 0x517b, 0xff534d42, 0xfe534d42, 0x5346414f, 0x73757245, 0x01021997]);
// Network file-system types as the mount table names them. NFS on macOS keeps hard links, so without this the link
// probe would keep the database on the share. Linux FUSE clients (sshfs, rclone…) all have the same statfs magic.
const NETWORK_FS_TYPES: Partial<Record<NodeJS.Platform, Set<string>>> = {
  darwin: new Set(["nfs", "smbfs", "afpfs", "webdav", "cifs", "ftp"]),
  linux: new Set(["nfs", "nfs4", "cifs", "smb3", "smbfs", "9p", "afs", "ceph", "glusterfs", "fuse.glusterfs", "fuse.sshfs", "fuse.rclone", "fuse.s3fs", "davfs", "fuse.davfs2"]),
};

/** Decide where carton.db lives for a bundle. Never throws for an odd folder; the worst case is app data. */
export function locateCartonDb(opts: LocateOptions): DbLocation {
  const probe = opts.probe ?? nodeProbe();
  const p = pathFor(probe.platform);
  const bundle = p.resolve(opts.bundleDir);
  const inBundle: DbLocation = { dbPath: p.join(bundle, ".carton", "carton.db"), inBundle: true, placement: "bundle" };
  const away = (placement: DbPlacement, extra: Partial<DbLocation>): DbLocation => ({
    dbPath: p.join(opts.appDataDir ?? defaultAppDataDir(probe), "projects", projectKey(opts.projectId), "carton.db"),
    inBundle: false,
    placement,
    ...extra,
    warning: placement === "cloud-sync"
      ? `This project is in a folder synced by ${extra.provider ?? "a sync client"}. Its history is kept on this computer only. Syncing project folders between computers is not a way to collaborate: use Share or a .cbproj copy.`
      : placement === "no-hard-links"
        ? "This project is on a FAT or exFAT drive. Its history is kept on this computer only, and a save from another program can be overwritten in a very short window."
        : placement === "network"
          ? "This project is on a network drive. Its history is kept on this computer only. To work on it with others, use Share or a .cbproj copy."
          : "This project folder cannot be written. Its history is kept on this computer only.",
  });

  const real = probe.realPath(bundle);
  const sync = cloudSyncOf(bundle, p.resolve(real), probe);
  if (sync) return away("cloud-sync", sync);

  if (probe.platform === "win32") {
    if (/^\\\\(?![?.]\\)/.test(real) || /^\\\\\?\\UNC\\/i.test(real)) return away("network", { root: real });
  }
  if (probe.platform === "linux") {
    const magic = probe.fsMagic(bundle);
    if (magic === MSDOS_SUPER_MAGIC || magic === EXFAT_SUPER_MAGIC) return away("no-hard-links", { root: bundle });
    if (magic !== null && NETWORK_MAGIC.has(magic >>> 0)) return away("network", { root: bundle });
  }
  const share = networkMount(p.resolve(real), probe);
  if (share) return away("network", { root: share });
  if (!opts.skipLinkProbe) {
    const r = probe.linkProbe(p.join(bundle, ".carton"));
    if (r === "no-links") return away("no-hard-links", { root: bundle });
    if (r === "not-writable") return away("not-writable", { root: bundle });
  }
  return inBundle;
}

/** The sync client whose folder holds `dir`, or null. Path rules and marker files only; writes nothing. */
export function detectCloudSync(dir: string, probe: LocationProbe = nodeProbe()): { provider: string; root: string } | null {
  const p = pathFor(probe.platform);
  const target = p.resolve(dir);
  return cloudSyncOf(target, p.resolve(probe.realPath(target)), probe);
}

// `lexical` is the folder as given, `physical` the same folder with links resolved. Both are checked: a symlink from
// an ordinary folder into a synced one leaves only the physical path inside the sync root, and a link inside a sync
// root to somewhere else is still a folder the client sees.
function cloudSyncOf(lexical: string, physical: string, probe: LocationProbe): { provider: string; root: string } | null {
  const p = pathFor(probe.platform);
  const fold = foldFor(probe.platform);
  const targets = lexical === physical ? [lexical] : [lexical, physical];
  const folded = targets.map(fold);
  const within = (root: string) => { const r = fold(root); return folded.some((t) => isWithin(t, r, p.sep)); };
  // A root can itself be a link (OneDrive's known-folder redirection makes junctions), so its physical path counts too.
  const matches = (root: string) => { const r = p.resolve(root); return within(r) || within(p.resolve(probe.realPath(r))); };
  const roots: { provider: string; root: string }[] = [];
  const add = (provider: string, root: string | undefined) => { if (root) roots.push({ provider, root: p.resolve(root) }); };
  const home = probe.home;

  if (probe.platform === "win32") {
    add("OneDrive", probe.env.OneDrive);
    add("OneDrive", probe.env.OneDriveConsumer);
    add("OneDrive", probe.env.OneDriveCommercial);
    for (const base of [probe.env.APPDATA, probe.env.LOCALAPPDATA]) if (base) for (const r of dropboxRoots(probe, p.join(base, "Dropbox", "info.json"))) add("Dropbox", r);
    add("iCloud Drive", p.join(home, "iCloudDrive"));
    add("Box", p.join(home, "Box"));
  } else if (probe.platform === "darwin") {
    // File Provider clients (OneDrive, Dropbox, Google Drive, Box…) all live under ~/Library/CloudStorage; iCloud Drive
    // under ~/Library/Mobile Documents. "Desktop & Documents in iCloud" makes ~/Desktop and ~/Documents synced too;
    // iCloud then shows them inside CloudDocs. (Not checked on a real Mac: L7.)
    add("cloud storage", p.join(home, "Library", "CloudStorage"));
    add("iCloud Drive", p.join(home, "Library", "Mobile Documents"));
    const docs = p.join(home, "Library", "Mobile Documents", "com~apple~CloudDocs");
    for (const name of ["Desktop", "Documents"]) if (probe.exists(p.join(docs, name))) add("iCloud Drive", p.join(home, name));
    for (const r of dropboxRoots(probe, p.join(home, ".dropbox", "info.json"))) add("Dropbox", r);
  } else {
    for (const r of dropboxRoots(probe, p.join(home, ".dropbox", "info.json"))) add("Dropbox", r);
  }
  for (const r of roots) if (matches(r.root)) return r;

  // Marker files a sync client keeps at its root, checked on the folder and every ancestor of both paths (one readdir
  // each; ancestors the two paths share are read once).
  const seen = new Set<string>();
  for (const start of targets) {
    for (let cur = start, i = 0; i < 64; i++) {
      const key = fold(cur);
      if (seen.has(key)) break; // the rest of this chain was read from the other path
      seen.add(key);
      const names = probe.readDir(cur);
      if (names) {
        const hit = markerProvider(names);
        if (hit) return { provider: hit, root: cur };
      }
      const up = p.dirname(cur);
      if (up === cur) break;
      cur = up;
    }
  }

  // Windows cloud-files sync roots registered with the OS (OneDrive, Dropbox, Box, iCloud, Nextcloud VFS…). The
  // registry export spawns reg.exe, so it runs only when nothing cheaper matched.
  if (probe.platform === "win32") for (const root of probe.windowsSyncRoots()) if (matches(root)) return { provider: "a cloud sync client", root };
  return null;
}

function markerProvider(names: string[]): string | null {
  for (const n of names) {
    switch (n) {
      case ".dropbox":
      case ".dropbox.cache":
        return "Dropbox";
      case ".stfolder":
        return "Syncthing";
      case ".tmp.drivedownload":
      case ".tmp.driveupload":
        return "Google Drive";
      case ".owncloudsync.log":
        return "Nextcloud";
      case ".sync":
        return "Resilio Sync";
    }
    if (/^\._?sync_[0-9a-f]+\.db$/i.test(n)) return "Nextcloud";
  }
  return null;
}

function dropboxRoots(probe: LocationProbe, infoPath: string): string[] {
  const text = probe.readText(infoPath);
  if (!text) return [];
  try {
    const info = JSON.parse(text) as Record<string, { path?: unknown }>;
    return Object.values(info).map((v) => v?.path).filter((x): x is string => typeof x === "string" && x.length > 0);
  } catch {
    return [];
  }
}

/** The mount point holding `physical` when its file system is a network one (macOS and Linux), else null. */
function networkMount(physical: string, probe: LocationProbe): string | null {
  const types = NETWORK_FS_TYPES[probe.platform];
  const table = types ? probe.mountTable() : null;
  if (!types || !table) return null;
  const fold = foldFor(probe.platform);
  const t = fold(physical);
  let best: { at: string; type: string } | null = null;
  // The longest mount point wins; of equal ones the later line, which Linux lists for the mount stacked on top.
  for (const m of parseMounts(probe.platform, table)) if (isWithin(t, fold(m.at), "/") && (!best || m.at.length >= best.at.length)) best = m;
  return best && types.has(best.type) ? best.at : null;
}

function parseMounts(platform: NodeJS.Platform, table: string): { at: string; type: string }[] {
  const out: { at: string; type: string }[] = [];
  for (const line of table.split("\n")) {
    if (platform === "linux") {
      // mountinfo: "36 35 98:0 /mnt1 /mnt/parent rw,noatime master:1 - ext3 /dev/root rw". Optional fields run up to
      // the "-"; spaces, tabs, newlines and backslashes in paths are octal escapes (\040).
      const f = line.split(" ");
      const sep = f.indexOf("-", 6);
      if (sep < 0 || sep + 1 >= f.length) continue;
      out.push({ at: f[4].replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8))), type: f[sep + 1] });
    } else {
      // macOS mount: "//ana@nas/video on /Volumes/video (smbfs, nodev, nosuid, mounted by ana)". Paths are printed as
      // they are, so the device ends at the first " on /" and the type is the first word of the last parentheses.
      const m = /^.*? on (\/.*) \(([^,()]+)[^()]*\)\s*$/.exec(line);
      if (m) out.push({ at: m[1], type: m[2].trim() });
    }
  }
  return out;
}

/** The per-OS app-data folder for Carton. Local, never roaming: a roaming profile would copy the live database. */
export function defaultAppDataDir(probe: Pick<LocationProbe, "platform" | "env" | "home"> = nodeProbe()): string {
  const p = pathFor(probe.platform);
  if (probe.platform === "win32") return p.join(probe.env.LOCALAPPDATA ?? p.join(probe.home, "AppData", "Local"), "Carton");
  if (probe.platform === "darwin") return p.join(probe.home, "Library", "Application Support", "Carton");
  return p.join(probe.env.XDG_DATA_HOME || p.join(probe.home, ".local", "share"), "carton");
}

/** A file-name-safe key for a project id: the id itself when it is plain, else `_` and a hash of it. */
export function projectKey(projectId: string): string {
  // Plain: lower case (ids that differ only in case would share a folder on Windows and macOS), no dots (trailing dots
  // and ".."), and not a Windows device name (CON, NUL, COM1…), which Windows can't create. A plain id never starts
  // with "_", so it can't equal another id's hashed key.
  if (/^[a-z0-9][a-z0-9_-]{0,99}$/.test(projectId) && !/^(con|prn|aux|nul|com\d|lpt\d)$/.test(projectId)) return projectId;
  return `_${sha256hex(projectId).slice(0, 32)}`;
}
const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

const pathFor = (platform: NodeJS.Platform) => (platform === "win32" ? nodePath.win32 : nodePath.posix);
// Windows and macOS (by default) compare paths case-insensitively.
const foldFor = (platform: NodeJS.Platform) => (platform === "win32" || platform === "darwin" ? (s: string) => s.toLowerCase() : (s: string) => s);
// `t` is `root` or inside it; both already folded.
const isWithin = (t: string, root: string, sep: string) => t === root || t.startsWith(root.endsWith(sep) ? root : root + sep);

/** The fs calls the hard-link probe makes. Injectable, so a test can fail the cleanup the way Windows antivirus does. */
export type LinkProbeFs = Pick<typeof fs, "mkdirSync" | "writeFileSync" | "linkSync" | "rmSync">;

/** The hard-link probe of `nodeProbe`. Its cleanup never throws and never replaces the probe's answer. */
export function makeLinkProbe(f: LinkProbeFs = fs): LocationProbe["linkProbe"] {
  return (dir) => {
    const tag = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    const a = nodePath.join(dir, `.link-probe-${tag}`);
    const b = `${a}.l`;
    try {
      f.mkdirSync(dir, { recursive: true });
      f.writeFileSync(a, "");
    } catch {
      return "not-writable";
    }
    let r: "ok" | "no-links";
    try {
      f.linkSync(a, b);
      r = "ok";
    } catch {
      // EPERM/ENOTSUP/EISDIR (libuv's mapping of ERROR_INVALID_FUNCTION) on FAT and exFAT; anything else also
      // means the materializer cannot rely on links here.
      r = "no-links";
    }
    removeQuietly(f, b);
    removeQuietly(f, a);
    return r;
  };
}

const sleepCell = new Int32Array(new SharedArrayBuffer(4));

// Remove a file of ours, retrying briefly: on Windows an antivirus or indexer opens a new file at once, and deleting it
// meanwhile fails with EPERM or EBUSY. Gives up silently; the names are unique, so one left behind is harmless.
function removeQuietly(f: Pick<LinkProbeFs, "rmSync">, file: string): void {
  for (let i = 0; i < 5; i++) {
    try {
      f.rmSync(file, { force: true });
      return;
    } catch {
      try { if (i < 4) Atomics.wait(sleepCell, 0, 0, 10); } catch { /* a thread that may not block: retry at once */ }
    }
  }
}

const SYNC_ROOT_MANAGER = "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\SyncRootManager";
const SYNC_ROOTS_MAX_AGE_MS = 10 * 60_000;

/**
 * Windows sync roots through a JSON file (`{ at, roots }`) reused while under ten minutes old; otherwise `query` runs
 * and its answer is saved (null means it failed: nothing is saved). `cb` is a short process started for each agent
 * call, so an in-process cache alone would still spawn reg.exe every time.
 */
export function cachedSyncRoots(file: string, query: () => string[] | null, now = Date.now()): string[] {
  try {
    const c = JSON.parse(fs.readFileSync(file, "utf8")) as { at?: unknown; roots?: unknown };
    const age = typeof c.at === "number" ? now - c.at : -1;
    if (age >= 0 && age < SYNC_ROOTS_MAX_AGE_MS && Array.isArray(c.roots) && c.roots.every((r) => typeof r === "string")) return c.roots as string[];
  } catch {
    // missing, half-written by an older process, or not JSON: ask again
  }
  const roots = query();
  if (roots) writeQuietly(file, JSON.stringify({ at: now, roots }));
  return roots ?? [];
}

// Write through a temp file and a rename, so a reader never sees half a file. A cache: failures are ignored.
function writeQuietly(file: string, text: string): void {
  const tmp = `${file}.${process.pid}-${Math.random().toString(36).slice(2, 10)}.tmp`;
  try {
    fs.mkdirSync(nodePath.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch {
    removeQuietly(fs, tmp);
  }
}

// `reg export` always writes UTF-16LE, while `reg query` prints in the console code page (437, 850, 932…), which
// mangles a root such as C:\Users\Zoë\OneDrive.
function exportSyncRoots(): string[] | null {
  const file = nodePath.join(os.tmpdir(), `carton-sync-roots-${process.pid}-${Math.random().toString(36).slice(2, 10)}.reg`);
  // By full path: a bare "reg" is looked up in the current folder first, which may be a project folder.
  const reg = nodePath.join(process.env.SystemRoot || "C:\\Windows", "System32", "reg.exe");
  try {
    execFileSync(reg, ["export", SYNC_ROOT_MANAGER, file, "/y"], { windowsHide: true, timeout: 3000, stdio: "ignore" });
    return parseSyncRootManager(fs.readFileSync(file));
  } catch {
    // reg exits with 1 for a missing key and for every other failure alike. Not knowing must never be saved as "no
    // sync roots" (that would put a live database inside a OneDrive or Box folder for ten minutes), so it is null.
    return null;
  } finally {
    removeQuietly(fs, file);
  }
}

let syncRootsCache: string[] | null = null;
let macMounts: { at: number; table: string | null } | null = null;

/** The real OS behind `LocationProbe`. */
export function nodeProbe(): LocationProbe {
  return {
    platform: process.platform,
    env: process.env,
    home: os.homedir(),
    exists: (p) => fs.existsSync(p),
    readDir: (p) => { try { return fs.readdirSync(p); } catch { return null; } },
    readText: (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } },
    fsMagic: (p) => {
      if (process.platform !== "linux") return null;
      // The bundle may not exist yet (a new project): ask about the nearest existing ancestor.
      for (let cur = p; ; cur = nodePath.dirname(cur)) {
        try { return fs.statfsSync(cur).type; } catch { if (nodePath.dirname(cur) === cur) return null; }
      }
    },
    realPath: (p) => {
      for (let cur = p, rest = ""; ; ) {
        try { return nodePath.join(fs.realpathSync.native(cur), rest); } catch {
          const up = nodePath.dirname(cur);
          if (up === cur) return p;
          rest = nodePath.join(nodePath.basename(cur), rest);
          cur = up;
        }
      }
    },
    mountTable: () => {
      if (process.platform === "linux") { try { return fs.readFileSync("/proc/self/mountinfo", "utf8"); } catch { return null; } }
      if (process.platform !== "darwin") return null;
      // Spawning mount is slow next to the other checks, so its output is kept a minute: long enough for a `cb`
      // process, short enough that the app sees a share mounted while it runs.
      const now = performance.now();
      if (macMounts && now - macMounts.at < 60_000) return macMounts.table;
      let table: string | null = null;
      try {
        table = execFileSync("/sbin/mount", [], { encoding: "utf8", timeout: 3000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      } catch {
        // no information: the link probe decides
      }
      macMounts = { at: now, table };
      return table;
    },
    linkProbe: makeLinkProbe(fs),
    windowsSyncRoots: () => {
      if (process.platform !== "win32") return [];
      syncRootsCache ??= cachedSyncRoots(nodePath.join(defaultAppDataDir({ platform: process.platform, env: process.env, home: os.homedir() }), "sync-roots.json"), exportSyncRoots);
      return syncRootsCache;
    },
  };
}

/**
 * Paths from `reg export …\SyncRootManager` (.reg text, or the file's UTF-16LE bytes): the string values under each
 * provider's `UserSyncRoots` key, one per user SID, e.g. `"S-1-5-21-…"="C:\\Users\\Zoë\\OneDrive"`.
 */
export function parseSyncRootManager(reg: string | Uint8Array): string[] {
  const text = typeof reg === "string" ? reg : Buffer.from(reg.buffer, reg.byteOffset, reg.byteLength).toString("utf16le");
  const out: string[] = [];
  let inUserRoots = false;
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const section = /^\[(.*)\]\s*$/.exec(line);
    if (section) { inUserRoots = /\\UserSyncRoots$/i.test(section[1]); continue; }
    if (!inUserRoots) continue;
    // Only plain strings ("name"="value", with \\ and \" escaped); hex(2):, dword: and the like are not paths.
    const m = /^"(?:[^"\\]|\\.)*"="((?:[^"\\]|\\.)*)"\s*$/.exec(line);
    if (m) out.push(m[1].replace(/\\(.)/g, "$1"));
  }
  return out;
}
