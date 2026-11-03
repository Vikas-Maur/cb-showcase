// The mock's Carton UX v2 History reads (find, landmarks, bring back one clip, landmark pictures), for the gallery, the
// capture rig and tests. Plain and in-memory, the shapes the real engine answers (`@carton/core` find.ts,
// landmarks.ts, bring-back.ts, through the worker): never the engine's matching rules, only enough to show every state.

import type { Actor, BringBack, Change, FindField, FindHit, FindHits, Landmark, Made, Version } from "./model.ts";
import { actorLabel } from "./actors.ts";

export interface MockFindState {
  all(): readonly Version[];
  /** What a version did (its card's rows), by id. */
  did(id: string): readonly Change[];
  /** Changes from a to b (the mock's `between`). */
  between(a: string, b: string): readonly Change[];
  head(): string;
  actor(key: string): Actor | undefined;
  addVersion(v: Partial<Version>, changes?: readonly Change[]): Version;
  made(v: Version): Made;
  notify(topic: "landmarks" | "history"): void;
  me: Actor;
  now: number;
}

const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const QUOTED = /“([^”]+)”/g;
const DAY = 86_400_000;

/** Where the first query word starts a word in `text` (folded), or -1. */
function wordAt(text: string, token: string): number {
  const low = fold(text);
  let from = 0;
  for (;;) {
    const i = low.indexOf(token, from);
    if (i < 0) return -1;
    if (i === 0 || !/[\p{L}\p{N}]/u.test(low[i - 1]!)) return i;
    from = i + 1;
  }
}

export function mockFind(st: MockFindState) {
  const isAgent = (a: Actor) => a.kind === "agent" || a.kind === "subagent";
  const who = (a: Actor) => actorLabel(a, st.actor, "You");
  const pictures = new Map<string, string>();
  // the landmarks a session recorded (Exported, Sent): by version id
  const recorded = new Map<string, { kind: Landmark["kind"]; label?: string; by?: Actor }[]>();
  let made = 0;

  /** The story's own landmarks, read once from what History holds (the mockups' "Exported 1080p for the client", "Shared with Leo"). */
  const seed = () => {
    if (made) return;
    made = 1;
    const all = st.all();
    const named = all.filter((v) => v.name && v.kind !== "turn");
    const sent = named[named.length - 1];
    if (sent) recorded.set(sent.id, [{ kind: "shared", label: "Leo", by: st.me }]);
    // the fold an hour ago was exported (1080p); an older version of the generated history was sent too
    const fold = [...all].reverse().find((v) => v.kind === "fold");
    if (fold) recorded.set(fold.id, [{ kind: "exported", label: "1080p for the client", by: st.me }]);
    const old = all[Math.floor(all.length * 0.6)];
    if (old && !recorded.has(old.id)) recorded.set(old.id, [{ kind: "exported", label: "720p draft", by: st.me }]);
  };

  const landmarks = async (o: { kinds?: readonly Landmark["kind"][]; limit?: number } = {}): Promise<readonly Landmark[]> => {
    seed();
    const all = st.all();
    const out: Landmark[] = [];
    const add = (v: Version, kind: Landmark["kind"], extra: Partial<Landmark> = {}) =>
      out.push({ id: `${kind}:${v.id}`, kind, versionId: v.id, ref: v.ref, at: v.at, by: v.author, team: kind === "named" || kind === "turn" || kind === "published", picture: v.ref, ...extra });
    let lastDay = NaN;
    for (let i = 0; i < all.length; i++) {
      const v = all[i]!;
      // (nothing in it, or still on its way: never a landmark)
      if (v.provisional || v.start || v.empty) continue;
      const day = Math.floor(v.at / DAY);
      // each day's first version: how it was when you opened it (yours only)
      if (day !== lastDay) add(v, "session", { by: st.me, team: false });
      lastDay = day;
      if (v.name && v.kind !== "turn") add(v, "named", { label: v.name });
      if (v.kind === "turn") add(v, "turn", { label: v.turn?.label ?? v.name ?? "" });
      for (const r of recorded.get(v.id) ?? []) add(v, r.kind, { ...(r.label ? { label: r.label } : {}), by: r.by ?? st.me, team: false });
      // just before a restore or a Bring back that you made: a safety point (yours only)
      const next = all[i + 1];
      if (next && next.kind === "restore" && next.author.isYou && next.author.kind === "human") add(v, "safety", { before: next.summary.startsWith("Brought back") ? "bring-back" : "restore", by: st.me, team: false });
    }
    out.reverse();
    const kinds = o.kinds;
    const list = kinds ? out.filter((l) => kinds.includes(l.kind)) : out;
    return list.slice(0, o.limit ?? 200);
  };

  const find = async (text: string, o: { limit?: number; fields?: readonly FindField[] } = {}): Promise<FindHits> => {
    const tokens = fold(text).split(/\s+/).filter(Boolean);
    const all = st.all();
    if (!tokens.length) return { hits: [], total: 0, versions: all.length };
    const hits: FindHit[] = [];
    let total = 0;
    for (let i = all.length - 1; i >= 0; i--) {
      const v = all[i]!;
      if (v.start) continue;
      const changes = st.did(v.id);
      const fields: { field: FindField; text: string; itemId?: string; clipName?: string }[] = [];
      if (v.name && !isAgent(v.author)) fields.push({ field: "name", text: v.name });
      const prompt = v.turn?.label || (isAgent(v.author) ? v.name : undefined);
      if (prompt) fields.push({ field: "prompt", text: prompt });
      for (const c of changes) {
        const quoted = [...c.text.matchAll(QUOTED)].map((m) => m[1]!);
        if (!quoted.length) continue;
        if (c.clip === "title" || c.clip === "caption") fields.push({ field: "text", text: quoted[quoted.length - 1]!, ...(c.itemId ? { itemId: c.itemId } : {}) });
        else fields.push({ field: "clip", text: quoted[0]!, ...(c.itemId ? { itemId: c.itemId, clipName: quoted[0]! } : {}) });
      }
      fields.push({ field: "person", text: who(v.author) });
      const all_ = fields.map((f) => f.text).join(" ");
      if (!tokens.every((t) => wordAt(all_, t) >= 0)) continue;
      const order: FindField[] = ["name", "prompt", "clip", "text", "person"];
      const matched = order.filter((f) => fields.some((x) => x.field === f && tokens.some((t) => wordAt(x.text, t) >= 0)));
      if (o.fields && !matched.some((f) => o.fields!.includes(f))) continue;
      total++;
      if (hits.length >= (o.limit ?? 50)) continue;
      const best = fields.find((x) => x.field === matched[0] && tokens.some((t) => wordAt(x.text, t) >= 0))!;
      const t = tokens.find((x) => wordAt(best.text, x) >= 0)!;
      const at = wordAt(best.text, t);
      hits.push({
        versionId: v.id,
        ref: v.ref,
        at: v.at,
        author: v.author,
        field: best.field,
        fields: matched,
        snippet: best.text,
        hit: [at, at + t.length],
        ...(best.itemId ? { itemId: best.itemId } : {}),
        ...(best.clipName ? { clipName: best.clipName } : {}),
      });
    }
    return { hits, total, versions: all.length };
  };

  const restoreClip = async (ref: string, itemId: string, o: { remove?: boolean } = {}): Promise<BringBack> => {
    const list = st.between(ref, st.head()).filter((c) => c.itemId === itemId);
    const name = list.map((c) => /“([^”]+)”/.exec(c.text)?.[1]).find(Boolean) ?? "the clip";
    if (!list.length) return { how: "same", clipName: name };
    const added = list.some((c) => c.kind === "add");
    if (added && !o.remove) throw Object.assign(new Error(`“${name}” wasn't in this version. Bringing it back means taking it out.`), { code: "NOT_IN_VERSION" });
    const how = added ? "removed" : list.some((c) => c.kind === "remove") ? "added" : "changed";
    const v = st.addVersion(
      { author: st.me, kind: "restore", summary: added ? `Took out “${name}”` : `Brought back “${name}” from an earlier version` },
      list.map((c) => ({ ...c, kind: added ? "remove" : c.kind === "remove" ? "add" : "change", text: added ? `Removed “${name}”` : `Brought back “${name}”` })),
    );
    st.notify("landmarks");
    return { made: st.made(v), how, clipName: name };
  };

  // a picture per version: a dark frame with the story's title colours (the gallery's stand-in for a stage capture)
  const tile = (key: string) => {
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    const hue = [212, 160, 200, 28, 265][h % 5]!;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="88" height="50" viewBox="0 0 88 50"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},45%,30%)"/><stop offset="1" stop-color="hsl(${hue + 20},50%,14%)"/></linearGradient></defs><rect width="88" height="50" fill="url(#g)"/><rect x="10" y="18" width="40" height="13" rx="2" fill="#0b1830" opacity=".85"/><text x="14" y="28" font-family="sans-serif" font-size="9" font-weight="700" fill="#fff">Summer</text></svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  };
  const landmarkPicture = async (key: string): Promise<string | null> => {
    if (pictures.has(key)) return pictures.get(key)!;
    // a safety point's picture isn't made in the gallery: its shield shows (the fallback, DESIGN-V2 §2.2)
    const all = await landmarks();
    const l = all.find((x) => x.picture === key && x.kind !== "safety" && x.kind !== "turn");
    return l ? tile(key) : null;
  };
  const saveLandmarkPicture = async (key: string, jpeg: string) => {
    pictures.set(key, jpeg);
  };
  /** Record a landmark (an export, a send), as the worker's `mark` does. */
  const mark = (versionId: string, kind: Landmark["kind"], label?: string) => {
    seed();
    const xs = recorded.get(versionId) ?? [];
    xs.push({ kind, ...(label ? { label } : {}), by: st.me });
    recorded.set(versionId, xs);
    st.notify("landmarks");
  };
  return { find, landmarks, restoreClip, landmarkPicture, saveLandmarkPicture, mark };
}
