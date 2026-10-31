// One `cb` write as Cardboard's own `cb` (patched by the windows agent) hands it over: `@carton/local`'s `openLocal` in
// this process, the write routed to the lease holder over its control socket (or, with no holder, committed here for a
// local cut, or through a helper it starts for a shared one). Identity from CARDBOARD_ACTOR / CARTON_AGENT as for `cb`.
//   cbwrite <bundle> <projectId> <json: WriteOp | {op: WriteOp, waitMs?, id?, helper?: {factory, config}}>
// Prints the cb result contract as one JSON line ({status: confirmed|pending|conflicts|rejected|error, …}).
import { openLocal, identify } from "@carton/local";
import type { WriteOp } from "@carton/local";
import { cardboardAdapter } from "@carton/cardboard";
import type { HostAdapter } from "@carton/core";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDirFor } from "./env.ts";

const [bundle, projectId, json] = process.argv.slice(2);
const arg = JSON.parse(json!);
const req = (arg.op ? arg : { op: arg }) as { op: WriteOp; waitMs?: number; id?: string; helper?: { factory: string; config?: Record<string, unknown> } };
// a live machine's helper config (support/live.ts writes it, standing in for B7's fix) unless the call brings its own
const machineHelper = join(dirname(dataDirFor(bundle!)), "e2e-helper.json");
if (!req.helper && existsSync(machineHelper)) req.helper = JSON.parse(readFileSync(machineHelper, "utf8"));
const local = await openLocal({
  projectDir: bundle!,
  projectId,
  dataDir: dataDirFor(bundle!),
  adapter: cardboardAdapter as HostAdapter,
  actor: identify(),
  ...(req.helper ? { helperFactory: req.helper.factory, helperConfig: req.helper.config } : {}),
});
try {
  const r = await local.write(req.op, { ...(req.waitMs !== undefined ? { waitMs: req.waitMs } : {}), ...(req.id ? { id: req.id } : {}) });
  process.stdout.write(JSON.stringify(r) + "\n");
} finally {
  await local.close();
}
