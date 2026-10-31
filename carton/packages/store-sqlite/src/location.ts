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
// Detection is cheap path and marker checks first. Nothing is written into a folder that looks cloud-synced (a
// probe file would be uploaded). Otherwise one hard-link probe inside `.carton/` decides FAT/exFAT on every OS,
// because Windows reports no file-system type through Node and macOS's statfs type numbers are not stable.
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
  /** The real path. On Windows this turns a mapped network drive into its `\\server\share` path. */
  realPath(p: string): string;
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

  const sync = detectCloudSync(bundle, probe);
  if (sync) return away("cloud-sync", sync);

  if (probe.platform === "win32") {
    const real = probe.realPath(bundle);
    if (/^\\\\(?![?.]\\)/.test(real) || /^\\\\\?\\UNC\\/i.test(real)) return away("network", { root: real });
  }
  if (probe.platform === "linux") {
    const magic = probe.fsMagic(bundle);
    if (magic === MSDOS_SUPER_MAGIC || magic === EXFAT_SUPER_MAGIC) return away("no-hard-links", { root: bundle });
    if (magic !== null && NETWORK_MAGIC.has(magic >>> 0)) return away("network", { root: bundle });
  }
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

  const fold = foldFor(probe.platform);
  const t = fold(target);
  const within = (root: string) => { const r = fold(root); return t === r || t.startsWith(r.endsWith(p.sep) ? r : r + p.sep); };
  for (const r of roots) if (within(r.root)) return r;

  // Marker files a sync client keeps at its root, checked on the folder and every ancestor (one readdir each).
  for (let cur = target, i = 0; i < 64; i++) {
    const names = probe.readDir(cur);
    if (names) {
      const hit = markerProvider(names);
      if (hit) return { provider: hit, root: cur };
    }
    const up = p.dirname(cur);
    if (up === cur) break;
    cur = up;
  }

  // Windows cloud-files sync roots registered with the OS (OneDrive, Dropbox, Box, iCloud, Nextcloud VFS…). The
  // registry query spawns reg.exe once, so it runs only when nothing cheaper matched.
  if (probe.platform === "win32") for (const root of probe.windowsSyncRoots()) if (within(p.resolve(root))) return { provider: "a cloud sync client", root };
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

/** The per-OS app-data folder for Carton. Local, never roaming: a roaming profile would copy the live database. */
export function defaultAppDataDir(probe: Pick<LocationProbe, "platform" | "env" | "home"> = nodeProbe()): string {
  const p = pathFor(probe.platform);
  if (probe.platform === "win32") return p.join(probe.env.LOCALAPPDATA ?? p.join(probe.home, "AppData", "Local"), "Carton");
  if (probe.platform === "darwin") return p.join(probe.home, "Library", "Application Support", "Carton");
  return p.join(probe.env.XDG_DATA_HOME || p.join(probe.home, ".local", "share"), "carton");
}

/** A file-name-safe key for a project id: the id itself when it is plain, else a hash of it. */
export function projectKey(projectId: string): string {
  // No dots (trailing dots and "..") and no Windows device names (CON, NUL, COM1…), which Windows can't create.
  if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(projectId) && !/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(projectId)) {
    // Ids that differ only in case would share a folder on Windows and macOS; the hash keeps them apart.
    return projectId.toLowerCase() === projectId ? projectId : `${projectId.toLowerCase()}-${sha256hex(projectId).slice(0, 8)}`;
  }
  return `p-${sha256hex(projectId).slice(0, 32)}`;
}
const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

const pathFor = (platform: NodeJS.Platform) => (platform === "win32" ? nodePath.win32 : nodePath.posix);
// Windows and macOS (by default) compare paths case-insensitively.
const foldFor = (platform: NodeJS.Platform) => (platform === "win32" || platform === "darwin" ? (s: string) => s.toLowerCase() : (s: string) => s);

let syncRootsCache: string[] | null = null;

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
    linkProbe: (dir) => {
      const tag = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
      const a = nodePath.join(dir, `.link-probe-${tag}`);
      const b = `${a}.l`;
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(a, "");
      } catch {
        return "not-writable";
      }
      try {
        fs.linkSync(a, b);
        return "ok";
      } catch {
        // EPERM/ENOTSUP/EISDIR (libuv's mapping of ERROR_INVALID_FUNCTION) on FAT and exFAT; anything else also
        // means the materializer cannot rely on links here.
        return "no-links";
      } finally {
        fs.rmSync(b, { force: true });
        fs.rmSync(a, { force: true });
      }
    },
    windowsSyncRoots: () => {
      if (process.platform !== "win32") return [];
      if (syncRootsCache) return syncRootsCache;
      try {
        const out = execFileSync("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\SyncRootManager", "/s"], { encoding: "utf8", windowsHide: true, timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
        syncRootsCache = parseSyncRootManager(out);
      } catch {
        syncRootsCache = [];
      }
      return syncRootsCache;
    },
  };
}

/** Paths from `reg query …\SyncRootManager /s`: the values under each provider's `UserSyncRoots` key (one per user SID). */
export function parseSyncRootManager(regOutput: string): string[] {
  const out: string[] = [];
  let inUserRoots = false;
  for (const line of regOutput.split(/\r?\n/)) {
    if (/^HKEY_/i.test(line)) { inUserRoots = /\\UserSyncRoots$/i.test(line.trim()); continue; }
    if (!inUserRoots) continue;
    const m = /^\s+\S+\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}
