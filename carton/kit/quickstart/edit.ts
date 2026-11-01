// Quickstart: one edit, made the way `cb` makes it (through the write path that hands writes to the lease holder).
//   node kit/quickstart/edit.ts <bundle> <clip name or id> <field>=<value> [...] [--as <agent>] [--base <version>]
// Who is editing comes from CARDBOARD_ACTOR (e.g. director/chat1/turn1), else `--as <agent>`, else this terminal.
// `--base main@2`: the edit was made on that version (an agent that read the timeline earlier), not on the head.
// Prints the cb result: confirmed, pending, or conflicts with its cards.
import { resolve } from "node:path";
import { resolveVersion, resultText } from "@carton/cli-mcp";
import { identify, openLocal } from "@carton/local";

const args = process.argv.slice(2);
const take = (name: string): string | null => {
  const i = args.indexOf(name);
  return i < 0 ? null : args.splice(i, 2)[1];
};
const declared = take("--as");
const baseText = take("--base");
const [bundle, clip, ...sets] = args;
if (!bundle || !clip || !sets.length) throw new Error("usage: node kit/quickstart/edit.ts <bundle> <clip> <field>=<value> ... [--as <agent>] [--base <version>]");

const lc = await openLocal({ projectDir: resolve(bundle), actor: identify({ declared }) });
try {
  // the version the edit was made on: a StateRef (or a printed header), as Carton gave it
  const base = baseText ? await resolveVersion(lc.carton, baseText) : undefined;
  const doc = base ? await lc.carton.checkout(base) : (await lc.carton.head()).doc;
  const items = doc.timelineItems as Record<string, unknown>[];
  const at = items.findIndex((i) => i.id === clip || String(i.name).toLowerCase() === clip.toLowerCase());
  if (at < 0) throw new Error(`no clip "${clip}"`);
  // Documents are values, and frozen: an edit in place throws. Replace the record you change (a copy of it, in a copy
  // of its array); Carton shares unchanged records between versions.
  const item = { ...items[at] };
  for (const s of sets) {
    const [field, raw] = s.split("=");
    item[field] = raw !== "" && Number.isFinite(Number(raw)) ? Number(raw) : raw;
  }
  const r = await lc.write({ kind: "commit", doc: { ...doc, timelineItems: items.with(at, item) }, base });
  console.log(`${lc.actor.id}: ${resultText(r, "Saved")}`);
} finally {
  await lc.close();
}
