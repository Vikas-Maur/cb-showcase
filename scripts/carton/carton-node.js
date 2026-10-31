// The facade the bridges call (scripts/carton/*-bridge.js), bundled by scripts/carton/build.js into
// resources/carton/carton-node.cjs. It maps what Cardboard 1.4.0's hooks need (carton/docs/INTEGRATION-1.4.0.md §5)
// onto the @carton packages, so a package API change touches only this file.
// - Files: every Carton write to project.json and timeline.tsx is displace-then-install (@carton/cardboard/node).
//   What it moves aside is held in .carton/displaced/: Carton's own previous file is deleted once it is confirmed
//   unchanged; anything else is a foreign save, imported as an outside change and only then released.
// - History: one Carton (@carton/local, openLocal) per bundle, opened on first use.
// - Degraded: if Carton can't open a project (or a package isn't there yet), every call answers as Cardboard 1.4.0
//   would (no commit, .revs history, Cardboard's merge) and says so once in the log. A foreign save is then kept in
//   .carton/displaced/, never deleted.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { displaceThenInstall, hardLinksWork, statStamp, DisplacedFiles } from "@carton/cardboard/node";
import { fromHost, toHost, projectGuiSave } from "@carton/cardboard";
import * as local from "@carton/local";
import * as cliMcp from "@carton/cli-mcp";

const warned = new Set();
const warnOnce = (key, msg) => {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn("[carton] " + msg);
};
const errText = (e) => (e && e.message) || String(e);

// ---------------------------------------------------------------- files: displace, then install
const installs = new Map(); // target path → { files: DisplacedFiles, own, noLinks, timer }
const JSON_DOC = (b) => { try { const d = JSON.parse(b.toString("utf8")); return d && typeof d === "object" ? d : null; } catch { return null; } };

// What Carton wrote at each path, shared by every process on the machine: a displaced file with one of these hashes
// is Carton's own and goes; anything else is held as a foreign save. (The Materializer's carton.db record replaces
// this once it is wired.) Losing an entry to a race between processes only keeps a file, never drops one.
const SEEN_KEEP = 32;
const seenFile = (file) => path.join(path.dirname(file), ".carton", "seen.json");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const readSeen = (file) => { try { return JSON.parse(fs.readFileSync(seenFile(file), "utf8")); } catch { return {}; } };
const markSeen = (file, hash) => {
  const all = readSeen(file), name = path.basename(file);
  all[name] = [hash, ...(all[name] ?? []).filter((h) => h !== hash)].slice(0, SEEN_KEEP);
  fs.mkdirSync(path.dirname(seenFile(file)), { recursive: true });
  const tmp = seenFile(file) + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(all));
  fs.renameSync(tmp, seenFile(file));
};

async function install(tmp, file, seenStamp) {
  // Without history for this project there is nothing to import a foreign save into: write as 1.4.0 does.
  if (!(await open(path.dirname(file)))) return fs.promises.rename(tmp, file);
  let s = installs.get(file);
  if (!s) {
    const bundle = path.dirname(file);
    s = { files: new DisplacedFiles(path.join(bundle, ".carton", "displaced")), own: null, noLinks: !hardLinksWork(bundle), timer: null };
    installs.set(file, s);
  }
  const bytes = fs.readFileSync(tmp);
  const r = displaceThenInstall(file, tmp, s.files.next, { noLinks: s.noLinks, lastStamp: s.own?.stamp ?? null });
  markSeen(file, sha(bytes));
  // The file the writer read (its stamp unchanged since), or one Carton wrote, isn't a foreign save.
  const seen = new Set(readSeen(file)[path.basename(file)] ?? []);
  const rest = r.displaced.filter((p, i) => {
    const mine = (i === 0 && seenStamp && statStamp(p) === seenStamp) || seen.has(sha(fs.readFileSync(p)));
    if (mine) fs.rmSync(p, { force: true });
    return !mine;
  });
  s.files.hold(rest, s.own);
  s.own = { bytes, stamp: statStamp(file) };
  s.files.endRound();
  if (!s.files.size) return;
  // Review after the hold: Carton's own previous file goes; a foreign one is imported, then released.
  clearTimeout(s.timer);
  s.timer = setTimeout(() => review(file, s).catch((e) => warnOnce("review:" + file, "review of displaced files failed: " + errText(e))), 300);
  s.timer.unref?.();
}

async function review(file, s) {
  const isProject = path.basename(file) === "project.json";
  const out = s.files.review((b) => (isProject ? JSON_DOC(b) !== null : b.length > 0));
  for (const f of out.foreign) {
    const imported = isProject ? await importForeign(path.dirname(file), JSON_DOC(f.bytes)?.project ?? null, "external:project.json") : false;
    // Without an engine to take it, a foreign save stays where it is: never lost.
    if (imported) fs.rmSync(f.path, { force: true });
  }
}

// ---------------------------------------------------------------- the engine, per bundle
const opened = new Map(); // bundlePath → Promise<LocalCarton | null>
function open(bundlePath) {
  if (!bundlePath) return Promise.resolve(null);
  let p = opened.get(bundlePath);
  if (!p) {
    p = Promise.resolve()
      .then(() => local.openLocal({ projectDir: bundlePath }))
      .catch((e) => (warnOnce("open", "history is off for now: " + errText(e)), null));
    opened.set(bundlePath, p);
  }
  return p;
}
const author = (id) => ({ id });
// A 1.4.0 timestamp rev is a ref Carton resolves to the version materialized with it (CONTRACTS.md, "Refs").
const revRef = (rev) => (rev === undefined || rev === null ? undefined : String(rev));

async function importForeign(bundlePath, project, actor) {
  const lc = await open(bundlePath);
  if (!lc || !project) return false;
  await lc.carton.commit({ doc: fromHost(project, null), author: author(actor) });
  return true;
}

async function commit({ bundlePath, base, doc, actor, meta }) {
  const lc = await open(bundlePath);
  if (!lc) return { doc, status: "off" };
  const c = lc.carton;
  // A GUI save names the version the editor shows: only the person's edits, through the GUI's projection (B3).
  const gui = meta?.base !== undefined;
  const ref = revRef(gui ? meta.base : meta?.rev ?? base?.stateUpdatedAt);
  const baseDoc = ref ? await c.checkout(ref) : null;
  const mine = gui && baseDoc ? projectGuiSave(baseDoc, doc) : fromHost(doc, baseDoc);
  const r = await c.commit({ doc: mine, base: ref, author: author(actor), intent: meta?.intents ? { remaps: meta.intents } : undefined });
  const head = await c.head();
  // Nothing else was merged in: the writer's document is head as it stands.
  if (r.status === "confirmed" && head.ref === r.ref && r.merged !== true) return { ...r, doc };
  return { ...r, doc: { ...doc, ...toHost(head.doc), stateUpdatedAt: Math.max(Date.now(), (doc.stateUpdatedAt ?? 0) + 1) } };
}

// ---------------------------------------------------------------- what the bridges call
export const cardboard14 = {
  attach() {},
  commit,
  install,
  async sawDisk({ bundlePath, doc }) {
    const lc = await open(bundlePath);
    if (!lc) return;
    if (lc.known && !(await lc.known(doc))) await importForeign(bundlePath, doc, "external:project.json");
  },
  async revisions({ bundlePath, files }) {
    const lc = await open(bundlePath);
    const older = await files();
    if (!lc) return older;
    const versions = (await lc.carton.log({})).map((v) => v.rev).filter((r) => typeof r === "number");
    const first = versions.at(-1) ?? Infinity;
    return [...versions, ...older.filter((r) => r < first)];
  },
  async revision({ bundlePath, rev, file }) {
    const lc = await open(bundlePath);
    if (lc) {
      try {
        const doc = await lc.carton.checkout(String(rev));
        const p = toHost(doc);
        return { rev, at: p.updatedAt ?? new Date(rev).toISOString(), doc: { tracks: p.tracks ?? [], timelineItems: p.timelineItems ?? [], aspectRatio: p.aspectRatio } };
      } catch {}
    }
    return file();
  },
  async history({ bundlePath, rows }) {
    const lc = await open(bundlePath);
    if (!lc) return rows;
    const by = new Map((await lc.carton.log({})).map((v) => [v.rev, v]));
    return rows.map((r) => (by.has(r.rev) ? { ...r, who: by.get(r.rev).author?.id ?? "", cut: by.get(r.rev).cut ?? "" } : r));
  },
  async merge3({ base, current, file, prefer, rn }) {
    // Cardboard's own merge until the adapter's merge3 in rn's shape is wired.
    return rn(base, current, file, { prefer });
  },
  async undoTurn({ bundlePath, turn, actor }) {
    const lc = await open(bundlePath);
    if (!lc) throw new Error("History isn't available for this project yet");
    return lc.carton.undo("turn:" + turn, {});
  },
  async run(argv, io) {
    return cliMcp.runCb([...argv], { cwd: io.cwd, env: { ...io.env, CARTON_PROJECT_DIR: io.bundlePath }, stdout: io.stdout, stderr: io.stderr });
  },
  mcpTools() {
    try { return cliMcp.mcpTools(); } catch (e) { warnOnce("mcp", "Carton's MCP tools are not available yet: " + errText(e)); return []; }
  },
  async hook({ event, input, env }) {
    if (event === "pre-tool-use" && typeof input?.tool_input?.command === "string" && input.agent_id) {
      const actor = (env.CARDBOARD_ACTOR || "claude") + "/sub-" + (input.agent_type || "agent") + "-" + input.agent_id;
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...input.tool_input, command: "export CARDBOARD_ACTOR='" + actor.replaceAll("'", "'\\''") + "'; " + input.tool_input.command } } };
    }
    return null;
  },
  worker({ library }) {
    const bundleOf = (projectId) => library.projects.bundlePathFor?.(projectId) ?? null;
    const carton = async (projectId) => (await open(bundleOf(projectId)))?.carton ?? null;
    const need = async (projectId) => {
      const c = await carton(projectId);
      if (!c) throw new Error("History isn't available for this project yet");
      return c;
    };
    return {
      ping: async () => "pong",
      head: async ({ projectId }) => library.projects.read(projectId),
      checkout: async ({ projectId, ref }) => ({ ...(await library.projects.read(projectId)), ...toHost(await (await need(projectId)).checkout(ref)) }),
      // Without history for the project, the pages run Cardboard's own undo.
      undo: async ({ projectId }) => { const c = await carton(projectId); return c ? c.undo(undefined, {}) : { status: "unavailable" }; },
      redo: async () => ({ status: "unavailable" }),
      notices: async ({ bundlePath, actor, take }) => ((await open(bundlePath))?.carton.notices({ id: actor }, { take }) ?? []),
    };
  },
};
