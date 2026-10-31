// Naming cuts and versions on the command line. A version is `<cut>@<seq>` (`main@57`, `"30s Instagram cut"@3`), a
// bare `@<seq>` or `<seq>` on the current cut, `head`, or a full printed header ref
// (`main@57~3f9a1c0e b:<cut8> p:<nonce>`), which is passed through for core to check exactly. A cut is its id, an id
// prefix of at least 4 characters, or its name (any case; the current cut wins when two share a name).
import type { Carton, CutRecord, StateRef } from "@carton/core";

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export async function resolveCut(carton: Carton, text: string | undefined, cuts?: CutRecord[]): Promise<CutRecord> {
  const all = cuts ?? (await carton.cuts());
  if (!text) {
    const cur = all.find((c) => c.id === carton.cut);
    if (!cur) throw new UsageError("no current cut");
    return cur;
  }
  const exact = all.find((c) => c.id === text);
  if (exact) return exact;
  const lower = text.toLowerCase();
  const byName = all.filter((c) => c.name.toLowerCase() === lower);
  if (byName.length) return byName.find((c) => c.id === carton.cut) ?? byName[0];
  if (text.length >= 4) {
    const byId = all.filter((c) => c.id.startsWith(text));
    if (byId.length === 1) return byId[0];
    if (byId.length > 1) throw new UsageError(`"${text}" names more than one cut; use more of its id`);
  }
  throw new UsageError(`no cut named "${text}" (see \`cb cut list\`)`);
}

/** Header refs carry `~<hash8> b:<cut8>`: those go to core unchanged, so a stale one fails loudly (principle 9). */
const HEADER = /~[0-9a-f]{8} b:/;

export async function resolveVersion(carton: Carton, text: string): Promise<StateRef | string> {
  const t = text.trim();
  if (HEADER.test(t) || /^\d{13}$/.test(t)) return t;
  if (t === "head" || t === "HEAD") return (await carton.head()).ref;
  const at = t.lastIndexOf("@");
  const cutText = at > 0 ? t.slice(0, at).replace(/^["']|["']$/g, "") : "";
  const seqText = at >= 0 ? t.slice(at + 1) : t;
  if (!/^\d+$/.test(seqText)) throw new UsageError(`"${text}" isn't a version: use <cut>@<seq> (as \`cb history\` shows) or a header ref`);
  const cut = await resolveCut(carton, cutText || undefined);
  const seq = Number(seqText);
  const head = await carton.head(cut.id);
  if (seq > head.ref.seq) throw new UsageError(`${cut.name}@${seq} doesn't exist yet (head is @${head.ref.seq})`);
  return { branchId: cut.id, seq };
}

/** How a version prints: `<cut name>@<seq>`, quoted when the name has spaces. */
export const versionName = (cutName: string, seq: number): string => `${/\s/.test(cutName) ? JSON.stringify(cutName) : cutName}@${seq}`;
