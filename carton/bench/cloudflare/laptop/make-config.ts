// The laptop client's config, made on the lab box: a fresh lab project (`laptop-<timestamp>`) whose cut the server
// adopts now, and three editor sessions for it valid at most 48 hours (replicas A, B, and C/D through the local proxy),
// plus the run's default upload size. Signed with the deployment's secret, which stays here: the config holds only
// those sessions (no admin token), and lives outside the repo.
//
//   node bench/cloudflare/laptop/make-config.ts [--host r2|nor2] [--out <path>] [--ttl-hours 48] [--upload-mb 200]
//        [--guard]     also declare one full run's worst case to the free-tier guard as `laptop-pack-<projectId>`, left
//                      open (the run happens elsewhere); end it with purge.ts once the results are back
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { adopt, tokenFor, HOSTS, type HostName } from "../common.ts";
import { guard } from "../guard.ts";
import { laptopEstimate } from "./estimate.ts";

const { values: a } = parseArgs({
  options: {
    host: { type: "string", default: "r2" },
    out: { type: "string", default: "/home/ubuntu/.t3/projects/cardboard-showcase/_inspect/carton-build/cf-lab/laptop/config.json" },
    "ttl-hours": { type: "string", default: "48" },
    "upload-mb": { type: "string", default: "200" },
    guard: { type: "boolean", default: false },
  },
});
const host = a.host as HostName;
if (!(host in HOSTS)) throw new Error(`--host must be one of ${Object.keys(HOSTS).join(", ")}`);
const ttlHours = Number(a["ttl-hours"]);
if (!(ttlHours > 0 && ttlHours <= 48)) throw new Error("--ttl-hours must be more than 0 and at most 48");
const uploadMB = Number(a["upload-mb"]);
if (!(uploadMB >= 1 && uploadMB <= 300)) throw new Error("--upload-mb must be from 1 to 300 (the lab's cap for a person's network)");
const ttlMs = ttlHours * 3600_000;
const projectId = `laptop-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`;
const branch = "main";

// the guard first: if it refuses, nothing is made
let guardId: number | null = null;
if (a.guard) guardId = (await guard(laptopEstimate(`laptop-pack-${projectId}`, uploadMB))).id;
await adopt(host, projectId, branch);
// the config's expiry is never later than its sessions'
const created = Date.now();
const tokens = {
  a: await tokenFor(projectId, "laptop-a", "editor", ttlMs),
  b: await tokenFor(projectId, "laptop-b", "editor", ttlMs),
  c: await tokenFor(projectId, "laptop-c", "editor", ttlMs),
};
const cfg = { host: HOSTS[host], projectId, branch, uploadMB, tokens, createdAt: new Date(created).toISOString(), expiresAt: new Date(created + ttlMs).toISOString() };
mkdirSync(dirname(a.out!), { recursive: true });
writeFileSync(a.out!, JSON.stringify(cfg, null, 1) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ projectId, host: HOSTS[host], uploadMB, expiresAt: cfg.expiresAt, config: a.out, ...(a.guard ? { guardTest: `laptop-pack-${projectId}`, guardId } : {}) }));
