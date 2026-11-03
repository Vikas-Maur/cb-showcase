// Naming cuts and versions on the command line. A version is `<cut>@<seq>` (`main@57`, `30s Instagram cut@3`), a
// bare `@<seq>` or `<seq>` on the current cut, `head`, or a full printed header ref
// (`main@57~3f9a1c0e b:<cut8> p:<nonce>`), which is passed through for core to check exactly. A cut is its id, an id
// prefix of at least 4 characters, its name or its name as a slug (any case; `30s-instagram-cut`), or `main` for the
// main cut ("Main cut"), as the plan and agents write it. The current cut wins when two share a name.
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
  const slug = (n: string) => n.toLowerCase().trim().replace(/\s+/g, "-");
  let byName = all.filter((c) => c.name.toLowerCase() === lower || slug(c.name) === lower);
  if (!byName.length && lower === "main") byName = all.filter((c) => c.kind === "main");
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
  if (!/^\d+$/.test(seqText)) {
    // a cut's name (or id) alone is that cut's head (Carton UX v2: `cb compare "30s Instagram cut" main`)
    if (at < 0) {
      const cut = await resolveCut(carton, t.replace(/^["']|["']$/g, "")).catch(() => null);
      if (cut) return (await carton.head(cut.id)).ref;
    }
    throw new UsageError(`"${text}" isn't a version: use <cut>@<seq> (as \`cb history\` shows), a cut's name, or a header ref`);
  }
  const cut = await resolveCut(carton, cutText || undefined);
  const seq = Number(seqText);
  const head = await carton.head(cut.id);
  if (seq > head.ref.seq) throw new UsageError(`${cut.name}@${seq} doesn't exist yet (head is @${head.ref.seq})`);
  return { branchId: cut.id, seq };
}

/**
 * A version as `resolveVersion` reads it, and the cut it names when it was a cut alone (its head, which moves: an
 * editor shows it live) or `head`.
 */
export async function resolveRef(carton: Carton, text: string): Promise<{ ref: StateRef | string; cut?: CutRecord }> {
  const t = text.trim().replace(/^["']|["']$/g, "");
  const ref = await resolveVersion(carton, text);
  if (t === "head" || t === "HEAD") return { ref, cut: (await carton.cuts()).find((c) => c.id === carton.cut)! };
  if (!t.includes("@") && !/^\d+$/.test(t) && typeof ref !== "string") return { ref, cut: (await carton.cuts()).find((c) => c.id === ref.branchId)! };
  return { ref };
}

/** How a version prints: `main@<seq>` on the main cut, else `<cut name>@<seq>`. */
export const versionName = (cut: { name: string; kind?: string } | string, seq: number): string =>
  `${typeof cut === "string" ? cut : cut.kind === "main" ? "main" : cut.name}@${seq}`;
