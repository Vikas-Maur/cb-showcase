// Where a shared project's sync settings and session live on this machine: Carton's app-data folder (store-sqlite's
// `defaultAppDataDir`: %LOCALAPPDATA%\Carton on Windows), never the bundle or carton.db (§14: a bundle can sit in a
// cloud-synced folder and a full .cbproj copies carton.db, so neither may hold a session or the install key).
//   <appData>/sync/install-key           this install's key: presented only to join and refresh (§6.3 device binding)
//   <appData>/sync/<key>/config.json     {v, host, projectId, account, role, cut}: no secret
//   <appData>/sync/<key>/session.json    {token, context}: the session the host issued
//   <appData>/sync/<key>/token           the token alone, for a headless helper (@carton/local reads a token file)
// <key> names one project in one library folder: two libraries on one machine can hold the same project.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { defaultAppDataDir } from "@carton/store-sqlite";
import * as host from "./host.js";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const norm = (p) => (process.platform === "win32" || process.platform === "darwin" ? path.resolve(p).toLowerCase() : path.resolve(p));
export const syncRoot = () => path.join(defaultAppDataDir(), "sync");
/** The folder of one project in one library (the library is the bundle's parent folder). */
export const projectDir = (bundlePath, projectId) => path.join(syncRoot(), sha(norm(path.dirname(bundlePath)) + "\0" + projectId).slice(0, 24));

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// Atomic, owner-only. A reader holding the file open makes the rename fail on Windows (EPERM, EBUSY): try again for
// up to a second, then give up loudly.
function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      if (i >= 40 || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) { fs.rmSync(tmp, { force: true }); throw e; }
      sleepSync(25);
    }
  }
}
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };

/** This install's key, made once. Two processes starting together agree: the first to create the file wins. */
export function installKey() {
  const file = path.join(syncRoot(), "install-key");
  try { return fs.readFileSync(file, "utf8").trim(); } catch {}
  fs.mkdirSync(syncRoot(), { recursive: true, mode: 0o700 });
  try { fs.writeFileSync(file, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 }); } catch (e) { if (e.code !== "EEXIST") throw e; }
  return fs.readFileSync(file, "utf8").trim();
}

export function readConfig(bundlePath, projectId) {
  const c = readJson(path.join(projectDir(bundlePath, projectId), "config.json"));
  return c?.v === 1 && c.projectId === projectId && typeof c.host === "string" ? c : null;
}
export function writeConfig(bundlePath, cfg) {
  writeFile(path.join(projectDir(bundlePath, cfg.projectId), "config.json"), JSON.stringify({ v: 1, ...cfg }, null, 2));
}
export const tokenFile = (bundlePath, projectId) => path.join(projectDir(bundlePath, projectId), "token");
export function saveSession(bundlePath, projectId, s) {
  const dir = projectDir(bundlePath, projectId);
  writeFile(path.join(dir, "session.json"), JSON.stringify({ token: s.token, context: s.context }));
  writeFile(path.join(dir, "token"), s.token);
}
export const readSession = (bundlePath, projectId) => readJson(path.join(projectDir(bundlePath, projectId), "session.json"));
/** Leave a shared project on this machine: its settings and session go (the project and its history stay). */
export function forget(bundlePath, projectId) {
  fs.rmSync(projectDir(bundlePath, projectId), { recursive: true, force: true });
}

/** Refresh this long before a token expires (one small request). */
const EARLY_MS = 120_000;

/**
 * A session's token, refreshed before it expires (one refresh at a time) and written back for the next process. The
 * same functions serve the worker, cb and a headless helper; whoever refreshes first saves it for the others.
 */
export function sessionFor(bundlePath, projectId, { fetchFn } = {}) {
  let refreshing = null;
  const token = async () => {
    const cfg = readConfig(bundlePath, projectId), s = readSession(bundlePath, projectId);
    if (!cfg || !s?.token) throw new Error("This project isn't shared from this computer");
    if ((s.context?.expires ?? 0) - Date.now() > EARLY_MS) return s.token;
    refreshing ??= host.refresh({ host: cfg.host, projectId, token: s.token, installKey: installKey(), fetchFn })
      .then((r) => (saveSession(bundlePath, projectId, r), r.token))
      .finally(() => (refreshing = null));
    return refreshing;
  };
  return { token };
}
