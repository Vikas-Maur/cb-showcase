// One Claude Code subagent of R2-03, as a process: its identity comes from CARDBOARD_ACTOR (set by the PreToolUse
// prefixer), and each of its three dependent edits is a `cb` call made of a print (a pin of the current state) and an
// apply on that base, as `cb source apply` does with Carton. It reads its own writes before each next step.
//   subagent <projectDir> <projectId> <X>
import { openLocal } from "../../src/open.ts";
import { identify } from "../../src/identity.ts";
import { liveHolder } from "../../src/holder.ts";
import { adapter } from "./real.ts";
import type { Rec } from "@carton/core";

const [projectDir, projectId, X] = process.argv.slice(2);
const id = `title-${X}`;
const steps: { ready: (items: Rec[]) => boolean; apply: (items: Rec[]) => void }[] = [
  { ready: () => true, apply: (items) => void items.push({ id, trackId: "T2", name: id, textContent: `${X} v1`, startTime: 0, endTime: 3, trimStart: 0, trimEnd: 3, opacity: 1 }) },
  { ready: (items) => items.some((i) => i.id === id), apply: (items) => { items.find((i) => i.id === id)!.textContent = `${X} v2`; } },
  { ready: (items) => items.find((i) => i.id === id)?.textContent === `${X} v2`, apply: (items) => { Object.assign(items.find((i) => i.id === id)!, { startTime: 1, endTime: 4 }); } },
];
const results: unknown[] = [];
const holders: (number | null)[] = [];
const actor = identify();
for (const s of steps) {
  // each step is its own short cb process in real life; here one process opens the project per step to match
  const local = await openLocal({ projectDir, projectId, adapter, actor });
  try {
    for (let tries = 0; ; tries++) {
      const pin = await local.write({ kind: "pin", owner: `turn:${actor.turn}` });
      if (pin.status !== "confirmed") throw new Error(`print failed: ${JSON.stringify(pin)}`);
      const doc = structuredClone(await local.carton.checkout(String((pin as any).header)));
      const items = doc.timelineItems as Rec[];
      if (!s.ready(items)) { if (tries > 50) throw new Error("own write never became visible"); await new Promise((r) => setTimeout(r, 20)); continue; }
      s.apply(items);
      holders.push((await liveHolder(local.lease))?.pid ?? null);
      const r = await local.write({ kind: "commit", base: String((pin as any).header), doc });
      results.push(r);
      if (r.status !== "confirmed") throw new Error(`step failed: ${JSON.stringify(r)}`);
      break;
    }
  } finally {
    await local.close();
  }
}
process.stdout.write(JSON.stringify({ actor: actor.id, results, holders }) + "\n");
