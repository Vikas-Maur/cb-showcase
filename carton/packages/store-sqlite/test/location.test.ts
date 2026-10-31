// Where carton.db lives (§6.4, L15). The Windows and macOS rules run here through a faked LocationProbe; the real
// probe (link test, statfs, symlinks, mount table, SyncRootManager) is exercised on this OS, and on Windows in the
// Windows run.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { locateCartonDb, detectCloudSync, defaultAppDataDir, projectKey, parseSyncRootManager, nodeProbe, makeLinkProbe, cachedSyncRoots, type LocationProbe, type LinkProbeFs } from "../src/location.ts";
import { scratch } from "./scratch.ts";

function fake(over: Partial<LocationProbe> & { files?: Record<string, string>; dirs?: Record<string, string[]> }): LocationProbe {
  const files = over.files ?? {};
  const dirs = over.dirs ?? {};
  const probes: string[] = [];
  return {
    platform: "linux",
    env: {},
    home: "/home/u",
    exists: (p) => p in files || p in dirs,
    readDir: (p) => dirs[p] ?? null,
    readText: (p) => files[p] ?? null,
    fsMagic: () => 0xef53,
    realPath: (p) => p,
    mountTable: () => null,
    linkProbe: (d) => { probes.push(d); return "ok"; },
    windowsSyncRoots: () => [],
    ...over,
  };
}

test("a plain local folder keeps carton.db in the bundle", () => {
  const loc = locateCartonDb({ bundleDir: "/home/u/Videos/Promo.cardboard", projectId: "p1", probe: fake({}) });
  assert.deepEqual(loc, { dbPath: "/home/u/Videos/Promo.cardboard/.carton/carton.db", inBundle: true, placement: "bundle" });
});

test("Windows OneDrive (env root, any case) moves carton.db to LOCALAPPDATA keyed by project id", () => {
  const probe = fake({
    platform: "win32",
    home: "C:\\Users\\Ana",
    env: { OneDrive: "C:\\Users\\Ana\\OneDrive", LOCALAPPDATA: "C:\\Users\\Ana\\AppData\\Local" },
  });
  const loc = locateCartonDb({ bundleDir: "c:\\users\\ana\\onedrive\\Documents\\Promo", projectId: "8f0c2a1e-1d2b-4c3d-9e8f-0a1b2c3d4e5f", probe });
  assert.equal(loc.inBundle, false);
  assert.equal(loc.placement, "cloud-sync");
  assert.equal(loc.provider, "OneDrive");
  assert.equal(loc.dbPath, "C:\\Users\\Ana\\AppData\\Local\\Carton\\projects\\8f0c2a1e-1d2b-4c3d-9e8f-0a1b2c3d4e5f\\carton.db");
  assert.match(loc.warning!, /OneDrive.*Share or a \.cbproj/);
});

test("a folder that only shares a prefix with a sync root is not inside it", () => {
  const probe = fake({ platform: "win32", home: "C:\\Users\\Ana", env: { OneDrive: "C:\\Users\\Ana\\OneDrive" } });
  assert.equal(detectCloudSync("C:\\Users\\Ana\\OneDrive2\\Promo", probe), null);
  assert.equal(detectCloudSync("C:\\Users\\Ana\\OneDrive", probe)?.provider, "OneDrive");
});

test("Dropbox roots come from info.json on every OS", () => {
  const win = fake({
    platform: "win32",
    home: "C:\\Users\\Ana",
    env: { APPDATA: "C:\\Users\\Ana\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\Ana\\AppData\\Local" },
    files: { "C:\\Users\\Ana\\AppData\\Local\\Dropbox\\info.json": JSON.stringify({ personal: { path: "D:\\Dropbox" }, business: { path: "D:\\Dropbox (Acme)" } }) },
  });
  assert.equal(detectCloudSync("D:\\Dropbox (Acme)\\clients\\x", win)?.provider, "Dropbox");
  assert.equal(detectCloudSync("D:\\Other", win), null);
  const mac = fake({ platform: "darwin", home: "/Users/ana", files: { "/Users/ana/.dropbox/info.json": "{\"personal\":{\"path\":\"/Users/ana/Dropbox\"}}" } });
  assert.equal(detectCloudSync("/Users/ana/Dropbox/p", mac)?.provider, "Dropbox");
  assert.equal(detectCloudSync("/Users/ana/Movies/p", mac), null);
  assert.equal(detectCloudSync("/Users/ana/Dropbox/p", fake({ platform: "darwin", home: "/Users/ana", files: { "/Users/ana/.dropbox/info.json": "{not json" } })), null);
});

test("macOS File Provider, iCloud Drive and iCloud Desktop & Documents", () => {
  const mac = fake({ platform: "darwin", home: "/Users/ana", dirs: { "/Users/ana/Library/Mobile Documents/com~apple~CloudDocs/Documents": [] } });
  assert.equal(detectCloudSync("/Users/ana/Library/CloudStorage/OneDrive-Personal/p", mac)?.provider, "cloud storage");
  assert.equal(detectCloudSync("/users/ana/library/mobile documents/com~apple~CloudDocs/p", mac)?.provider, "iCloud Drive");
  assert.equal(detectCloudSync("/Users/ana/Documents/Cardboard/p", mac)?.provider, "iCloud Drive");
  assert.equal(detectCloudSync("/Users/ana/Desktop/p", mac), null, "Desktop is synced only when iCloud shows it");
});

test("marker files on the folder or an ancestor (Syncthing, Google Drive, Nextcloud, Dropbox)", () => {
  const at = (dir: string, names: string[]) => fake({ dirs: { [dir]: names } });
  assert.equal(detectCloudSync("/data/sync/a/b", at("/data/sync", [".stfolder", "a"]))?.provider, "Syncthing");
  assert.equal(detectCloudSync("/data/sync/a/b", at("/data/sync", [".stfolder"]))?.root, "/data/sync");
  assert.equal(detectCloudSync("/m/a", at("/m", [".tmp.drivedownload"]))?.provider, "Google Drive");
  assert.equal(detectCloudSync("/n/a", at("/n", ["._sync_0a1b2c3d4e5f.db"]))?.provider, "Nextcloud");
  assert.equal(detectCloudSync("/d/a", at("/d/a", [".dropbox.cache"]))?.provider, "Dropbox");
  assert.equal(detectCloudSync("/x/a", at("/x", ["sync_notes.db", ".stfolderish"])), null);
});

test("Windows cloud-files sync roots from SyncRootManager, queried only when nothing cheaper matched", () => {
  let calls = 0;
  const probe = fake({ platform: "win32", home: "C:\\Users\\Ana", windowsSyncRoots: () => { calls++; return ["E:\\Box Sync"]; } });
  assert.equal(detectCloudSync("e:\\box sync\\p", probe)?.root, "E:\\Box Sync");
  assert.equal(calls, 1);
});

test("SyncRootManager from `reg export`: UTF-16LE .reg text, non-ASCII roots, escapes, plain strings only", () => {
  const key = "[HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\SyncRootManager";
  const sid = "S-1-5-21-1004336348-1177238915-682003330-1001";
  const reg = [
    "Windows Registry Editor Version 5.00",
    "",
    `${key}]`,
    "",
    `${key}\\OneDrive!${sid}!Personal|6b1d9f2a]`,
    "\"DisplayNameResource\"=\"OneDrive - Personal\"",
    "\"Flags\"=dword:00000022",
    "\"IconResource\"=hex(2):43,00,3a,00,5c,00,50,00,72,00,6f,00,67,00,72,00,61,00,6d,00,20,00,46,00,69,00,\\",
    "  6c,00,65,00,73,00,00,00",
    "",
    `${key}\\OneDrive!${sid}!Personal|6b1d9f2a\\UserSyncRoots]`,
    `"${sid}"="C:\\\\Users\\\\Zoë\\\\OneDrive"`,
    "",
    `${key}\\Nextcloud!${sid}!work\\UserSyncRoots]`,
    // a root at a drive's top: the value ends in an escaped backslash, not an escaped quote
    `"${sid}"="E:\\\\"`,
    // not a Windows path (no path holds a quote), but proves the unescape
    `"${sid} \\"2\\""="F:\\\\a \\"b\\""`,
    `"S-1-5-21-9"=hex(2):45,00,3a,00,5c,00,42,00,6f,00,78,00,00,00`,
    "",
    `${key}\\Dropbox!${sid}!123456]`,
    "\"DisplayNameResource\"=\"Dropbox \\\"Work\\\"\"",
    "",
    `${key}\\Dropbox!${sid}!123456\\UserSyncRoots]`,
    `"${sid}"="D:\\\\Dropbox (Acme)"`,
    "",
  ].join("\r\n");
  const roots = ["C:\\Users\\Zoë\\OneDrive", "E:\\", "F:\\a \"b\"", "D:\\Dropbox (Acme)"];
  assert.deepEqual(parseSyncRootManager(reg), roots);
  // What reg export writes: UTF-16LE with a byte-order mark.
  assert.deepEqual(parseSyncRootManager(Buffer.from(`\uFEFF${reg}`, "utf16le")), roots);
  assert.deepEqual(parseSyncRootManager(""), []);
});

test("Windows sync roots are kept in a file for ten minutes, written whole; a failed query is not kept", () => {
  const dir = scratch("roots");
  const file = path.join(dir, "Carton", "sync-roots.json");
  const roots = ["C:\\Users\\Zoë\\OneDrive"];
  let calls = 0;
  const query = () => { calls++; return roots; };
  const t0 = Date.now();
  assert.deepEqual(cachedSyncRoots(file, query, t0), roots);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { at: t0, roots });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["sync-roots.json"], "no temp file left behind");
  assert.deepEqual(cachedSyncRoots(file, query, t0 + 9 * 60_000), roots);
  assert.equal(calls, 1, "a fresh file answers");
  cachedSyncRoots(file, query, t0 + 10 * 60_000);
  assert.equal(calls, 2, "ten minutes old: asked again");
  cachedSyncRoots(file, query, t0);
  assert.equal(calls, 3, "written in the future (the clock went back): asked again");
  fs.writeFileSync(file, "{\"at\":");
  cachedSyncRoots(file, query, t0);
  assert.equal(calls, 4, "half a file: asked again");
  fs.writeFileSync(file, JSON.stringify({ at: t0, roots: [1] }));
  cachedSyncRoots(file, query, t0);
  assert.equal(calls, 5, "roots that aren't strings: asked again");
  const failed = path.join(dir, "failed.json");
  assert.deepEqual(cachedSyncRoots(failed, () => null, t0), []);
  assert.ok(!fs.existsSync(failed));
});

test("FAT/exFAT: Linux statfs magic, and the hard-link probe everywhere else", () => {
  const vfat = locateCartonDb({ bundleDir: "/media/usb/p", projectId: "p1", probe: fake({ fsMagic: () => 0x4d44 }) });
  assert.equal(vfat.placement, "no-hard-links");
  assert.equal(vfat.dbPath, "/home/u/.local/share/carton/projects/p1/carton.db");
  assert.equal(locateCartonDb({ bundleDir: "/media/x/p", projectId: "p1", probe: fake({ fsMagic: () => 0x2011bab0 }) }).placement, "no-hard-links");
  const win = fake({ platform: "win32", home: "C:\\Users\\Ana", env: { LOCALAPPDATA: "C:\\L" }, fsMagic: () => null, linkProbe: () => "no-links" });
  const loc = locateCartonDb({ bundleDir: "F:\\Promo", projectId: "p1", probe: win });
  assert.equal(loc.placement, "no-hard-links");
  assert.equal(loc.dbPath, "C:\\L\\Carton\\projects\\p1\\carton.db");
  assert.match(loc.warning!, /FAT or exFAT/);
  assert.equal(locateCartonDb({ bundleDir: "F:\\Promo", projectId: "p1", probe: { ...win, linkProbe: () => "not-writable" } }).placement, "not-writable");
});

test("network shares: a UNC path or a mapped drive on Windows, NFS/SMB on Linux", () => {
  const win = (bundle: string, real: string) => fake({ platform: "win32", home: "C:\\Users\\A", env: { LOCALAPPDATA: "C:\\L" }, realPath: (p) => (p === bundle ? real : p) });
  assert.equal(locateCartonDb({ bundleDir: "Z:\\Promo", projectId: "p1", probe: win("Z:\\Promo", "\\\\nas\\video\\Promo") }).placement, "network");
  assert.equal(locateCartonDb({ bundleDir: "\\\\nas\\video\\Promo", projectId: "p1", probe: win("\\\\nas\\video\\Promo", "\\\\?\\UNC\\nas\\video\\Promo") }).placement, "network");
  assert.equal(locateCartonDb({ bundleDir: "C:\\Promo", projectId: "p1", probe: win("C:\\Promo", "C:\\Promo") }).placement, "bundle");
  assert.equal(locateCartonDb({ bundleDir: "/mnt/nas/p", projectId: "p1", probe: fake({ fsMagic: () => 0x6969 }) }).placement, "network");
  assert.equal(locateCartonDb({ bundleDir: "/mnt/smb/p", projectId: "p1", probe: fake({ fsMagic: () => 0xfe534d42 | 0 }) }).placement, "network");
});

test("macOS network volumes (SMB, NFS, AFP, WebDAV) come from the mount table, by the longest mount point", () => {
  const table = [
    "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)",
    "devfs on /dev (devfs, local, nobrowse)",
    "/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect)",
    "map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)",
    "//ana@nas/video on /Volumes/video (smbfs, nodev, nosuid, mounted by ana)",
    "nas:/export on /Volumes/x (nfs, asynchronous)",
    "//ana@nas._afpovertcp._tcp.local/Work on NAS on /Volumes/Work on NAS (afpfs, nodev, nosuid, mounted by ana)",
    "//ana@nas/backup on /Volumes/Video (Backup) (smbfs, nodev, nosuid, mounted by ana)",
    "https://dav.example.com/remote.php/webdav/ on /Volumes/dav (webdav, nodev, noexec, nosuid, mounted by ana)",
    "/dev/disk5s1 on /Volumes/video/scratch (apfs, local, nodev, nosuid, journaled, noowners, mounted by ana)",
  ].join("\n");
  const mac = (over: Partial<LocationProbe> = {}) => fake({ platform: "darwin", home: "/Users/ana", fsMagic: () => null, mountTable: () => table, ...over });
  const at = (bundleDir: string, probe = mac()) => {
    const loc = locateCartonDb({ bundleDir, projectId: "p1", probe });
    return loc.placement === "network" ? `network ${loc.root}` : loc.placement;
  };
  assert.equal(at("/Volumes/video/Promo"), "network /Volumes/video");
  assert.equal(at("/volumes/VIDEO/Promo"), "network /Volumes/video", "case-insensitive like APFS");
  assert.equal(at("/Volumes/x/p"), "network /Volumes/x");
  assert.equal(at("/Volumes/Work on NAS/p"), "network /Volumes/Work on NAS");
  assert.equal(at("/Volumes/Video (Backup)/p"), "network /Volumes/Video (Backup)");
  assert.equal(at("/Volumes/dav/p"), "network /Volumes/dav");
  assert.equal(at("/Volumes/video/scratch/p"), "bundle", "a local disk mounted inside the share");
  assert.equal(at("/Volumes/videos/p"), "bundle", "shares only a prefix with /Volumes/video");
  assert.equal(at("/Users/ana/Movies/p"), "bundle");
  assert.equal(at("/Users/ana/Movies/nas/p", mac({ realPath: (p) => p.replace("/Users/ana/Movies/nas", "/Volumes/x") })), "network /Volumes/x", "through a symlink");
  assert.equal(at("/Volumes/x/p", mac({ mountTable: () => null })), "bundle", "no mount table: the link probe decides");
  assert.equal(locateCartonDb({ bundleDir: "/Volumes/video/Promo", projectId: "p1", probe: mac() }).dbPath, "/Users/ana/Library/Application Support/Carton/projects/p1/carton.db");
});

test("Linux network file systems from /proc/self/mountinfo (FUSE clients, NFS, CIFS, 9p), escaped mount points", () => {
  const info = [
    "22 1 259:1 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p1 rw,discard",
    "40 22 0:35 / /mnt/nas rw,relatime shared:20 - nfs4 nas:/export rw,vers=4.2",
    "41 40 0:36 / /mnt/nas/cache rw,nosuid,nodev - tmpfs tmpfs rw",
    "42 22 0:37 / /home/u/remote rw,nosuid,nodev,relatime shared:21 master:3 - fuse.sshfs ana@host:/srv rw,user_id=1000",
    "43 22 0:38 / /mnt/my\\040share rw,relatime - cifs //nas/my\\040share rw,vers=3.1.1",
    "44 22 0:39 / /mnt/c rw,noatime - 9p drvfs rw",
    "45 22 8:17 / /mnt/stack rw - ext4 /dev/sdb1 rw",
    "46 45 0:41 / /mnt/stack rw - smb3 //nas/stack rw",
    "",
  ].join("\n");
  const linux = (over: Partial<LocationProbe> = {}) => fake({ mountTable: () => info, ...over });
  const at = (bundleDir: string, probe = linux()) => {
    const loc = locateCartonDb({ bundleDir, projectId: "p1", probe });
    return loc.placement === "network" ? `network ${loc.root}` : loc.placement;
  };
  assert.equal(at("/mnt/nas/p"), "network /mnt/nas");
  assert.equal(at("/mnt/nas/cache/p"), "bundle");
  assert.equal(at("/home/u/remote/Promo"), "network /home/u/remote");
  assert.equal(at("/mnt/my share/p"), "network /mnt/my share");
  assert.equal(at("/mnt/c/Users/p"), "network /mnt/c");
  assert.equal(at("/mnt/stack/p"), "network /mnt/stack", "the mount stacked on top (listed later) wins");
  assert.equal(at("/mnt/nasty/p"), "bundle");
  assert.equal(at("/MNT/nas/p"), "bundle", "Linux paths are case-sensitive");
  assert.equal(at("/home/u/link/p", linux({ realPath: (p) => p.replace("/home/u/link", "/mnt/nas") })), "network /mnt/nas", "through a symlink");
  // Windows has no mount table: never asked.
  const win = fake({ platform: "win32", home: "C:\\Users\\A", mountTable: () => { throw new Error("asked on Windows"); } });
  assert.equal(locateCartonDb({ bundleDir: "C:\\Promo", projectId: "p1", probe: win }).placement, "bundle");
});

test("a symlink can't hide a synced folder: the physical path's prefixes and markers count too", () => {
  // /home/u/Projects/link -> /home/u/Sync/sub, and /home/u/Sync is a Syncthing folder.
  const probe = fake({ dirs: { "/home/u/Sync": [".stfolder", "sub"] }, realPath: (p) => p.replace(/^\/home\/u\/Projects\/link(?=\/|$)/, "/home/u/Sync/sub") });
  assert.deepEqual(detectCloudSync("/home/u/Projects/link/Promo", probe), { provider: "Syncthing", root: "/home/u/Sync" });
  assert.equal(locateCartonDb({ bundleDir: "/home/u/Projects/link/Promo", projectId: "p1", probe }).placement, "cloud-sync");
  assert.equal(detectCloudSync("/home/u/Projects/other/Promo", probe), null);
  // A Dropbox root, reached through a link.
  const dbx = fake({
    files: { "/home/u/.dropbox/info.json": "{\"personal\":{\"path\":\"/home/u/Dropbox\"}}" },
    realPath: (p) => p.replace(/^\/home\/u\/clients(?=\/|$)/, "/home/u/Dropbox/clients"),
  });
  assert.equal(detectCloudSync("/home/u/clients/p", dbx)?.provider, "Dropbox");
  // A link inside a synced folder to somewhere else is still in the folder the client sees.
  const inside = fake({ dirs: { "/s": [".stfolder"] }, realPath: (p) => p.replace(/^\/s\/link(?=\/|$)/, "/data/x") });
  assert.equal(detectCloudSync("/s/link/p", inside)?.root, "/s");
});

test("a sync root that is itself a junction (OneDrive known-folder redirection) matches by its physical path", () => {
  // C:\Users\Ana\OneDrive is a junction to D:\OneDrive; so is the registry's Box root to E:\Box.
  const realPath = (p: string) => p.replace(/^c:\\users\\ana\\onedrive(?=\\|$)/i, "D:\\OneDrive").replace(/^c:\\users\\ana\\box sync(?=\\|$)/i, "E:\\Box");
  const probe = fake({
    platform: "win32",
    home: "C:\\Users\\Ana",
    env: { OneDrive: "C:\\Users\\Ana\\OneDrive", LOCALAPPDATA: "C:\\L" },
    realPath,
    windowsSyncRoots: () => ["C:\\Users\\Ana\\Box Sync"],
  });
  assert.deepEqual(detectCloudSync("d:\\onedrive\\Promo", probe), { provider: "OneDrive", root: "C:\\Users\\Ana\\OneDrive" });
  assert.equal(detectCloudSync("C:\\Users\\Ana\\OneDrive\\Promo", probe)?.provider, "OneDrive");
  assert.equal(detectCloudSync("E:\\Box\\p", probe)?.root, "C:\\Users\\Ana\\Box Sync");
  assert.equal(detectCloudSync("D:\\OneDrive2\\p", probe), null);
  assert.equal(locateCartonDb({ bundleDir: "D:\\OneDrive\\Promo", projectId: "p1", probe }).dbPath, "C:\\L\\Carton\\projects\\p1\\carton.db");
});

test("the real probe follows a real symlink into a Syncthing folder and writes nothing there", () => {
  const dir = scratch("symlink");
  fs.mkdirSync(path.join(dir, "Sync", ".stfolder"), { recursive: true });
  fs.mkdirSync(path.join(dir, "Sync", "sub"));
  fs.mkdirSync(path.join(dir, "Projects"));
  fs.symlinkSync(path.join(dir, "Sync", "sub"), path.join(dir, "Projects", "link"), "dir");
  // Markers are read only inside the scratch folder, so nothing above it on this machine can decide.
  const real = nodeProbe();
  const bases = [dir, fs.realpathSync(dir)];
  const probe: LocationProbe = { ...real, readDir: (p) => (bases.some((b) => p.startsWith(b)) ? real.readDir(p) : null) };
  // The bundle doesn't exist yet: its physical path comes from the nearest existing ancestor, the link.
  const loc = locateCartonDb({ bundleDir: path.join(dir, "Projects", "link", "Promo.cardboard"), projectId: "p1", appDataDir: path.join(dir, "appdata"), probe });
  assert.equal(loc.placement, "cloud-sync");
  assert.equal(loc.provider, "Syncthing");
  assert.equal(loc.root, path.join(fs.realpathSync(dir), "Sync"));
  assert.equal(loc.dbPath, path.join(dir, "appdata", "projects", "p1", "carton.db"));
  assert.deepEqual(fs.readdirSync(path.join(dir, "Sync", "sub")), [], "no probe file in the synced folder");
});

test("the hard-link probe's cleanup never throws or hides its answer (Windows antivirus holding the new file)", () => {
  const eperm = () => Object.assign(new Error("EPERM: operation not permitted, unlink"), { code: "EPERM" });
  const real: LinkProbeFs = { mkdirSync: fs.mkdirSync, writeFileSync: fs.writeFileSync, linkSync: fs.linkSync, rmSync: fs.rmSync };
  let rmCalls = 0;
  const locked = path.join(scratch("probe"), ".carton");
  assert.equal(makeLinkProbe({ ...real, rmSync: () => { rmCalls++; throw eperm(); } })(locked), "ok");
  assert.equal(rmCalls, 10, "five tries for each of the two files, then it gives up");
  assert.equal(fs.readdirSync(locked).length, 2, "the probe files stay behind; their names are unique");

  const fat = path.join(scratch("probe"), ".carton");
  assert.equal(makeLinkProbe({ ...real, linkSync: () => { throw eperm(); }, rmSync: () => { throw eperm(); } })(fat), "no-links");

  // Busy twice, then free: removed on the third try.
  const tries = new Map<string, number>();
  const flaky = path.join(scratch("probe"), ".carton");
  const busy: LinkProbeFs["rmSync"] = (p, o) => {
    const n = (tries.get(String(p)) ?? 0) + 1;
    tries.set(String(p), n);
    if (n < 3) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
    fs.rmSync(p, o);
  };
  assert.equal(makeLinkProbe({ ...real, rmSync: busy })(flaky), "ok");
  assert.deepEqual([...tries.values()], [3, 3]);
  assert.deepEqual(fs.readdirSync(flaky), []);
});

test("no probe file is written into a folder that looks cloud-synced", () => {
  const probed: string[] = [];
  const probe = fake({ dirs: { "/s": [".stfolder"] }, linkProbe: (d) => { probed.push(d); return "ok"; } });
  assert.equal(locateCartonDb({ bundleDir: "/s/p", projectId: "p1", probe }).placement, "cloud-sync");
  assert.deepEqual(probed, []);
  locateCartonDb({ bundleDir: "/t/p", projectId: "p1", probe });
  assert.deepEqual(probed, ["/t/p/.carton"]);
});

test("app-data folders per OS, local and never roaming", () => {
  assert.equal(defaultAppDataDir({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\A\\AppData\\Local", APPDATA: "C:\\Users\\A\\AppData\\Roaming" }, home: "C:\\Users\\A" }), "C:\\Users\\A\\AppData\\Local\\Carton");
  assert.equal(defaultAppDataDir({ platform: "win32", env: {}, home: "C:\\Users\\A" }), "C:\\Users\\A\\AppData\\Local\\Carton");
  assert.equal(defaultAppDataDir({ platform: "darwin", env: {}, home: "/Users/a" }), "/Users/a/Library/Application Support/Carton");
  assert.equal(defaultAppDataDir({ platform: "linux", env: { XDG_DATA_HOME: "/x" }, home: "/home/a" }), "/x/carton");
  const loc = locateCartonDb({ bundleDir: "/s/p", projectId: "p1", appDataDir: "/cardboard-user-data", probe: fake({ dirs: { "/s": [".stfolder"] } }) });
  assert.equal(loc.dbPath, "/cardboard-user-data/projects/p1/carton.db");
});

test("project keys are file-name safe: plain ids keep their name, every other id is hashed into its own namespace", () => {
  assert.equal(projectKey("8f0c2a1e-1d2b-4c3d-9e8f-0a1b2c3d4e5f"), "8f0c2a1e-1d2b-4c3d-9e8f-0a1b2c3d4e5f");
  assert.equal(projectKey("x".repeat(100)), "x".repeat(100));
  assert.equal(projectKey("abc-06d90109"), "abc-06d90109");
  assert.notEqual(projectKey("Abc"), projectKey("abc-06d90109"), "the old scheme mapped both to abc-06d90109");
  assert.notEqual(projectKey("Abc"), projectKey("abc"), "ids that differ only in case");
  assert.notEqual(projectKey("Abc"), projectKey("ABC"));
  const odd = ["Abc", "ABC", "../../etc", "a/b", "a\\b", "CON:", "con", "Nul", "com1", "lpt9", "abc.", "", "x".repeat(101), "x".repeat(300), "a..b", "_x", "-x", "Zoë"];
  for (const id of odd) assert.match(projectKey(id), /^_[0-9a-f]{32}$/, id);
  assert.equal(new Set(odd.map(projectKey)).size, odd.length);
});

test("the real probe on this machine: a local folder keeps the bundle, links work, nothing is left behind", () => {
  const dir = scratch("loc");
  const loc = locateCartonDb({ bundleDir: dir, projectId: "p1", probe: { ...nodeProbe(), readDir: (p) => (p === dir ? [] : null) } });
  assert.equal(loc.placement, "bundle");
  assert.equal(loc.dbPath, path.join(dir, ".carton", "carton.db"));
  assert.deepEqual(fs.readdirSync(path.join(dir, ".carton")), []);
  if (process.platform === "linux") assert.match(nodeProbe().mountTable() ?? "", / - \S+ /, "mountinfo was read");
});
