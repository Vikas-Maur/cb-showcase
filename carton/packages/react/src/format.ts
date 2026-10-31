// Time and length formatting in the editor's own style: lengths like the player's "0:13 / 0:26", differences in
// seconds with one decimal ("4.2 s", as describe() writes them), and short relative times in History.

/** A length or position as the player shows it: 7.4 → "0:07.4", 75 → "1:15.0", 3725 → "1:02:05". */
export function duration(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  if (s >= 3600) {
    const t = Math.round(s);
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
    return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }
  // Round to tenths first, so 59.96 becomes "1:00.0" and never "0:60.0".
  const tenths = Math.round(s * 10);
  const m = Math.floor(tenths / 600), rest = (tenths % 600) / 10;
  return `${m}:${rest.toFixed(1).padStart(4, "0")}`;
}

/** A difference in seconds, as describe() writes it: 4.25 → "4.3 s". */
export function seconds(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  return `${s.toFixed(1)} s`;
}

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

/**
 * When something happened, short and in the reader's locale: "just now", "4 min ago", "2 h ago", "Yesterday 14:05",
 * "Mon 14:05" within a week, then "3 Oct" (and the year when it differs).
 */
export function when(at: number, now: number, locale?: string, justNow = "just now"): string {
  const d = now - at;
  if (d < MIN) return justNow;
  if (d < HOUR) return `${Math.floor(d / MIN)} min ago`;
  const then = new Date(at), today = new Date(now);
  const time = then.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  if (d < 6 * HOUR && then.getDate() === today.getDate()) return `${Math.floor(d / HOUR)} h ago`;
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (at >= startOfToday) return time;
  if (at >= startOfToday - DAY) return `Yesterday ${time}`;
  if (at >= startOfToday - 6 * DAY) return `${then.toLocaleDateString(locale, { weekday: "short" })} ${time}`;
  const sameYear = then.getFullYear() === today.getFullYear();
  return then.toLocaleDateString(locale, sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
}

/** A full date and time for tooltips. */
export function exactTime(at: number, locale?: string): string {
  return new Date(at).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

/** A short date for names like "Offline edits (31 Oct)". */
export function shortDate(at: number, locale?: string): string {
  return new Date(at).toLocaleDateString(locale, { day: "numeric", month: "short" });
}
