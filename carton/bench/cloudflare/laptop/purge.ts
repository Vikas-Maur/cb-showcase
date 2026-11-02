// After a laptop run: delete the run's project blobs (the lab's purge route, with the admin token read from the
// secrets file and never printed), and optionally end its free-tier guard entry with what was really uploaded from
// this box (0 for a pack: the bytes left the person's network).
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
  const r = await fetch(`${HOSTS[host]}/api/lab/projects/${encodeURIComponent(a.project)}/purge`, { method: "POST", headers: { authorization: `Bearer ${secrets().ADMIN_TOKEN}` } });
  if (!r.ok) throw new Error(`purge: HTTP ${r.status}`);
  const j = (await r.json()) as { deleted: number; more: boolean };
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
