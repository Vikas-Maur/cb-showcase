// After a laptop run: retire the run's project and delete its blobs (the lab's purge route with `retire=1`, the admin
// token read from the secrets file and never printed), and optionally end its free-tier guard entry with what was
// really uploaded from this box (0 for a pack: the bytes left the person's network).
// A purge is the end of the project's life. The pack's config holds sessions for 48 hours, so without the retirement
// a second run of the same pack would use the purged project: its keyframes gone, no replica could ever catch up, and
// its upload would land where nothing purges it again (stuck-sync, 2026-11-03). Retired, the pack refuses to start
// and the room refuses WebSockets: a new run needs a fresh config (make-config.ts).
//
//   node bench/cloudflare/laptop/purge.ts --project <projectId> [--host r2|nor2] [--end-test <test name>] [--uploaded <bytes>]
import { parseArgs } from "node:util";
import { HOSTS, secrets, type HostName } from "../common.ts";
import { endTest, loadLedger } from "../guard.ts";

const { values: a } = parseArgs({
  options: {
    project: { type: "string" },
    host: { type: "string", default: "r2" },
    "end-test": { type: "string" },
    uploaded: { type: "string", default: "0" },
  },
});
const host = a.host as HostName;
if (!a.project || !(host in HOSTS)) throw new Error("usage: purge.ts --project <projectId> [--host r2|nor2] [--end-test <name>] [--uploaded <bytes>]");

let deleted = 0, calls = 0;
for (;;) {
  const r = await fetch(`${HOSTS[host]}/api/lab/projects/${encodeURIComponent(a.project)}/purge?retire=1`, { method: "POST", headers: { authorization: `Bearer ${secrets().ADMIN_TOKEN}` } });
  if (!r.ok) throw new Error(`purge: HTTP ${r.status}`);
  const j = (await r.json()) as { deleted: number; more: boolean; retired?: boolean };
  // a lab host from before retirement ignores it: its pack's config could still run again on the purged project
  if (calls === 0 && j.retired !== true) console.error("warning: this lab host doesn't retire projects (deploy lab-worker.ts): don't let this project's pack run again");
  deleted += j.deleted;
  calls++;
  if (!j.more || calls > 100) break;
}

let ended: number | null = null;
if (a["end-test"]) {
  // the latest entry of that name still open
  ended = loadLedger().entries.findLastIndex((e) => e.test === a["end-test"] && e.end === undefined);
  if (ended < 0) throw new Error(`no open guard entry named ${a["end-test"]}`);
  endTest(ended, {}, { uploaded: Number(a.uploaded) });
}
console.log(JSON.stringify({ project: a.project, host, deleted, calls, ...(a["end-test"] ? { endedGuardEntry: ended } : {}) }));
