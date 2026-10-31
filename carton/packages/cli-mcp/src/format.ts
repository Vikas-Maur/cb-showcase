// Plain-text output in Cardboard's CLI style (aligned columns, relative times) and the short text of the cb result
// contract (§6.2, R2-02). JSON output is the structured value itself; text is for people and for agents' context.
import type { Actor, ConflictCard, Notice } from "@carton/core";
import type { CbResult } from "@carton/local";

/** Aligned columns, the first row a header (as Cardboard's `me([...])`). */
export function table(rows: readonly (readonly string[])[]): string {
  if (!rows.length) return "";
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i]))).join("  ").trimEnd()).join("\n");
}

const unit = (n: number, u: string) => `${n} ${u}${n === 1 ? "" : "s"} ago`;
/** "just now", "5 minutes ago", "yesterday"… (Cardboard's wording). */
export function ago(at: number, now = Date.now()): string {
  const d = now - at;
  if (!Number.isFinite(d)) return "at an unknown time";
  if (d < 60e3) return "just now";
  if (d < 3600e3) return unit(Math.floor(d / 60e3), "minute");
  if (d < 86400e3) return unit(Math.floor(d / 3600e3), "hour");
  if (d < 172800e3) return "yesterday";
  if (d < 604800e3) return unit(Math.floor(d / 86400e3), "day");
  if (d < 2592e6) return unit(Math.floor(d / 604800e3), "week");
  if (d < 31536e6) return unit(Math.max(1, Math.floor(d / 2592e6)), "month");
  return "over a year ago";
}

/** "Director › editor (turn t3)", "Claude Code (terminal)", "alice". */
export function who(a: Actor | null | undefined): string {
  if (!a) return "unknown";
  const base = a.name ?? a.id;
  return a.turn && !base.includes("turn") ? `${base} (turn ${a.turn})` : base;
}

/**
 * One line per card: where, and both sides. A card of your own save (a rebase) holds what is there now as `ours` and
 * your edit as `theirs`: "yours" / "theirs" by default. A fold's card holds the cut folded into as `ours` and the cut
 * folded in as `theirs`: pass `sides` to name them (the cuts' names), so `--keep mine|theirs` reads the right way.
 */
export function cardLine(c: ConflictCard, i?: number, sides?: { ours: string; theirs: string }): string {
  const v = (x: unknown) => (x === undefined ? "deleted" : typeof x === "string" ? JSON.stringify(x) : JSON.stringify(x) ?? String(x));
  const head = i === undefined ? "" : `#${i + 1} `;
  const both = sides ? `${sides.ours}: ${v(c.ours)} · ${sides.theirs}: ${v(c.theirs)}` : `yours: ${v(c.theirs)} · theirs: ${v(c.ours)}`;
  return `${head}${c.path} (${c.kind}${c.reason ? `: ${c.reason}` : ""}) — ${both}`;
}

export function noticeLines(notices: readonly Notice[]): string[] {
  return notices.map((n) => (n.kind === "late-conflict" ? `Late conflict: ${n.text}` : n.kind === "rejected" ? `Rejected: ${n.text}` : n.text));
}

/** The short text of a write's result: the actor's notices first, then the status. */
export function resultText(r: CbResult, what = "Saved"): string {
  const lines = noticeLines(r.notices ?? []);
  switch (r.status) {
    case "confirmed":
      lines.push(r.empty ? "Nothing changed" : `${what}: confirmed${r.ref ? ` ${r.ref}` : r.seq ? ` @${r.seq}` : ""}`);
      break;
    case "pending":
      lines.push(r.online ? `${what}: pending (the server hasn't answered within 5 s; conflicts, if any, come back on your next call)` : `${what}: pending (offline; it syncs when the connection is back)`);
      break;
    case "conflicts":
      lines.push(`${what}: conflicts (${r.conflicts.length} card${r.conflicts.length === 1 ? "" : "s"}; nothing else was lost)`, ...r.conflicts.map((c, i) => `  ${cardLine(c, i)}`));
      lines.push("Resolve with `cb resolve <n> --keep mine|theirs`, or leave the cards for the user.");
      break;
    case "rejected":
      lines.push(`${what}: rejected (${r.reason})`);
      break;
    case "error":
      lines.push(`Error: ${r.error}`);
      break;
  }
  return lines.join("\n");
}

/** Exit code for a write: 0 when it is saved or queued, 1 when nothing was written. */
export const exitCodeOf = (r: CbResult): number => (r.status === "confirmed" || r.status === "pending" ? 0 : 1);
