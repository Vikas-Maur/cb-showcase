// A terminal or hooked agent of R5-04, as a process: prints its per-agent view with `cb source print --view`, then
// for each step edits the view file the way Claude Code's Write does (whole file, atomic rename) and reads its
// `.status` sidecar without touching the view. Steps come as JSON lines on stdin; one result line per step.
//   view-agent <projectDir> <projectId>      stdin: {"set": [[id, field, value], ...]} | {"exit": true}
import { readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { openLocal } from "../../src/open.ts";
import { identify } from "../../src/identity.ts";
import { adapter } from "./real.ts";

const [projectDir, projectId] = process.argv.slice(2);
const local = await openLocal({ projectDir, projectId, adapter, actor: identify() });
const p = await local.write({ kind: "printView" });
if (p.status !== "confirmed") { process.stdout.write(JSON.stringify({ error: p }) + "\n"); process.exit(1); }
const view = (p as any).view as { name: string; path: string };
process.stdout.write(JSON.stringify({ printed: view }) + "\n");
const file = join(projectDir, ...view.path.split("/"));
const status = join(projectDir, ...view.path.replace(/\.tsx$/, ".status").split("/"));
let k = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const step = JSON.parse(line);
  if (step.exit) break;
  const before = existsSync(status) ? readFileSync(status, "utf8") : "";
  const text = readFileSync(file, "utf8");
  const nl = text.indexOf("\n{");
  const head = text.slice(0, nl + 1), body = JSON.parse(text.slice(nl + 1));
  for (const [id, f, v] of step.set) body.timelineItems.find((i: any) => i.id === id)[f] = v;
  const tmp = `${file}.${process.pid}.${k++}.tmp`;
  writeFileSync(tmp, head + JSON.stringify(body, null, 1) + "\n");
  renameSync(tmp, file);
  // read the sidecar (never the view) until it describes this save
  const end = Date.now() + 10000;
  let s = before;
  while ((s = existsSync(status) ? readFileSync(status, "utf8") : "") === before && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  process.stdout.write(JSON.stringify({ status: s ? JSON.parse(s) : null }) + "\n");
}
await local.close();
process.exit(0); // stdin is the parent's pipe and would keep this process alive
