// HTTP Range parsing shared by the loopback range server (Node) and the Fetch-API handler (Electron's protocol.handle,
// a web Service Worker).

/** An inclusive byte span, as in Content-Range. */
export interface ByteSpan {
  start: number;
  end: number;
}

/**
 * Parses a Range header against a representation of `size` bytes (RFC 9110 §14.1.2).
 * - null: no header, another unit, or bad syntax. RFC 9110 says to ignore such a header and answer 200 with the whole
 *   body, which also keeps a player that sent something odd working.
 * - "unsatisfiable": no range starts inside the body (416).
 * - otherwise one span. Several ranges are coalesced into one from the lowest start to the highest end (RFC 9110
 *   allows that); ffmpeg and Chromium only ever send one, and a multipart/byteranges body is code nobody here needs.
 */
export function parseRange(header: string | undefined, size: number): ByteSpan | "unsatisfiable" | null {
  if (header === undefined) return null;
  const eq = header.indexOf("=");
  if (eq < 0 || header.slice(0, eq).trim().toLowerCase() !== "bytes") return null;
  let start = Infinity;
  let end = -1;
  let specs = 0;
  for (const part of header.slice(eq + 1).split(",")) {
    if (part.trim() === "") continue; // RFC 9110 §5.6.1: recipients ignore empty list elements
    const m = RANGE_SPEC.exec(part);
    if (m === null || (m[1] === "" && m[2] === "")) return null;
    specs++;
    let a: number;
    let b: number;
    if (m[1] === "") {
      // Suffix: the last n bytes, or the whole body if it is shorter. "-0" is unsatisfiable.
      const n = Number(m[2]);
      if (n === 0 || size === 0) continue;
      a = Math.max(0, size - n);
      b = size - 1;
    } else {
      a = Number(m[1]);
      if (m[2] === "") {
        b = size - 1;
      } else {
        b = Number(m[2]);
        if (b < a) return null; // last-pos before first-pos is a syntax error, which voids the whole header
      }
      if (a >= size) continue;
      b = Math.min(b, size - 1);
    }
    if (a < start) start = a;
    if (b > end) end = b;
  }
  if (specs === 0) return null;
  return end < 0 ? "unsatisfiable" : { start, end };
}
const RANGE_SPEC = /^\s*(\d*)-(\d*)\s*$/;
