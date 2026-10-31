// Hard validators over a doc (PLAN §4.1): the host's schema invariants per record. Used by the local sequencer and the
// status sidecar's diagnostics; merge3 runs them on the records it touched.
import type { Schema } from "../schema.ts";
import type { Doc, PathKey, Rec } from "../types.ts";
import { getIn } from "./doc.ts";
import { pathKey, EMPTY } from "./json.ts";

/** Hard-validator problems of the given records (every record when `ids` is absent). */
export function validateHard(schema: Schema, doc: Doc, ids?: ReadonlyMap<string, ReadonlySet<string>>): { path: PathKey; errors: string[] }[] {
  const hard = schema.hard;
  if (!hard) return [];
  const out: { path: PathKey; errors: string[] }[] = [];
  const check = (cname: string, rec: Rec | undefined) => {
    if (!rec) return;
    const errors = hard(cname, rec, doc);
    if (errors.length) out.push({ path: pathKey([cname, rec[schema.collections[cname]!.key] as string]), errors });
  };
  if (ids) {
    for (const [cname, set] of ids) for (const id of set) check(cname, getIn(doc, [cname, id], schema) as Rec | undefined);
  } else for (const cname in schema.collections) for (const rec of (doc[cname] as Rec[] | undefined) ?? EMPTY) check(cname, rec);
  return out;
}
