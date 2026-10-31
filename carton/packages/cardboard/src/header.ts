// The `timeline.tsx` header contract (PLAN §5.2, §6.4 R7-01):
//
//   // cardboard:rev main@57~3f9a1c0e b:<branchId8> p:<printNonce> by <actor>
//
// - the ref names the state the file shows: `main@57` on a confirmed state, `main@57~<stateHash8>` on a pinned
//   optimistic one. It is one token: a cut's name is percent-encoded where it has spaces ("30s%20cut@4");
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
  /** The state ref token, decoded: `main@57`, `main@57~3f9a1c0e`, `30s cut@4`. */
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
const BODY = /^(\S+)(?: b:([0-9A-Za-z_-]+))?(?: p:([0-9A-Za-z]+))?(?: by (.*))?$/;

/** Percent-encodes what would split the ref token (whitespace, `%`), so a cut name with spaces survives. */
export const encodeRefToken = (ref: string): string => ref.replace(/[%\s]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
const decodeRefToken = (tok: string): string => tok.replace(/%([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

export interface RevInput {
  ref: string;
  branchId?: string | null;
  nonce?: string | null;
  by?: string | null;
}

/** The header line, without a newline. */
export function renderRev({ ref, branchId, nonce, by }: RevInput): string {
  let s = `// ${REV_TAG} ${encodeRefToken(ref)}`;
  if (branchId) s += ` b:${branchId.replace(/-/g, "").slice(0, 8)}`;
  if (nonce) s += ` p:${nonce}`;
  if (by) s += ` by ${by.replace(/[\r\n]+/g, " ")}`;
  return s;
}

/** Parses a header line's body (what follows `cardboard:rev`). */
export function parseRevBody(body: string): Rev | null {
  const b = body.trim();
  if (LEGACY.test(b)) return { kind: "legacy", rev: Number(b) };
  const m = BODY.exec(b);
  if (!m) return null;
  return { kind: "carton", ref: decodeRefToken(m[1]!), branch8: m[2] ?? null, nonce: m[3] ?? null, by: m[4] ?? null };
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
