// The `timeline.tsx` header contract (PLAN §5.2, §6.4 R7-01):
//
//   // cardboard:rev main@57~3f9a1c0e b:<branchId8> p:<printNonce> by <actor>
//
// - the ref names the state the file shows, `<cut name>@<seq>~<stateHash8>`, exactly as core's `refString` prints it.
//   A cut's name may contain spaces ("30s Instagram cut@4~…"): the ref runs up to ` b:`;
// - `b:` is the first 8 characters of the branch id, because two cuts may share a name ("Bob's main");
// - `p:` is a nonce that is new for every print, so two prints of one state are told apart (system proof, Finding 3);
//   a per-agent view's "last applied save" base is keyed on it;
// - `by` names who printed it; it is the rest of the line and may contain spaces.
//
// Cardboard 1.4.0 prints `// cardboard:rev <stateUpdatedAt ms>` as the 4th line of its header block and reads the
// first line matching `^\s*//\s*cardboard:rev\s+(\d+)\s*$`. A bare number still parses here, as a legacy timestamp
// ref. Only the first rev line in a file counts, as in 1.4.0.

export const REV_TAG = "cardboard:rev";

export interface CartonRev {
  kind: "carton";
  /** The state ref: `main@57~3f9a1c0e`, `30s Instagram cut@4~0badf00d`. */
  ref: string;
  branch8: string | null;
  nonce: string | null;
  by: string | null;
}
export interface LegacyRev {
  kind: "legacy";
  /** 1.4.0's `stateUpdatedAt` (ms). */
  rev: number;
}
export type Rev = CartonRev | LegacyRev;

const LINE = /^[ \t]*\/\/[ \t]*cardboard:rev[ \t]+([^\r\n]*?)[ \t]*\r?$/m;
const LEGACY = /^\d+$/;
// The ref is lazy: it ends where the optional ` b:`, ` p:` and ` by ` fields take the rest of the line.
const BODY = /^(.+?)(?: b:([0-9A-Za-z_-]+))?(?: p:([0-9A-Za-z]+))?(?: by (.*))?$/;

export interface RevInput {
  ref: string;
  branchId?: string | null;
  nonce?: string | null;
  by?: string | null;
}

/** The header line, without a newline. */
export function renderRev({ ref, branchId, nonce, by }: RevInput): string {
  let s = `// ${REV_TAG} ${ref.replace(/[\r\n]+/g, " ")}`;
  if (branchId) s += ` b:${branchId.replace(/-/g, "").slice(0, 8)}`;
  if (nonce) s += ` p:${nonce}`;
  if (by) s += ` by ${by.replace(/[\r\n]+/g, " ")}`;
  return s;
}

/** Parses a header line's body (what follows `cardboard:rev`). */
// `revBody(rev)` turns it back into the string core's `parseRef` reads.
export function parseRevBody(body: string): Rev | null {
  const b = body.trim();
  if (LEGACY.test(b)) return { kind: "legacy", rev: Number(b) };
  const m = BODY.exec(b);
  if (!m) return null;
  return { kind: "carton", ref: m[1]!, branch8: m[2] ?? null, nonce: m[3] ?? null, by: m[4] ?? null };
}

export interface FoundRev {
  rev: Rev | null;
  /** The whole header line, as written (without its newline). */
  line: string;
  /** Character offsets of that line in the text. */
  start: number;
  end: number;
}

/** Finds the first `// cardboard:rev` line anywhere in a printed file. */
export function findRev(text: string): FoundRev | null {
  const m = LINE.exec(text);
  if (!m) return null;
  const line = m[0].replace(/\r$/, "");
  return { rev: parseRevBody(m[1]!), line, start: m.index, end: m.index + line.length };
}

/**
 * Puts `line` in place of the file's rev line, keeping everything else byte for byte. A file with no rev line gets
 * it as its first line.
 */
export function setRev(text: string, line: string): string {
  const f = findRev(text);
  if (!f) return line + "\n" + text;
  return text.slice(0, f.start) + line + text.slice(f.end);
}

/** A fresh print nonce: 8 hex characters. */
export function printNonce(random: (n: number) => Uint8Array = defaultRandom): string {
  let s = "";
  for (const b of random(4)) s += b.toString(16).padStart(2, "0");
  return s;
}
function defaultRandom(n: number): Uint8Array {
  const a = new Uint8Array(n);
  globalThis.crypto.getRandomValues(a);
  return a;
}

/** The ref string core's `parseRef`/`resolve` read for a parsed header: `<ref> b:<branch8> [p:<nonce>] [by <actor>]`. */
export function revBody(rev: CartonRev): string {
  let s = rev.ref;
  if (rev.branch8) s += ` b:${rev.branch8}`;
  if (rev.nonce) s += ` p:${rev.nonce}`;
  if (rev.by) s += ` by ${rev.by}`;
  return s;
}
