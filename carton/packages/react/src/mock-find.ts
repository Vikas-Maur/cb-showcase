// The mock's Carton UX v2 History reads (find, landmarks, bring back one clip, landmark pictures), for the gallery, the
// capture rig and tests. Plain and in-memory, the shapes the real engine answers (`@carton/core` find.ts,
// landmarks.ts, bring-back.ts, through the worker): never the engine's matching rules, only enough to show every state.

import type { Actor, BringBack, BringBackChoices, Change, Cut, CutHistoryPage, FindField, FindHit, FindHits, Landmark, Made, Version } from "./model.ts";
import { actorLabel } from "./actors.ts";

export interface MockFindState {
  all(): readonly Version[];
  /** The cuts (another cut's History, N2c). */
  cuts(): readonly Cut[];
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
  /** Landmarks on at first (`setLandmarks` turns them on or off). */
  landmarks: boolean;
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
  /** N0b's token for a clip, from its changes since a version: what it is now ("absent" once deleted). */
  const tokenOf = (list: readonly Change[]) => {
    const last = list[list.length - 1];
    return !last ? "same" : list.some((c) => c.kind === "remove") ? "absent" : `mock:${last.itemId}:${last.text}|${last.at ?? ""}|${last.end ?? ""}`;
  };
  let marking = st.landmarks;
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
    if (sent) recorded.set(sent.id, [{ kind: "sent", label: "Leo", by: st.me }]);
    // the fold an hour ago was exported (1080p); an older version of the generated history was sent too
    const fold = [...all].reverse().find((v) => v.kind === "fold");
    if (fold) recorded.set(fold.id, [{ kind: "exported", label: "1080p for the client", by: st.me }]);
    // (a long history's older export: the gallery's folded days; a short one has none)
    const old = all.length > 40 ? all[Math.floor(all.length * 0.6)] : undefined;
    if (old && !recorded.has(old.id)) recorded.set(old.id, [{ kind: "exported", label: "720p draft", by: st.me }]);
  };

  const landmarks = async (o: { kinds?: readonly Landmark["kind"][]; limit?: number } = {}): Promise<readonly Landmark[]> => {
    if (!marking) return [];
    seed();
    const all = st.all();
    const out: Landmark[] = [];
    const add = (v: Version, kind: Landmark["kind"], extra: Partial<Landmark> = {}) =>
      out.push({ id: `${kind}:${v.id}`, kind, versionId: v.id, ref: v.ref, at: v.at, by: v.author, personal: kind === "start" || kind === "before", local: kind !== "named" && kind !== "turn", picture: v.ref, ...extra });
    let lastDay = NaN;
    for (let i = 0; i < all.length; i++) {
      const v = all[i]!;
      // (nothing in it, or still on its way: never a landmark)
      if (v.provisional || v.start || v.empty) continue;
      const day = Math.floor(v.at / DAY);
      // each day's first version: how it was when you opened it (yours only)
      if (day !== lastDay && v.kind !== "import" && v.author.kind !== "system") add(v, "start", { by: st.me });
      lastDay = day;
      if (v.name && v.kind !== "turn") add(v, "named", { label: v.name });
      if (v.kind === "turn") add(v, "turn", { label: v.turn?.label ?? v.name ?? "" });
      for (const r of recorded.get(v.id) ?? []) add(v, r.kind, { ...(r.label ? { label: r.label } : {}), by: r.by ?? st.me });
      // just before a restore or a Bring back that you made: a safety point (yours only)
      const next = all[i + 1];
      if (next && next.kind === "restore" && next.author.isYou && next.author.kind === "human") add(v, "before", { before: next.summary.startsWith("Brought back") ? "bring-back" : "restore", after: next.ref, by: st.me });
    }
    out.reverse();
    const kinds = o.kinds;
    const list = kinds ? out.filter((l) => kinds.includes(l.kind)) : out;
    return list.slice(0, o.limit ?? 200);
  };

  const find = async (text: string, o: { limit?: number; fields?: readonly FindField[] } = {}): Promise<FindHits> => {
    const tokens = fold(text).split(/\s+/).filter(Boolean);
    const all = st.all();
    if (!tokens.length) return { clips: [], hits: [], total: 0, versions: all.length };
    const clips = new Map<string, { itemId: string; name: string; cutId: string }>();
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
      const order: FindField[] = ["clip", "text", "prompt", "name", "person"];
      const matched = order.filter((f) => fields.some((x) => x.field === f && tokens.some((t) => wordAt(x.text, t) >= 0)));
      if (o.fields && !matched.some((f) => o.fields!.includes(f))) continue;
      total++;
      if (hits.length >= (o.limit ?? 50)) continue;
      const best = fields.find((x) => x.field === matched[0] && tokens.some((t) => wordAt(x.text, t) >= 0))!;
      const ranges = tokens.map((x) => [wordAt(best.text, x), x.length] as const).filter(([a]) => a >= 0).map(([a, n]) => [a, a + n] as const);
      if (best.field === "clip" && best.itemId && best.clipName && !clips.has(best.itemId)) clips.set(best.itemId, { itemId: best.itemId, name: best.clipName, cutId: "cut-main" });
      hits.push({
        versionId: v.id,
        ref: v.ref,
        at: v.at,
        author: v.author,
        field: best.field,
        fields: matched,
        snippet: best.text,
        cutId: "cut-main",
        hits: ranges,
        ...(best.itemId ? { itemId: best.itemId } : {}),
        ...(best.clipName ? { clipName: best.clipName } : {}),
      });
    }
    return { clips: [...clips.values()].slice(0, 1), hits, total, versions: all.length };
  };

  const restoreClip = async (ref: string, itemId: string, o: { remove?: boolean; expect?: string } = {}): Promise<BringBack> => {
    const list = st.between(ref, st.head()).filter((c) => c.itemId === itemId);
    const name = list.map((c) => /“([^”]+)”/.exec(c.text)?.[1]).find(Boolean) ?? "the clip";
    // N0b: a clip that changed since the confirmation showed it is refused, with the new token (nothing written)
    if (o.expect !== undefined && o.expect !== tokenOf(list)) throw Object.assign(new Error(`“${name}” just changed again. Nothing was brought back.`), { code: "CHANGED_SINCE", token: tokenOf(list) });
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
    const l = all.find((x) => x.picture === key && x.kind !== "before" && x.kind !== "turn");
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
  /** "Choose a clip…" as the engine answers it: from what changed since, by clip (the mock's between()). */
  const bringBackChoices = async (ref: string): Promise<BringBackChoices> => {
    const by = new Map<string, Change[]>();
    for (const c of st.between(ref, st.head())) if (c.itemId) by.set(c.itemId, [...(by.get(c.itemId) ?? []), c]);
    const out: { changed: BringBackChoices["changed"][number][]; deleted: BringBackChoices["changed"][number][]; added: BringBackChoices["changed"][number][] } = { changed: [], deleted: [], added: [] };
    for (const [itemId, list] of by) {
      const last = list[list.length - 1]!;
      const name = list.map((c) => /“([^”]+)”/.exec(c.text)?.[1]).find(Boolean) ?? "";
      const noun = last.clip === "video" ? "clip" : last.clip;
      const span = last.at !== undefined ? { start: last.at, end: last.end ?? last.at } : undefined;
      // N0b's token: the clip as shown (the mock's newest change to it stands in for the engine's hash; "absent" once deleted)
      const token = tokenOf(list);
      const row = { itemId, name, noun, token, ...(last.author ? { by: last.author } : {}), ...(last.when !== undefined ? { at: last.when } : {}) };
      // N0b's place and ripple, for the gallery (made up, not computed): a deleted clip's place is taken by the newest
      // added one (a new track above), a clip added since was added with a ripple, a changed one moves nothing else
      const taker = [...by.values()].map((xs) => xs[xs.length - 1]!).find((c) => c.kind === "add");
      const takerName = taker ? (/“([^”]+)”/.exec(taker.text)?.[1] ?? "") : "";
      if (list.some((c) => c.kind === "remove"))
        out.deleted.push({ ...row, ...(span ? { then: span } : {}), place: taker ? { placed: "new-track", trackId: "track-2", takenBy: [{ itemId: taker.itemId!, name: takerName }] } : { placed: "same" }, ripple: null });
      else if (list.some((c) => c.kind === "add")) out.added.push({ ...row, ...(span ? { now: span } : {}), place: { placed: "same" }, ripple: span ? { direction: "earlier", by: span.end - span.start, at: span.start, moved: 3 } : null });
      else out.changed.push({ ...row, ...(span ? { now: span } : {}), place: { placed: "same" }, ripple: null });
    }
    return { ...out, same: 14 };
  };
  const setLandmarks = (on: boolean) => {
    marking = on;
    st.notify("landmarks");
  };
  /** Another cut's History (N2c): made up for the gallery, 120 versions a cut, newest first, its head as `cuts()` says. */
  const cutHistory = async (cutId: string, o: { before?: number; limit?: number } = {}): Promise<CutHistoryPage> => {
    const c = st.cuts().find((x) => x.id === cutId);
    if (!c) throw new Error("No such cut");
    const [prefix, headSeq] = [c.head.split("@")[0]!, Number(c.head.split("@")[1] ?? 0)];
    const top = Math.min(headSeq, (o.before ?? headSeq + 1) - 1);
    const limit = o.limit ?? 100;
    const SAYS = ["Trimmed “Interview A”, now ends at 0:11", "Moved “Logo sting” 1 s earlier", "Changed caption to “ship it”", "Cut “B-roll city” at 0:09", "Trimmed “Outro”, now ends at 0:30"];
    const versions: Version[] = [];
    for (let seq = top; seq >= 0 && versions.length < limit; seq--) {
      const at = st.now - (headSeq - seq) * 7 * 60_000 - 30 * 60_000;
      const author = seq % 3 === 0 ? (c.owner ?? st.me) : c.updatedBy ?? st.me;
      versions.push({ id: `${cutId}:${seq}`, seq, ref: `${prefix}@${seq}`, at, author, kind: seq === 0 ? "edit" : "edit", summary: seq === 0 ? `Made this cut from Main cut` : SAYS[seq % SAYS.length]!, changes: 1, ...(seq === headSeq - 4 ? { name: "Sent to Leo" } : {}), ...(seq === 0 ? { start: "created" as const } : {}) });
    }
    const last = versions[versions.length - 1];
    return { cutId, versions, ...(last && last.seq! > 0 && versions.length === limit ? { before: last.seq! } : {}) };
  };
  return { find, landmarks, restoreClip, bringBackChoices, cutHistory, landmarkPicture, saveLandmarkPicture, mark, setLandmarks };
}
