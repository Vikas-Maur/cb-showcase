// A third writer for R2-03 (another person's edits arriving meanwhile): opacity and timing edits on c0..c7 for `ms`.
//   writer <projectDir> <projectId> <ms>
import { openLocal } from "../../src/open.ts";
import { adapter } from "./real.ts";

const [projectDir, projectId, ms] = process.argv.slice(2);
const local = await openLocal({ projectDir, projectId, adapter, actor: { kind: "human", id: "human:bob", name: "bob", group: "remote:bob" } });
const end = Date.now() + Number(ms);
let n = 0, k = 0;
while (Date.now() < end) {
  const c = `c${k++ % 8}`;
  const r = await local.write({ kind: "commit", ops: [{ op: "set", path: ["timelineItems", c, "opacity"], value: Math.round(Math.random() * 100) / 100 }] });
  if (r.status === "confirmed") n++;
  await new Promise((res) => setTimeout(res, 15));
}
await local.close();
process.stdout.write(JSON.stringify({ commits: n }) + "\n");
