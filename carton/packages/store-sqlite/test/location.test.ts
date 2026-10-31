// Where carton.db lives (§6.4, L15). The Windows and macOS rules run here through a faked LocationProbe; the real
// probe (link test, statfs, SyncRootManager) is exercised on this OS, and on Windows in the Windows run.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { locateCartonDb, detectCloudSync, defaultAppDataDir, projectKey, parseSyncRootManager, nodeProbe, type LocationProbe } from "../src/location.ts";
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
  const out = [
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\SyncRootManager\\OneDrive!S-1-5-21-1!Personal",
    "    DisplayNameResource    REG_EXPAND_SZ    OneDrive - Personal",
    "",
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\SyncRootManager\\OneDrive!S-1-5-21-1!Personal\\UserSyncRoots",
    "    S-1-5-21-1    REG_SZ    C:\\Users\\Ana\\OneDrive",
    "",
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\SyncRootManager\\Dropbox!S-1-5-21-1!1\\UserSyncRoots",
    "    S-1-5-21-1    REG_SZ    D:\\Dropbox Folder",
  ].join("\r\n");
  assert.deepEqual(parseSyncRootManager(out), ["C:\\Users\\Ana\\OneDrive", "D:\\Dropbox Folder"]);
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
  const win = (real: string) => fake({ platform: "win32", home: "C:\\Users\\A", env: { LOCALAPPDATA: "C:\\L" }, realPath: () => real });
  assert.equal(locateCartonDb({ bundleDir: "Z:\\Promo", projectId: "p1", probe: win("\\\\nas\\video\\Promo") }).placement, "network");
  assert.equal(locateCartonDb({ bundleDir: "\\\\nas\\video\\Promo", projectId: "p1", probe: win("\\\\?\\UNC\\nas\\video\\Promo") }).placement, "network");
  assert.equal(locateCartonDb({ bundleDir: "C:\\Promo", projectId: "p1", probe: win("C:\\Promo") }).placement, "bundle");
  assert.equal(locateCartonDb({ bundleDir: "/mnt/nas/p", projectId: "p1", probe: fake({ fsMagic: () => 0x6969 }) }).placement, "network");
  assert.equal(locateCartonDb({ bundleDir: "/mnt/smb/p", projectId: "p1", probe: fake({ fsMagic: () => 0xfe534d42 | 0 }) }).placement, "network");
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

test("project keys are file-name safe and keep ids that differ only in case apart", () => {
  assert.equal(projectKey("8f0c2a1e-1d2b-4c3d-9e8f-0a1b2c3d4e5f"), "8f0c2a1e-1d2b-4c3d-9e8f-0a1b2c3d4e5f");
  assert.notEqual(projectKey("Abc"), projectKey("abc"));
  assert.equal(projectKey("Abc").toLowerCase(), projectKey("Abc"));
  for (const bad of ["../../etc", "a/b", "a\\b", "CON:", "con", "Nul", "abc.", "", "x".repeat(300), "a..b"]) {
    const k = projectKey(bad);
    assert.match(k, /^p-[0-9a-f]{32}$/, bad);
  }
});

test("the real probe on this machine: a local folder keeps the bundle, links work, nothing is left behind", () => {
  const dir = scratch("loc");
  const loc = locateCartonDb({ bundleDir: dir, projectId: "p1", probe: { ...nodeProbe(), readDir: (p) => (p === dir ? [] : null) } });
  assert.equal(loc.placement, "bundle");
  assert.equal(loc.dbPath, path.join(dir, ".carton", "carton.db"));
  assert.deepEqual(fs.readdirSync(path.join(dir, ".carton")), []);
});
