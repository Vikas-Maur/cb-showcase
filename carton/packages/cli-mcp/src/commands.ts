// The Carton commands (§0.1, §6.2, §8, §10): one registry used by the standalone `carton` bin, by Cardboard's own `cb`
// (commander, see commander.ts) and by the MCP tools (mcp.ts). Reads run in the calling process straight from
// carton.db; writes go through `project.write`, which hands them to the sync-lease holder (§6.2) and answers with the
// cb result contract: confirmed@seq, pending, or conflicts, with the actor's late-conflict notices first.
import { join } from "node:path";
import { pathKey } from "@carton/core";
import type { Actor, Carton, ConflictCard, CutRecord, Doc, Notice, Op, Version } from "@carton/core";
import type { CbResult, WriteOp } from "@carton/local";
import { ago, cardLine, exitCodeOf, noticeLines, resultText, shellWord, table, who } from "./format.ts";
import { resolveCut, resolveVersion, UsageError, versionName } from "./refs.ts";

/** An open project, as `@carton/local`'s `openLocal` returns it. */
export interface CbProject {
  readonly carton: Carton;
  /** The project folder (`openLocal`'s): paths a command answers with are made absolute against it. */
  readonly projectDir?: string;
  /** Run a write through the sync-lease holder (or in this process for a local-only cut). */
  write(op: WriteOp, opts?: { actor?: Actor; waitMs?: number }): Promise<CbResult>;
}

export interface CbContext {
  project: CbProject;
  actor: Actor;
  now?: () => number;
}

export interface Output {
  json: unknown;
  text: string;
  exitCode?: number;
}

export type OptType = "boolean" | "string" | "strings" | "number";
export interface ArgSpec { name: string; description: string; required?: boolean; variadic?: boolean }
export interface OptSpec { name: string; type: OptType; description: string; short?: string }

export interface CommandSpec {
  /** `["cut", "new"]`. */
  path: string[];
  summary: string;
  args: ArgSpec[];
  options: OptSpec[];
  /** Makes a change (goes through the lease holder). */
  write?: boolean;
  /** A git word for it (README: agents think in git). */
  gitAlias?: string[];
  /**
   * Carton runs it only when this holds; otherwise it is the host's own command of that name, run as it was
   * (Cardboard's `source print`, extended with `--view`). The standalone `carton` answers a usage error then.
   */
  only?: { when(a: Record<string, any>): boolean; otherwise: string };
  run(ctx: CbContext, a: Record<string, any>): Promise<Output>;
}

// ------------------------------------------------------------------ helpers

const out = (json: unknown, text: string, exitCode = 0): Output => ({ json, text, exitCode });
const writeOut = (r: CbResult, what: string, extra: Record<string, unknown> = {}): Output => ({ json: { ...r, ...extra }, text: resultText(r, what), exitCode: exitCodeOf(r) });

/** Track, item and duration counts of a state, from the schema's timeline config (as 1.4.0's `history` shows). */
export function stats(carton: Carton, doc: Doc): { tracks: number; items: number; duration: number } {
  const tl = carton.schema.timeline;
  if (!tl) return { tracks: 0, items: 0, duration: 0 };
  const items = (doc[tl.collection] as Record<string, unknown>[] | undefined) ?? [];
  let duration = 0;
  for (const it of items) { const e = Number(it[tl.end]); if (e > duration) duration = e; }
  return { tracks: ((doc[tl.lanes] as unknown[] | undefined) ?? []).length, items: items.length, duration };
}

async function cutNames(carton: Carton): Promise<Map<string, CutRecord>> {
  return new Map((await carton.cuts()).map((c) => [c.id, c]));
}

const versionOf = (v: Version, cuts: Map<string, CutRecord>) => versionName(cuts.get(v.ref.branchId) ?? v.ref.branchId.slice(0, 8), v.ref.seq);

/** A clip by id or by its label (name), on the timeline collection. */
function findRecord(carton: Carton, doc: Doc, text: string): { coll: string; id: string } {
  const tl = carton.schema.timeline;
  const colls = tl ? [tl.collection, tl.lanes, ...Object.keys(carton.schema.collections).filter((c) => c !== tl.collection && c !== tl.lanes)] : Object.keys(carton.schema.collections);
  for (const coll of colls) {
    const key = carton.schema.collections[coll]?.key ?? "id";
    const recs = (doc[coll] as Record<string, unknown>[] | undefined) ?? [];
    const hit = recs.find((r) => String(r[key]) === text) ?? recs.find((r) => typeof r.name === "string" && r.name.toLowerCase() === text.toLowerCase());
    if (hit) return { coll, id: String(hit[key]) };
  }
  throw new UsageError(`no clip or track "${text}" in the current version`);
}

/** The ops that put a card's chosen value in place (a leaf, a field group `…/#time`, or a whole record). */
export function opsForChoice(card: ConflictCard, value: unknown): Op[] {
  const segs = card.path.split("/").map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  // a record card's deleted side is null in core's cards (undefined once it has been through JSON)
  if (segs.length === 2) return value == null ? [{ op: "remove", path: segs }] : [{ op: "insert", path: segs, value }];
  const last = segs.at(-1)!;
  if (last.startsWith("#") && value && typeof value === "object") {
    const base = segs.slice(0, -1);
    return Object.entries(value as Record<string, unknown>).map(([f, v]) => (v === undefined ? { op: "unset", path: [...base, f] } : { op: "set", path: [...base, f], value: v }));
  }
  return value === undefined ? [{ op: "unset", path: segs }] : [{ op: "set", path: segs, value }];
}

// cards handed to the person are theirs now (the app's list), not the agent's
const conflictNotices = (ns: readonly Notice[]) => ns.filter((n) => (n.kind === "late-conflict" || n.kind === "rejected") && n.cards?.length && !(n as { handedToHuman?: number }).handedToHuman);

/** Open cards for the actor, numbered across its notices (newest notices last). */
async function openCards(ctx: CbContext): Promise<{ notice: Notice; card: ConflictCard }[]> {
  const ns = conflictNotices(await ctx.project.carton.notices(ctx.actor, { take: false }));
  return ns.flatMap((notice) => notice.cards!.map((card) => ({ notice, card })));
}

// ------------------------------------------------------------------ the commands

const history: CommandSpec = {
  path: ["history"],
  gitAlias: ["log"],
  summary: "List versions of a cut, newest first, with who made each (extends 1.4.0's `history`)",
  args: [],
  options: [
    { name: "cut", type: "string", description: "cut name or id (default: the current cut)" },
    { name: "limit", type: "number", description: "how many versions (default 20)" },
    { name: "stats", type: "boolean", description: "also count tracks, items and duration per version" },
  ],
  async run(ctx, a) {
    const { carton } = ctx.project;
    const cut = await resolveCut(carton, a.cut);
    const limit = Math.max(1, Math.min(Number(a.limit ?? 20), 1000));
    const versions = await carton.log({ cut: cut.id, limit });
    const names = await cutNames(carton);
    const now = ctx.now?.() ?? Date.now();
    const rows = [];
    for (const v of versions) {
      const row: Record<string, unknown> = { version: versionOf(v, names), ref: v.ref, at: v.at, by: v.author, kind: v.kind, name: v.name ?? null, change: v.change };
      // a partial fold is one version, a merge, with what it left out (UI audit P1-3; `cb fold` again folds in the rest)
      if (v.rejected) row.leftOut = v.rejected;
      if (a.stats) Object.assign(row, stats(carton, await carton.checkout(v.ref)));
      rows.push(row);
    }
    const head = ["VERSION", "SAVED", "BY", "WHAT", ...(a.stats ? ["TRACKS", "ITEMS", "DURATION"] : [])];
    const text = rows.length
      ? table([head, ...rows.map((r: any) => [r.version, ago(r.at, now), who(r.by), r.name ?? (r.leftOut ? `${r.kind} (${r.leftOut.length} left out)` : r.kind), ...(a.stats ? [String(r.tracks), String(r.items), `${r.duration.toFixed(1)}s`] : [])])])
      : "No versions yet";
    return out({ cut: { id: cut.id, name: cut.name }, versions: rows }, text);
  },
};

const cutList: CommandSpec = {
  path: ["cut", "list"],
  gitAlias: ["branch"],
  summary: "List the cuts (`*` is the current one)",
  args: [],
  options: [],
  async run(ctx) {
    const { carton } = ctx.project;
    const cuts = await carton.cuts();
    const rows = [];
    for (const c of cuts) {
      const head = c.shallow ? null : await carton.head(c.id).catch(() => null);
      rows.push({ ...c, current: c.id === carton.cut, head: head?.ref.seq ?? null });
    }
    const where = (c: CutRecord) => (c.tracking ? "read-only" : c.sequencer.kind === "local" ? "local" : c.sequencer.kind === "handingOff" ? "sharing…" : "shared");
    const text = table([["", "CUT", "KIND", "HEAD", "WHERE", "ID"], ...rows.map((c) => [c.current ? "*" : "", c.name, c.kind, c.head === null ? "-" : `@${c.head}`, where(c), c.id.slice(0, 8)])]);
    return out({ cuts: rows }, text);
  },
};

const cutNew: CommandSpec = {
  path: ["cut", "new"],
  summary: "Start a new cut from a version (default: the current cut's head). Only the edit is copied",
  args: [{ name: "name", description: "the cut's name, e.g. \"30s Instagram cut\"", required: true }],
  options: [{ name: "from", type: "string", description: "version to start from (<cut>@<seq>)" }],
  write: true,
  async run(ctx, a) {
    const from = a.from ? await resolveVersion(ctx.project.carton, a.from) : undefined;
    const r = await ctx.project.write({ kind: "fork", name: String(a.name), from: typeof from === "string" ? from : from ? `${from.branchId}@${from.seq}` : undefined }, { actor: ctx.actor });
    const cut = (r as any).cut as CutRecord | undefined;
    return { json: r, text: r.status === "error" ? resultText(r) : `New cut "${cut?.name ?? a.name}" (${cut?.id.slice(0, 8) ?? "?"})`, exitCode: exitCodeOf(r) };
  },
};

const cutSwitch: CommandSpec = {
  path: ["cut", "switch"],
  gitAlias: ["checkout"],
  summary: "Make another cut the current one (the editor follows)",
  args: [{ name: "cut", description: "cut name or id", required: true }],
  options: [],
  write: true,
  async run(ctx, a) {
    const cut = await resolveCut(ctx.project.carton, a.cut);
    const r = await ctx.project.write({ kind: "switch", cut: cut.id }, { actor: ctx.actor });
    return { json: { ...r, cut: { id: cut.id, name: cut.name } }, text: r.status === "error" ? resultText(r) : `Now on "${cut.name}"`, exitCode: exitCodeOf(r) };
  },
};

const share: CommandSpec = {
  path: ["share"],
  summary: "Share a cut with the team: from now on the sync server sequences it (with the carton command: --server <url> --token-file <file>)",
  args: [{ name: "cut", description: "cut name or id (default: the current cut)" }],
  options: [{ name: "server", type: "string", description: "the team's sync server (read by the carton command before the project opens)" }],
  write: true,
  async run(ctx, a) {
    // the carton command takes --server before the project opens (its helper syncs there); a host that runs these
    // commands itself (Cardboard's cb) syncs with the app's own server settings
    if (a.server !== undefined) throw new UsageError("--server goes to the `carton` command (with --token-file); here the app's own sync settings apply");
    const { carton } = ctx.project;
    const cut = a.cut ? await resolveCut(carton, a.cut) : (await carton.cuts()).find((c) => c.id === carton.cut)!;
    const r = await ctx.project.write({ kind: "share", cut: cut.id }, { actor: ctx.actor });
    if (r.status !== "confirmed") return writeOut(r, `Shared "${cut.name}"`);
    const rec = (r as { cut?: { sequencer?: { kind?: string } } }).cut;
    const text = rec?.sequencer?.kind === "server"
      ? `"${cut.name}" is shared: the team's server sequences it`
      : `Sharing "${cut.name}": its history is going up to the team's server; edits made meanwhile stay pending until the server has it`;
    return { json: { ...r, cut: { id: cut.id, name: cut.name, sequencer: rec?.sequencer ?? null } }, text, exitCode: 0 };
  },
};

const fold: CommandSpec = {
  path: ["fold"],
  gitAlias: ["merge"],
  summary: "Fold a cut into the current cut (or --into). --check reports cards without saving; --reject keeps parts out (fold it again later to fold in the rest)",
  args: [{ name: "cut", description: "the cut (or version) to fold in", required: true }],
  options: [
    { name: "into", type: "string", description: "fold into this cut instead of the current one" },
    { name: "check", type: "boolean", description: "dry run: what would change and which cards, nothing saved" },
    { name: "reject", type: "strings", description: "fold in some of it: a record path to keep out (repeatable), e.g. timelineItems/c3" },
    { name: "all-cards", type: "boolean", description: "when the merge base is missing, bring it in with every difference as a card" },
    { name: "keep", type: "string", description: "decide every card one way: mine (this cut's value) or theirs (the folded cut's)" },
  ],
  write: true,
  async run(ctx, a) {
    const { carton } = ctx.project;
    let from: string;
    let fromName = String(a.cut);
    try { const c = await resolveCut(carton, a.cut); from = c.id; fromName = c.name; } catch (e) {
      const v = await resolveVersion(carton, a.cut).catch(() => { throw e; });
      from = typeof v === "string" ? v : `${v.branchId}@${v.seq}`;
    }
    const intoCut = await resolveCut(carton, a.into);
    const into = a.into ? intoCut.id : undefined;
    // a fold's cards hold the cut folded into as `ours` and the cut folded in as `theirs`: name both sides
    const sides = { ours: intoCut.name, theirs: fromName };
    const missingBase = a["all-cards"] ? "all-cards" : "dialog";
    if (a.check) {
      // a dry run writes nothing, so it needs no lease
      const r: any = await carton.fold(from, { into, check: true, missingBase, author: ctx.actor });
      const cards: ConflictCard[] = r.cards ?? [];
      const text = r.status === "up-to-date" ? "Already folded in: nothing to do"
        : r.status === "missing-base" ? r.dialog.text
        : cards.length ? [`Would fold in with ${cards.length} card${cards.length === 1 ? "" : "s"}:`, ...cards.map((c, i) => `  ${cardLine(c, i, sides)}`), foldHint(a, sides, cards)].join("\n")
        : "Would fold in cleanly (no cards)";
      return out({ check: true, ...r, merge: undefined }, text);
    }
    if (a.keep !== undefined && a.keep !== "mine" && a.keep !== "theirs") throw new UsageError("--keep wants mine or theirs");
    const r = await ctx.project.write({ kind: "fold", from, into, reject: a.reject, missingBase, keep: a.keep }, { actor: ctx.actor });
    if ((r as any).upToDate) return out(r, "Already folded in: nothing to do");
    if ((r as any).dialog) return { json: r, text: (r as any).dialog.text, exitCode: 1 };
    // an undecided fold comes back with no change id: it saved nothing, and its cards are decided by folding again
    if (r.status === "conflicts" && r.id === undefined && r.landed === undefined) {
      const n = r.conflicts.length;
      const text = [...noticeLines(r.notices ?? []), `Not folded in: ${n} card${n === 1 ? "" : "s"}, nothing was saved.`, ...r.conflicts.map((c, i) => `  ${cardLine(c, i, sides)}`), foldHint(a, sides, r.conflicts)].join("\n");
      return { json: r, text, exitCode: exitCodeOf(r) };
    }
    // a fold that landed (on a shared cut) and came back with late cards: they are the caller's to resolve
    if (r.status === "conflicts") {
      const n = r.conflicts.length;
      const text = [...noticeLines(r.notices ?? []), `Folded in, but ${n} card${n === 1 ? "" : "s"} came back: the other side's value was kept.`, ...r.conflicts.map((c, i) => `  ${cardLine(c, i)}`), "See them with `cb conflicts <project>`, and pick with `cb resolve`."].join("\n");
      return { json: r, text, exitCode: exitCodeOf(r) };
    }
    return writeOut(r, a.reject?.length ? `Folded in (kept out: ${a.reject.join(", ")})` : (r as any).rest ? "Folded in the rest (what an earlier partial fold kept out)" : "Folded in");
  },
};

/**
 * How to decide a fold's cards: fold again keeping one side, or keep the clips the cards are about out. The command is
 * meant to be pasted into a shell, so every name in it is quoted (a cut may be called anything).
 */
function foldHint(a: Record<string, any>, sides: { ours: string; theirs: string }, cards: readonly ConflictCard[]): string {
  const cmd = `cb fold <project> ${shellWord(String(a.cut))}${a.into ? ` --into ${shellWord(String(a.into))}` : ""}`;
  const rec = cards[0] ? shellWord(cards[0].path.split("/").slice(0, 2).join("/")) : "<path>";
  return `Decide with \`${cmd} --keep mine\` (keep ${sides.ours}'s) or \`--keep theirs\` (keep ${sides.theirs}'s), or keep a clip out with \`--reject ${rec}\`.`;
}

const credits: CommandSpec = {
  path: ["credits"],
  gitAlias: ["blame"],
  summary: "Who last changed a clip (or track), down to the subagent",
  args: [{ name: "clip", description: "clip id or name", required: true }],
  options: [{ name: "cut", type: "string", description: "cut name or id (default: the current cut)" }],
  async run(ctx, a) {
    const { carton } = ctx.project;
    const cut = await resolveCut(carton, a.cut);
    const { doc } = await carton.head(cut.id);
    const rec = findRecord(carton, doc, String(a.clip));
    const by = await carton.credits([rec.coll, rec.id], { cut: cut.id });
    const detail = by ? [by.agentType ? `subagent ${by.agentType}${by.agentId ? ` ${by.agentId}` : ""}` : null, by.chat ? `chat ${by.chat}` : null].filter(Boolean).join(", ") : "";
    return out({ record: pathKey([rec.coll, rec.id]), by }, by ? `${rec.id}: last changed by ${who(by)}${detail ? ` (${detail})` : ""}` : `${rec.id}: no change recorded since the project started`);
  },
};

const restore: CommandSpec = {
  path: ["restore"],
  gitAlias: ["revert"],
  summary: "Restore a version: its state saved as a new version on the current cut",
  args: [{ name: "version", description: "<cut>@<seq> from `cb history`, or a header ref", required: true }],
  options: [],
  write: true,
  async run(ctx, a) {
    const v = await resolveVersion(ctx.project.carton, String(a.version));
    const r = await ctx.project.write({ kind: "restore", ref: typeof v === "string" ? v : `${v.branchId}@${v.seq}` }, { actor: ctx.actor });
    return writeOut(r, `Restored ${a.version}`);
  },
};

const undo: CommandSpec = {
  path: ["undo"],
  summary: "Undo your newest change (your actor group's), a whole agent turn (--turn), or restore a version",
  args: [{ name: "version", description: "restore this version instead (1.4.0's `undo <rev>`)" }],
  options: [
    { name: "turn", type: "string", description: "undo every change of an agent turn (default with no value: your own turn)" },
    { name: "cut", type: "string", description: "cut name or id (default: the current cut)" },
  ],
  write: true,
  async run(ctx, a) {
    const { carton } = ctx.project;
    const cut = a.cut ? (await resolveCut(carton, a.cut)).id : undefined;
    if (a.version) return restore.run(ctx, { version: a.version });
    if (a.turn !== undefined) {
      const turn = a.turn === true || a.turn === "" ? ctx.actor.turn : String(a.turn);
      if (!turn) throw new UsageError("no turn to undo: pass --turn <turn id> (see `cb history`)");
      const r = await ctx.project.write({ kind: "undoTurn", turn, cut }, { actor: ctx.actor });
      // what the turn changed that was changed again since keeps its newer value as a card, and the rest is undone (the
      // answer says it landed). Cards with nothing landed (no change id: a holder from before that) undid nothing
      if (r.status === "conflicts" && r.id === undefined && r.landed === undefined) {
        const n = r.conflicts.length;
        const text = [...noticeLines(r.notices ?? []), `Not undone: ${n} thing${n === 1 ? "" : "s"} the turn changed ${n === 1 ? "was" : "were"} changed again since, nothing was saved.`, ...r.conflicts.map((c, i) => `  ${cardLine(c, i)}`)].join("\n");
        return { json: r, text, exitCode: exitCodeOf(r) };
      }
      return writeOut(r, `Undid turn ${turn}`);
    }
    const r = await ctx.project.write({ kind: "undo", group: ctx.actor.group, cut }, { actor: ctx.actor });
    if (r.status === "confirmed" && r.empty) return out(r, "Nothing to undo");
    const entry = (r as any).undid;
    return writeOut(r, entry?.label ?? "Undid your last change");
  },
};

const compare: CommandSpec = {
  path: ["compare"],
  gitAlias: ["diff"],
  summary: "What changed from one version to another, in plain words (default <b>: the current head)",
  args: [{ name: "a", description: "from version", required: true }, { name: "b", description: "to version (default: head)" }],
  options: [{ name: "shots", type: "boolean", description: "also the shot diff (Watch the changes)" }],
  async run(ctx, a) {
    const { carton } = ctx.project;
    const va = await resolveVersion(carton, String(a.a));
    const vb = a.b ? await resolveVersion(carton, String(a.b)) : undefined;
    const d = await carton.diff(va, vb, { shots: !!a.shots });
    const lines = d.describe.length ? d.describe.map((l) => `- ${l}`) : ["No differences"];
    if (d.shots) lines.push(`${d.shots.changed.length} shot run${d.shots.changed.length === 1 ? "" : "s"} differ; ${d.shots.unchanged} of ${d.shots.shotsB} shots unchanged${d.shots.shifted ? `, ${d.shots.shifted} moved` : ""}`);
    return out({ from: a.a, to: a.b ?? "head", changes: d.describe, ops: d.ops.length, shots: d.shots ?? null }, lines.join("\n"));
  },
};

const publish: CommandSpec = {
  path: ["publish"],
  gitAlias: ["tag"],
  summary: "Publish a version (default: the current head) as the Published cut the share link shows",
  args: [{ name: "version", description: "<cut>@<seq> (default: head)" }],
  options: [{ name: "name", type: "string", description: "label, e.g. \"Sent to client, Monday\"" }],
  write: true,
  async run(ctx, a) {
    const { carton } = ctx.project;
    const v = a.version ? await resolveVersion(carton, String(a.version)) : (await carton.head()).ref;
    const from = typeof v === "string" ? v : `${v.branchId}@${v.seq}`;
    const label = a.name ? String(a.name) : `Published ${new Date(ctx.now?.() ?? Date.now()).toISOString().slice(0, 10)}`;
    const r = await ctx.project.write({ kind: "fork", name: label, from, cutKind: "published" }, { actor: ctx.actor });
    const cut = (r as any).cut as CutRecord | undefined;
    return { json: { ...r, published: from }, text: r.status === "error" ? resultText(r) : `Published ${a.version ?? "head"} as "${cut?.name ?? label}"`, exitCode: exitCodeOf(r) };
  },
};

const conflicts: CommandSpec = {
  path: ["conflicts"],
  summary: "Your open conflict cards (late conflicts from changes that came back after your turn)",
  args: [],
  options: [],
  async run(ctx) {
    const open = await openCards(ctx);
    const text = open.length ? [`${open.length} open card${open.length === 1 ? "" : "s"}:`, ...open.map((o, i) => `  ${cardLine(o.card, i)}`), "Resolve with `cb resolve <n> --keep mine|theirs` (or --value <json>)."].join("\n") : "No open conflict cards";
    return out({ cards: open.map((o, i) => ({ n: i + 1, change: o.notice.change, ...o.card })) }, text);
  },
};

const resolve: CommandSpec = {
  path: ["resolve"],
  summary: "Resolve a conflict card: keep mine (your edit), theirs (what is there now), or a value",
  args: [{ name: "card", description: "card number from `cb conflicts`, or its path", required: true }],
  options: [
    { name: "keep", type: "string", description: "mine | theirs" },
    { name: "value", type: "string", description: "a JSON value to use instead" },
  ],
  write: true,
  async run(ctx, a) {
    const open = await openCards(ctx);
    const n = /^\d+$/.test(String(a.card)) ? Number(a.card) - 1 : open.findIndex((o) => o.card.path === a.card);
    const hit = open[n];
    if (!hit) throw new UsageError(`no open card ${a.card} (see \`cb conflicts\`)`);
    if (a.value === undefined && a.keep !== "mine" && a.keep !== "theirs") throw new UsageError("say --keep mine, --keep theirs, or --value <json>");
    // a rebase card's `theirs` is the actor's own edit and `ours` is head's value, which stayed in place provisionally
    const value = a.value !== undefined ? JSON.parse(String(a.value)) : a.keep === "mine" ? hit.card.theirs : hit.card.ours;
    const ops = a.keep === "theirs" && a.value === undefined ? [] : opsForChoice(hit.card, value);
    const r: CbResult = ops.length ? await ctx.project.write({ kind: "commit", ops }, { actor: ctx.actor }) : { status: "confirmed", seq: 0, ref: null, notices: [], empty: true };
    if (r.status === "confirmed" || r.status === "pending") await ctx.project.write({ kind: "closeCard", change: hit.notice.change ?? null, path: hit.card.path } as any, { actor: ctx.actor }).catch(() => null);
    return writeOut(r, `Resolved ${hit.card.path} (${a.value !== undefined ? "your value" : a.keep})`);
  },
};

const sourcePrint: CommandSpec = {
  path: ["source", "print"],
  summary: "Print your own view of the timeline to edit (.scratch/views/<name>.tsx); each save is applied, and its status file says how it went",
  args: [],
  options: [{ name: "view", type: "string", description: "your view's name (a hooked agent's view is named after it, whatever it asks)" }],
  write: true,
  only: { when: (a) => a.view !== undefined, otherwise: "plain `source print` is Cardboard's own command (`cb source print <project>`); Carton prints your own view: `source print --view <name>`" },
  async run(ctx, a) {
    if (a.view === undefined) throw new UsageError(sourcePrint.only!.otherwise);
    const r = await ctx.project.write({ kind: "printView", name: String(a.view) }, { actor: ctx.actor });
    const v = r.view as { name: string; path: string; ref: string; status: string } | undefined;
    if (r.status !== "confirmed" || !v) return { json: r, text: resultText(r, "Print your view"), exitCode: r.status === "confirmed" ? 1 : exitCodeOf(r) };
    // the materializer answers project-relative paths; the agent may be anywhere
    const dir = ctx.project.projectDir;
    const abs = (rel: string) => (dir ? join(dir, ...rel.split("/")) : rel);
    const view = { ...v, file: abs(v.path), statusFile: abs(v.status) };
    const lines = [...noticeLines(r.notices ?? []), `Your view "${view.name}" is at ${view.file} (version ${v.ref}).`, `Edit it and save it: each save is applied, and how it went (confirmed, conflicts, or what was wrong) is written to ${view.statusFile}.`];
    return { json: { ...r, view }, text: lines.join("\n") };
  },
};

const activity: CommandSpec = {
  path: ["activity"],
  summary: "Who has been editing: recent versions grouped by person, agent turn and subagent (C5)",
  args: [],
  options: [
    { name: "limit", type: "number", description: "how many versions to look back (default 200)" },
    { name: "cut", type: "string", description: "cut name or id (default: the current cut)" },
  ],
  async run(ctx, a) {
    const { carton } = ctx.project;
    const cut = await resolveCut(carton, a.cut);
    const versions = await carton.log({ cut: cut.id, limit: Math.max(1, Math.min(Number(a.limit ?? 200), 5000)) });
    const now = ctx.now?.() ?? Date.now();
    const groups = new Map<string, { by: Actor | null; changes: number; first: number; last: number; from: number; to: number }>();
    for (const v of versions) {
      if (!v.change) continue;
      const k = v.author ? `${v.author.id}|${v.author.turn ?? ""}` : "?";
      const g = groups.get(k) ?? { by: v.author, changes: 0, first: v.at, last: v.at, from: v.ref.seq, to: v.ref.seq };
      g.changes++;
      g.first = Math.min(g.first, v.at); g.last = Math.max(g.last, v.at);
      g.from = Math.min(g.from, v.ref.seq); g.to = Math.max(g.to, v.ref.seq);
      groups.set(k, g);
    }
    const list = [...groups.values()].sort((x, y) => y.last - x.last);
    const text = list.length ? table([["WHO", "CHANGES", "LAST", "VERSIONS"], ...list.map((g) => [who(g.by), String(g.changes), ago(g.last, now), g.from === g.to ? `@${g.from}` : `@${g.from}…@${g.to}`])]) : "No activity yet";
    return out({ cut: { id: cut.id, name: cut.name }, activity: list }, text);
  },
};

export const COMMANDS: readonly CommandSpec[] = [history, cutList, cutNew, cutSwitch, share, fold, credits, restore, undo, compare, publish, conflicts, resolve, activity, sourcePrint];

/** git word → Carton command (README; §0.1). `branch <name>` starts a cut; plain `branch` lists them. */
export const GIT_ALIASES: Readonly<Record<string, string>> = {
  branch: "cut",
  checkout: "cut switch",
  merge: "fold",
  log: "history",
  blame: "credits",
  revert: "restore",
  diff: "compare",
  tag: "publish",
};

export { noticeLines };
