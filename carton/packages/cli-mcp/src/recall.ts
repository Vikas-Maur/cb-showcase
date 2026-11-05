// Carton UX v2 (N0) for agents: `cb history --find`, `cb history --landmarks`, `cb restore <version> --clip` and
// `cb compare … --show`, in DESIGN-V2 §5's words. Plain lines an agent can repeat to the person in its own words; each
// line ends with the reference the agent passes back to `cb` (`main@41`), which it never shows the person. The person
// is "the user"; everyone else by name.
import { betweenCuts, nameShown, timecode, type Actor, type Carton, type CutRecord, type FindMatch, type Landmark, type StateRef, type Version } from "@carton/core";
import type { CbResult } from "@carton/local";
import type { CbContext, Output } from "./commands.ts";
import { exitCodeOf, noticeLines, resultText, shellWord, table } from "./format.ts";
import { resolveCut, resolveRef, resolveVersion, UsageError, versionName } from "./refs.ts";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "4:10 pm". */
export function clockTime(at: number): string {
  const d = new Date(at), h = d.getHours();
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}
/** "today 12:41 pm", "yesterday 4:10 pm", "Mon 4:10 pm", "Oct 30 4:10 pm". */
export function when(at: number, now: number): string {
  const d = new Date(at), n = new Date(now);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(n) - day(d)) / 86_400_000);
  const date = days === 0 ? "today" : days === 1 ? "yesterday" : days > 1 && days < 7 ? DAYS[d.getDay()]! : `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return `${date} ${clockTime(at)}`;
}
/** "yesterday at 4:10 pm", "today at 12:41 pm", "on Oct 30 at 9:02 am". */
const whenAt = (at: number, now: number) => {
  const [date, ...t] = when(at, now).split(" ");
  return `${/^\d|^[A-Z][a-z]{2}$/.test(date!) && !DAYS.includes(date!) ? "on " : ""}${date} at ${t.join(" ")}`;
};

/** The person is "the user" (the agent speaks to them); agents and teammates by name. */
function person(a: Actor | null | undefined, me: Actor): string {
  if (!a) return "someone";
  if (a.kind === "human" && (a.id === me.id || a.id === "person")) return "the user";
  return a.name ?? (a.kind === "agent" ? "an agent" : "a teammate");
}
const isAgent = (a: Actor | null | undefined) => !!a && (a.kind === "agent" || a.kind === "subagent" || !!a.turn);
const quote = (s: string) => `“${s}”`;
const cutMap = async (carton: Carton) => new Map((await carton.cuts()).map((c) => [c.id, c]));
const refOf = (cuts: Map<string, CutRecord>, r: StateRef) => versionName(cuts.get(r.branchId) ?? r.branchId.slice(0, 8), r.seq);
/** A version in words: its name in quotes, or "the version from <when>"; with `(when)` after a name. */
async function versionWords(carton: Carton, ref: StateRef, now: number): Promise<{ words: string; v: Version | undefined }> {
  const v = (await carton.log({ cut: ref.branchId, before: ref.seq + 1, limit: 1 }))[0];
  const at = v?.ref.seq === ref.seq ? v.at : undefined;
  // its name as people see it (Schema.shownName)
  const name = nameShown(carton.schema, v?.name);
  if (v?.ref.seq === ref.seq && name) return { words: `${quote(name)} (${at !== undefined ? whenAt(at, now) : "an earlier version"})`, v };
  return { words: at !== undefined ? `the version from ${whenAt(at, now)}` : "an earlier version", v };
}
/** One line of what a version did: its name or prompt, else its summary. */
async function versionLine(carton: Carton, ref: StateRef): Promise<{ v: Version | undefined; what: string }> {
  const v = (await carton.log({ cut: ref.branchId, before: ref.seq + 1, limit: 1, summary: true, rows: true }))[0];
  if (!v || v.ref.seq !== ref.seq) return { v: undefined, what: "" };
  const n = v.rows?.length ?? 0, name = nameShown(carton.schema, v.name);
  if (name && isAgent(v.author)) return { v, what: `${quote(name)}${n ? ` · ${n} change${n === 1 ? "" : "s"}` : ""}` };
  if (name) return { v, what: quote(name) };
  return { v, what: v.rows?.length === 1 ? v.rows[0]!.text : v.summary ?? v.kind };
}
const LANDMARK_WORD: Record<string, string> = { exported: "Exported", sent: "Sent", named: "Named", start: "Start", before: "Before" };
const span = (s?: { start: number; end: number }) => (s ? `${timecode(s.start)}–${timecode(s.end)}` : "");

// ------------------------------------------------------------------ cb history --find

export async function findCommand(ctx: CbContext, a: Record<string, any>): Promise<Output> {
  const { carton } = ctx.project;
  const now = ctx.now?.() ?? Date.now();
  const text = String(a.find ?? "").trim();
  if (!text) throw new UsageError("--find wants some words: a clip's name, words from a title or caption, an agent's request, or a person");
  const cut = await resolveCut(carton, a.cut);
  const show = a.all ? 1000 : Math.max(1, Math.min(Number(a.limit ?? 5), 1000));
  const r = await carton.find(text, { ...(a["all-cuts"] ? { allCuts: true } : { cut: cut.id }), limit: show, now });
  const cuts = await cutMap(carton);
  const where = a["all-cuts"] ? "every cut" : cut.kind === "main" ? "Main cut" : quote(cut.name);
  const lines: string[] = [];
  // a clip first, when the words name one: who added and changed it, from the per-version index
  const clip = r.clips[0];
  if (clip && !a["all-cuts"]) lines.push(await clipLine(ctx, clip.record, clip.name, clip.cut, !!clip.deleted, now));
  if (!r.total) {
    lines.push(`No versions on ${where} mention ${quote(text)}.`, `Try a clip's name, words from a title or caption, an agent's request, or a person.${a["all-cuts"] ? "" : " Other cuts: --all-cuts"}`);
    return { json: { cut: { id: cut.id, name: cut.name }, ...r }, text: lines.join("\n"), exitCode: 0 };
  }
  lines.push(`${r.total} version${r.total === 1 ? "" : "s"} on ${where} mention${r.total === 1 ? "s" : ""} ${quote(text)} (newest first):`);
  const rows: string[][] = [];
  for (const m of r.matches) rows.push(await matchRow(ctx, m, cuts, now, !!a["all-cuts"]));
  lines.push(...table(rows).split("\n").map((l) => `  ${l}`));
  if (r.total > r.matches.length) lines.push(`  … ${r.total - r.matches.length} more: cb history <project> --find ${shellWord(text)} --all${a["all-cuts"] ? " --all-cuts" : ""}`);
  return { json: { cut: { id: cut.id, name: cut.name }, clips: r.clips, matches: r.matches.map((m) => ({ ...m, version: refOf(cuts, m.ref) })), total: r.total, versions: r.versions }, text: lines.join("\n") };
}

async function matchRow(ctx: CbContext, m: FindMatch, cuts: Map<string, CutRecord>, now: number, allCuts: boolean): Promise<string[]> {
  const { carton } = ctx.project;
  const lm = m.landmarks?.find((k) => k !== "turn");
  const who = lm ? LANDMARK_WORD[lm]! : isAgent(m.author) ? m.author?.name ?? "An agent" : m.author?.name && person(m.author, ctx.actor) !== "the user" ? m.author.name : "You";
  const { what } = await versionLine(carton, m.ref);
  // why it matched, when the line doesn't say it: where the clip was, or the text
  const clip = m.field === "clip" && m.recordName ? (m.span ? `${quote(m.recordName)} was ${span(m.span)} here` : `${quote(m.recordName)}`) : m.field === "text" ? `text ${quote(m.snippet)}` : "";
  const line = clip && !what.includes(clip) ? (what ? `${what} · ${clip}` : clip) : what || m.snippet;
  const cutName = allCuts ? ` (${cuts.get(m.ref.branchId)?.name ?? "another cut"})` : "";
  return [when(m.at, now), who, line + cutName, refOf(cuts, m.ref)];
}

/** "The clip “Intro”: added by You on Oct 30, trimmed by Director today at 12:20 pm, trimmed by You at 12:41 pm." */
async function clipLine(ctx: CbContext, record: string, name: string, cut: string, deleted: boolean, now: number): Promise<string> {
  const { carton } = ctx.project;
  const list = await carton.touched({ cut, record });
  const pick = list.length > 4 ? [list[0]!, ...list.slice(-3)] : list;
  const parts: string[] = [];
  for (const t of pick) {
    const v = (await carton.log({ cut, before: t.seq + 1, limit: 1, summary: true, rows: true }))[0];
    const row = v?.rows?.find((x) => x.key === record);
    const verb = (row?.text.split(" ")[0] ?? "changed").toLowerCase();
    const who = person(t.author, ctx.actor);
    parts.push(`${verb} by ${who === "the user" ? "You" : who} ${whenAt(t.at, now)}`);
  }
  if (list.length > 4) parts.splice(1, 0, `${list.length - 4} more change${list.length - 4 === 1 ? "" : "s"}`);
  return `The clip ${quote(name)}${deleted ? " (deleted now)" : ""}: ${parts.join(", ") || "no change recorded"}.`;
}

// ------------------------------------------------------------------ cb history --landmarks

export async function landmarksCommand(ctx: CbContext, a: Record<string, any>): Promise<Output> {
  const { carton } = ctx.project;
  const now = ctx.now?.() ?? Date.now();
  const cut = await resolveCut(carton, a.cut);
  const list = await carton.landmarks({ cut: cut.id, limit: Math.max(1, Math.min(Number(a.limit ?? 20), 1000)) });
  const cuts = await cutMap(carton);
  const rows: string[][] = [];
  for (const l of list) rows.push([when(l.at, now), l.kind === "turn" ? l.by?.name ?? "Agent turn" : LANDMARK_WORD[l.kind]!, await landmarkWords(carton, l, now, ctx.actor), refOf(cuts, l.ref)]);
  const where = cut.kind === "main" ? "Main cut" : quote(cut.name);
  const text = list.length
    ? [`Landmarks on ${where} (newest first):`, ...table(rows).split("\n").map((x) => `  ${x}`), "Words that work in place of a reference: sent, exported, today, now, a version's name, a cut's name."].join("\n")
    : `No landmarks on ${where} yet: exports, sends, named versions, agent turns and each start show here.`;
  return { json: { cut: { id: cut.id, name: cut.name }, landmarks: list.map((l) => ({ ...l, version: refOf(cuts, l.ref) })) }, text };
}

async function landmarkWords(carton: Carton, l: Landmark, now: number, me: Actor): Promise<string> {
  const mine = l.personal ? " (only you see this)" : "";
  // a teammate's Exported or Sent (a shared cut's, through the sync server) says whose: "· by Leo"
  const self = carton.identity()?.id;
  const by = l.by && person(l.by, me) !== "the user" && !(l.by.kind === "human" && l.by.id === self) ? ` · by ${person(l.by, me)}` : "";
  switch (l.kind) {
    case "start": return `How it was when you opened it${mine}`;
    case "before": {
      const after = l.after ? (await carton.log({ cut: l.ref.branchId, before: Number(l.after.slice(l.after.lastIndexOf("@") + 1)) + 1, limit: 1, summary: true, rows: true }))[0] : undefined;
      const of = after?.title?.of ? (await carton.log({ cut: after.title.of.slice(0, after.title.of.lastIndexOf("@")), before: Number(after.title.of.slice(after.title.of.lastIndexOf("@") + 1)) + 1, limit: 1 }))[0] : undefined;
      const what = l.before === "restore" ? `Restoring ${of ? `the ${clockTime(of.at)} version` : "an earlier version"}`
        : l.before === "bring-back" ? `Bringing back ${after?.title?.name ? quote(after.title.name) : "a clip"}`
        : l.before === "fold" ? "Folding in another cut"
        : "Undoing an agent's turn";
      return `${what}${mine}`;
    }
    case "exported": {
      const len = await carton.checkout(l.ref).then((d) => duration(carton, d)).catch(() => null);
      return `${l.label ?? "The edit"}${len !== null ? ` · ${timecode(len)}` : ""}${by}`;
    }
    case "sent": return `${l.label ?? "Sent"}${by}`;
    case "named": return quote(l.label ?? "");
    case "turn": return (await versionLine(carton, l.ref)).what || quote(l.label ?? "");
  }
}
const duration = (carton: Carton, doc: Record<string, unknown>) => {
  const tl = carton.schema.timeline;
  if (!tl) return null;
  let d = 0;
  for (const it of (doc[tl.collection] as Record<string, unknown>[] | undefined) ?? []) d = Math.max(d, Number(it[tl.end]) || 0);
  return d;
};

// ------------------------------------------------------------------ cb restore <version> --clip

/** A clip by id, else by name: exact first, then the clips whose name starts with the words. */
function clipsNamed(carton: Carton, docs: Record<string, unknown>[], text: string): { id: string; name: string; start?: number }[] {
  const tl = carton.schema.timeline, coll = tl?.collection ?? "timelineItems", key = carton.schema.collections[coll]?.key ?? "id";
  const all = new Map<string, { id: string; name: string; start?: number }>();
  for (const d of docs) for (const r of (d[coll] as Record<string, unknown>[] | undefined) ?? []) {
    const id = String(r[key]);
    if (all.has(id)) continue;
    const name = carton.schema.label?.(coll, r, d as never) ?? String(r.name ?? id);
    all.set(id, { id, name, ...(tl && typeof r[tl.start] === "number" ? { start: r[tl.start] as number } : {}) });
  }
  const byId = all.get(text);
  if (byId) return [byId];
  const t = text.toLowerCase();
  const exact = [...all.values()].filter((c) => c.name.toLowerCase() === t);
  if (exact.length) return exact;
  return [...all.values()].filter((c) => c.name.toLowerCase().startsWith(t) || c.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(t)));
}

export async function restoreClipCommand(ctx: CbContext, a: Record<string, any>): Promise<Output> {
  const { carton } = ctx.project;
  const now = ctx.now?.() ?? Date.now();
  const v = await resolveVersion(carton, String(a.version));
  if (typeof v === "string") throw new UsageError("--clip wants a version as <cut>@<seq> (see `cb history`), or sent, exported, today, a version's name");
  const ref: StateRef = v;
  const [then, head] = await Promise.all([carton.checkout(v), carton.head()]);
  const text = String(a.clip);
  const found = clipsNamed(carton, [then, head.doc], text);
  const ver = await versionWords(carton, ref, now);
  if (!found.length) throw new UsageError(`No clip named ${quote(text)} in ${ver.words} or in the user's edit now. Nothing changed. See the clips with: cb source print <project>`);
  if (found.length > 1) {
    const named = found.slice(0, 4).map((c) => `${quote(c.name)}${c.start !== undefined ? ` (${timecode(c.start)})` : ""}`);
    const list = named.length === 2 ? named.join(" and ") : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
    return { json: { status: "ambiguous", clips: found }, text: `${found.length === 2 ? "Two" : found.length} clips match ${quote(text)}: ${list}. Nothing changed. Name one.`, exitCode: 1 };
  }
  const clip = found[0]!;
  const tl = carton.schema.timeline, coll = tl?.collection ?? "timelineItems", key = carton.schema.collections[coll]?.key ?? "id";
  const rec = (d: Record<string, unknown>) => ((d[coll] as Record<string, unknown>[] | undefined) ?? []).find((r) => String(r[key]) === clip.id);
  const was = rec(then), is = rec(head.doc);
  const place = (r: Record<string, unknown> | undefined) => (r && tl ? `${timecode(Number(r[tl.start]))}–${timecode(Number(r[tl.end]))}` : "");
  const record = `${coll}/${clip.id.replace(/~/g, "~0").replace(/\//g, "~1")}`;
  // who deleted it, read before the bring-back (which touches it too)
  const gone = !is ? (await carton.touched({ cut: head.ref.branchId, record, after: ref.branchId === head.ref.branchId ? ref.seq : 0 })).at(-1) : undefined;
  const secs = (n: number) => `${Math.round(n * 10) / 10} s`;
  if (!was && !a.remove) {
    // what taking it out would do with the rest (DESIGN-V2 §5.3: "everything after would move 4 s earlier")
    const choice = (await carton.bringBackChoices(ref).catch(() => null))?.added.find((c) => c.record === record);
    const after = choice?.ripple ? `; everything after would move ${secs(choice.ripple.by)} earlier` : "";
    return { json: { status: "not-in-version", clip, ...(choice ? { ripple: choice.ripple ?? null } : {}) }, text: `${quote(clip.name)} wasn't in ${ver.words}, so bringing that version back means taking it out${is ? ` (${place(is)}${after})` : ""}. Nothing changed. To take it out: cb restore <project> ${shellWord(String(a.version))} --clip ${shellWord(text)} --remove`, exitCode: 1 };
  }
  const r: CbResult = await ctx.project.write({ kind: "restoreClip", ref: `${ref.branchId}@${ref.seq}`, record, ...(a.remove ? { remove: true } : {}) }, { actor: ctx.actor });
  if (r.status === "error" || r.status === "rejected") return { json: r, text: resultText(r), exitCode: exitCodeOf(r) };
  const brought = (r as { brought?: { how: string; parts: string[]; place?: { placed: string; track?: string; takenBy?: { name: string }[] }; ripple?: { direction: string; by: number } | null } }).brought;
  const lines = [...noticeLines(r.notices ?? [])];
  // where it went and what else moved (N0b, DESIGN-V2 §5.3): a new track when its place was taken; the rest moved back
  const taken = brought?.place?.placed === "new-track" ? brought.place.takenBy?.map((t) => quote(t.name)) ?? [] : [];
  const placeLine = taken.length && was && tl ? `Its place is taken by ${taken.length > 1 ? `${taken.slice(0, -1).join(", ")} and ${taken.at(-1)}` : taken[0]}, so it went on a new track above, at ${timecode(Number(was[tl.start]))}.` : "";
  const moved = brought?.ripple ? `Everything after it moved ${secs(brought.ripple.by)} ${brought.ripple.direction}.` : "";
  const rest = [placeLine, moved, moved ? "Nothing else changed." : "Nothing else changed."].filter(Boolean).join(" ");
  if (brought?.how === "same") lines.push(`${quote(clip.name)} is already as it was in ${ver.words}. Nothing changed.`);
  else if (brought?.how === "removed") lines.push(`Took out ${quote(clip.name)}: it wasn't in ${ver.words}. ${rest}`, "The user can undo it with Ctrl+Z; you can with: cb undo <project>");
  else if (brought?.how === "added") {
    const track = was && tl ? String((then[tl.lanes] as Record<string, unknown>[] | undefined)?.find((t) => t.id === was[tl.lane])?.name ?? "its track") : "its track";
    lines.push(`Brought back ${quote(clip.name)}${gone ? ` (deleted by ${person(gone.author, ctx.actor)} ${whenAt(gone.at, now)})` : ""}${placeLine ? "" : ` where it was: ${tl && was ? timecode(Number(was[tl.start])) : ""} on ${track}`}. ${rest}`, "The user can undo it with Ctrl+Z; you can with: cb undo <project>");
  } else lines.push(`Brought back ${quote(clip.name)} as it was in ${ver.words}${was && is ? `: now ${place(was)}, was ${place(is)}` : ""}.${placeLine ? ` ${placeLine}` : ""}`, "Nothing else changed. The user can undo it with Ctrl+Z; you can with: cb undo <project>");
  if (r.status === "pending") lines.push("It is saved here and goes to the team's server when it's back.");
  if (r.status === "conflicts") lines.push(`A teammate changed ${quote(clip.name)} meanwhile: their value was kept, as a card. See it with: cb conflicts`);
  return { json: { ...r, clip }, text: lines.join("\n"), exitCode: exitCodeOf(r) };
}

// ------------------------------------------------------------------ cb compare <left> [right] --show

export async function compareShowCommand(ctx: CbContext, a: Record<string, any>): Promise<Output> {
  const { carton } = ctx.project;
  const now = ctx.now?.() ?? Date.now();
  const left = await resolveRef(carton, String(a.a));
  const right = a.b ? await resolveRef(carton, String(a.b)) : { ref: (await carton.head()).ref, cut: (await carton.cuts()).find((c) => c.id === carton.cut)! };
  if (typeof left.ref === "string" || typeof right.ref === "string") throw new UsageError("--show wants versions as <cut>@<seq>, a cut's name, sent, exported, today or now");
  const cuts = await cutMap(carton);
  const between: "versions" | "cuts" = left.ref.branchId !== right.ref.branchId ? "cuts" : "versions";
  const side = async (s: { ref: StateRef | string; cut?: CutRecord }) => {
    const r = s.ref as StateRef, c = cuts.get(r.branchId);
    const cutName = c ? (c.kind === "main" ? "Main cut" : quote(c.name)) : "another cut";
    if (s.cut && s.cut.id === carton.cut) return { words: between === "cuts" ? `${cutName} (the user's edit now)` : "the user's edit now", short: cutName, ref: s.cut.id };
    if (s.cut) return { words: `${cutName} (now)`, short: cutName, ref: s.cut.id };
    const w = (await versionWords(carton, r, now)).words;
    return { words: between === "cuts" ? `${cutName}: ${w}` : w, short: cutName, ref: `${r.branchId}@${r.seq}` };
  };
  const [l, rt] = await Promise.all([side(left), side(right)]);
  const d = await carton.diff(left.ref, right.ref, { rows: true });
  let rows = d.rows ?? [];
  if (between === "cuts") rows = betweenCuts(rows, await carton.checkout(left.ref), await carton.checkout(right.ref), carton.schema, { left: l.short, right: rt.short, here: right.cut?.id === carton.cut });
  const n = d.count ?? rows.length;
  const count = `${n} ${between === "cuts" ? (n === 1 ? "difference" : "differences") : n === 1 ? "change" : "changes"}`;
  const list = rows.slice(0, 40).map((x) => `  ${x.at !== undefined ? timecode(x.at).padEnd(5) : "     "} ${x.text}`);
  if (rows.length > 40) list.push(`  … ${rows.length - 40} more`);
  const w = await ctx.project.write({ kind: "open", view: "compare", from: l.ref, to: rt.ref }, { actor: ctx.actor });
  const shown = (w as { shown?: { status?: string; why?: string } }).shown;
  const opened = Number((w as { opened?: number }).opened ?? 0);
  // the app holds the project but its holder didn't answer in time (local's `unanswered`): never "no editor window"
  const unanswered = (w as { unanswered?: boolean }).unanswered === true;
  const pair = `${capital(l.words)} with ${rt.words}`;
  const head: string[] = [];
  if (!opened) head.push(unanswered ? "The editor didn't answer in time, so nothing opened. Here is the comparison:" : "No editor window has this project open, so nothing opened. Here is the comparison:", `${pair}: ${count}${n ? ":" : "."}`);
  else if (!shown) head.push(`Sent to the editor (it didn't say whether it opened): ${pair}. ${count}${n ? ":" : "."}`);
  else if (shown.status === "opened") head.push(`Opened in the editor: ${pair}. ${count}${n ? ":" : "."}`);
  else if (shown.status === "offered" && (shown.why === "viewing" || shown.why === "comparing")) head.push(`The user is already looking at another version. They have a note in the editor with Open; nothing was replaced.`, `${pair}: ${count}${n ? ":" : "."}`);
  else if (shown.status === "offered") head.push(`The user is busy ${shown.why === "playing" ? "playing the edit" : "editing"}, so the comparison didn't open. They have a note in the editor with Open.`, `${pair}: ${count}${n ? ":" : "."}`);
  else head.push(`The comparison can't open in the editor: ${shown.why === "not-here" ? "a side hasn't reached this computer yet" : "the editor refused it"}.`, `${pair}: ${count}${n ? ":" : "."}`);
  const tail = opened && shown?.status === "opened" ? ["The user can press Esc to go back to their edit."] : [];
  return { json: { from: l.ref, to: rt.ref, between, count: n, rows: rows.map((x) => ({ at: x.at, text: x.text, kind: x.kind })), opened, shown: shown ?? null, ...(unanswered ? { unanswered } : {}) }, text: [...head, ...(n ? list : []), ...tail].join("\n") };
}
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
