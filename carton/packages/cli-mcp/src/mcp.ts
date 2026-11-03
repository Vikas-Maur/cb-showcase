// MCP tools (§0.1, §10). `timeline_history`, `check_timeline` and `undo_timeline` keep 1.4.0's names and meaning on
// Carton's history: history lists versions newest first (with who made each); check reports what an edit would change
// and which cards it would raise, writing nothing; undo restores a version (`rev`), or with no rev undoes the caller's
// newest change (C10: undo is scoped to you and the agents acting for you), or a whole turn (`turn`). New:
// `timeline_cuts`, `timeline_fold`, `timeline_credits`, `timeline_publish`.
//
// One shape description per tool feeds both the JSON Schema of the standalone server and the zod shape Cardboard's
// MCP table wants (`registerMcp` takes Cardboard's `z`), so the two can't drift.
import { COMMANDS } from "./commands.ts";
import type { CbContext, CommandSpec, Output } from "./commands.ts";
import { resolveVersion } from "./refs.ts";
import { resultText, exitCodeOf, cardLine } from "./format.ts";
import { apply, describe, diff, fork, merge3 } from "@carton/core";
import type { Carton, ConflictCard, Doc, Op, StateRef } from "@carton/core";

/**
 * What saving `doc` (or `ops`) made on `base` would do now, writing nothing: the 3-way merge against head that a commit
 * runs (base → head, base → proposal), its changes in plain words, its cards, and the records that would break a hard
 * validator (they would block with a card).
 */
export async function dryRun(carton: Carton, o: { doc?: Doc; ops?: Op[]; base?: StateRef | string }): Promise<{ changes: string[]; ops: number; conflicts: ConflictCard[] }> {
  const head = await carton.head();
  const baseDoc = o.base ? await carton.checkout(o.base) : head.doc;
  const proposed = o.doc ?? apply(fork(baseDoc, carton.schema), o.ops ?? [], carton.schema);
  const m = merge3(baseDoc, head.doc, proposed, carton.schema);
  const ops = diff(head.doc, m.doc, carton.schema);
  const conflicts = [...m.conflicts];
  const hard = carton.schema.hard;
  if (hard) {
    for (const [coll, spec] of Object.entries(carton.schema.collections)) {
      const before = new Map(((head.doc[coll] as Record<string, unknown>[] | undefined) ?? []).map((r) => [String(r[spec.key]), JSON.stringify(r)]));
      for (const r of (m.doc[coll] as Record<string, unknown>[] | undefined) ?? []) {
        const id = String(r[spec.key]);
        if (before.get(id) === JSON.stringify(r)) continue; // only what this save changes
        const errs = hard(coll, r, m.doc);
        if (errs.length && !conflicts.some((c) => c.path === `${coll}/${id}`)) conflicts.push({ kind: "invalid", path: `${coll}/${id}`, base: undefined, ours: undefined, theirs: r, reason: errs.join("; ") });
      }
    }
  }
  return { changes: describe(ops, head.doc, carton.schema), ops: ops.length, conflicts };
}

type Field = { type: "string" | "integer" | "boolean" | "strings" | "object" | "array"; description: string; optional?: boolean; enum?: string[] };
export type Shape = Record<string, Field>;

export interface McpToolSpec {
  name: string;
  description: string;
  shape: Shape;
  readOnly: boolean;
  run(ctx: CbContext, args: Record<string, any>): Promise<Output>;
}

const spec = (path: string) => COMMANDS.find((c) => c.path.join(" ") === path) as CommandSpec;

export const MCP_TOOLS: readonly McpToolSpec[] = [
  {
    name: "timeline_history",
    description: "Saved timeline versions, newest first, with who made each (person, agent turn, subagent).",
    shape: { cut: { type: "string", description: "cut name or id (default: current)", optional: true }, limit: { type: "integer", description: "how many (default 20)", optional: true } },
    readOnly: true,
    async run(ctx, a) {
      const o = await spec("history").run(ctx, { cut: a.cut, limit: a.limit, stats: true });
      const vs = (o.json as any).versions as any[];
      // 1.4.0's text shape: `rev  at  N tracks  N items  Ns`, plus who
      const text = vs.map((v) => `${v.version}  ${new Date(v.at).toISOString()}  ${v.tracks} tracks  ${v.items} items  ${v.duration.toFixed(1)}s  by ${v.by?.name ?? v.by?.id ?? "unknown"}`).join("\n") || "No revisions yet";
      return { json: { revisions: vs }, text };
    },
  },
  {
    name: "check_timeline",
    description: "Report what saving a timeline document (or ops) would change and which conflict cards it would raise, without writing. `base` is the header rev it was made from (default: the current head).",
    shape: {
      doc: { type: "object", description: "the edited document", optional: true },
      ops: { type: "array", description: "or the ops", optional: true },
      base: { type: "string", description: "the `cardboard:rev` it was made from (default: current head)", optional: true },
    },
    readOnly: true,
    async run(ctx, a) {
      const { carton } = ctx.project;
      if (a.doc === undefined && a.ops === undefined) return { json: { status: "error", error: "pass doc or ops" }, text: "pass doc or ops", exitCode: 2 };
      const r = await dryRun(carton, { doc: a.doc as Doc | undefined, ops: a.ops as Op[] | undefined, base: a.base ? await resolveVersion(carton, String(a.base)) : undefined });
      const lines = [...r.changes.map((l) => `- ${l}`), ...(r.conflicts.length ? [`Would raise ${r.conflicts.length} card${r.conflicts.length === 1 ? "" : "s"}:`, ...r.conflicts.map((c, i) => `  ${cardLine(c, i)}`)] : [])];
      return { json: { applied: false, ...r }, text: lines.join("\n") || "No changes", exitCode: r.conflicts.some((c) => c.kind === "invalid") ? 1 : 0 };
    },
  },
  {
    name: "undo_timeline",
    description: "Undo: with `rev`, restore that version (from timeline_history); with `turn`, undo every change of that agent turn; otherwise undo your newest change. Restoring is itself a version.",
    shape: { rev: { type: "string", description: "version to restore (<cut>@<seq>)", optional: true }, turn: { type: "string", description: "agent turn id to undo", optional: true } },
    readOnly: false,
    async run(ctx, a) {
      const o = await spec("undo").run(ctx, { version: a.rev, turn: a.turn });
      const r: any = o.json;
      const restored = r.status === "confirmed" && !r.empty ? (r.ref ?? r.seq ?? null) : null;
      return { json: { restored, ...r }, text: restored === null && r.status === "confirmed" ? "Nothing to undo" : o.text, exitCode: o.exitCode };
    },
  },
  {
    name: "timeline_cuts",
    description: "Cuts (separate lines of the edit, git branches): list them, start one from a version, or switch the current one.",
    shape: {
      action: { type: "string", description: "list (default), new, or switch", optional: true, enum: ["list", "new", "switch"] },
      name: { type: "string", description: "new: the cut's name; switch: the cut to switch to", optional: true },
      from: { type: "string", description: "new: version to start from (default: head)", optional: true },
    },
    readOnly: false,
    async run(ctx, a) {
      const action = a.action ?? "list";
      if (action === "list") return spec("cut list").run(ctx, {});
      if (!a.name) return { json: { status: "error", error: "name is required" }, text: "name is required", exitCode: 2 };
      return action === "new" ? spec("cut new").run(ctx, { name: a.name, from: a.from }) : spec("cut switch").run(ctx, { cut: a.name });
    },
  },
  {
    name: "timeline_fold",
    description: "Fold a cut into the current one (git merge). `check` reports cards without saving; `reject` folds in some of it, keeping the listed record paths out. Folding the same cut again later folds in the rest.",
    shape: {
      cut: { type: "string", description: "the cut to fold in" },
      into: { type: "string", description: "fold into this cut instead of the current one", optional: true },
      check: { type: "boolean", description: "dry run", optional: true },
      reject: { type: "strings", description: "record paths to keep out, e.g. timelineItems/c3", optional: true },
      keep: { type: "string", description: "decide every card one way: mine (this cut's value) or theirs (the folded cut's)", optional: true, enum: ["mine", "theirs"] },
    },
    readOnly: false,
    run: (ctx, a) => spec("fold").run(ctx, { cut: a.cut, into: a.into, check: a.check, reject: a.reject, keep: a.keep }),
  },
  {
    name: "timeline_credits",
    description: "Who last changed a clip or track, down to the subagent (git blame).",
    shape: { clip: { type: "string", description: "clip id or name" }, cut: { type: "string", description: "cut (default: current)", optional: true } },
    readOnly: true,
    run: (ctx, a) => spec("credits").run(ctx, { clip: a.clip, cut: a.cut }),
  },
  {
    name: "timeline_publish",
    description: "Publish a version (default: head) as the Published cut the share link shows (git tag).",
    shape: { version: { type: "string", description: "<cut>@<seq> (default: head)", optional: true }, name: { type: "string", description: "label", optional: true } },
    readOnly: false,
    run: (ctx, a) => spec("publish").run(ctx, { version: a.version, name: a.name }),
  },
  // Carton UX v2 (N0): find a version, the landmarks, bring back one clip, show a comparison (DESIGN-V2 §5)
  {
    name: "timeline_find",
    description: "Find versions by a clip's name, words from a title or caption, an agent's request, a version's name, a person or a day (every word matches a word's start). Newest first, each with why it matched and its <cut>@<seq>.",
    shape: { text: { type: "string", description: "the words, e.g. \"intro\" or \"sent client\"" }, cut: { type: "string", description: "cut (default: current)", optional: true }, all: { type: "boolean", description: "every match, not the newest 5", optional: true }, allCuts: { type: "boolean", description: "search every cut", optional: true } },
    readOnly: true,
    run: (ctx, a) => spec("history").run(ctx, { find: a.text, cut: a.cut, all: a.all, "all-cuts": a.allCuts }),
  },
  {
    name: "timeline_landmarks",
    description: "The versions people remember, newest first: exported, sent, named, agent turns, each start (when the project was opened) and before a restore. Use them to find \"the version I sent the client\".",
    shape: { cut: { type: "string", description: "cut (default: current)", optional: true } },
    readOnly: true,
    run: (ctx, a) => spec("history").run(ctx, { landmarks: true, cut: a.cut }),
  },
  {
    name: "timeline_restore_clip",
    description: "Bring back one clip as it was in a version, as a new version on top: nothing else changes, and Ctrl+Z takes it back. A clip deleted since comes back; one that wasn't there then is taken out only with remove.",
    shape: { version: { type: "string", description: "<cut>@<seq>, or sent, exported, today, a version's name" }, clip: { type: "string", description: "the clip's name or id" }, remove: { type: "boolean", description: "it wasn't in that version: take it out", optional: true } },
    readOnly: false,
    run: (ctx, a) => spec("restore").run(ctx, { version: a.version, clip: a.clip, remove: a.remove }),
  },
  {
    name: "timeline_compare",
    description: "What differs between two versions, of one cut or two (a cut's name is that cut now). show: open the comparison in the editor for the user, when they ask to show or compare something.",
    shape: { left: { type: "string", description: "<cut>@<seq>, a cut's name, sent, exported, today, now, a version's name" }, right: { type: "string", description: "default: the user's edit now", optional: true }, show: { type: "boolean", description: "open it in the editor", optional: true } },
    readOnly: false,
    run: (ctx, a) => spec("compare").run(ctx, { a: a.left, b: a.right, show: a.show }),
  },
];

/** JSON Schema for a tool's input (the standalone MCP server; `project` added when the host needs it). */
export function jsonSchema(shape: Shape, withProject = false): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = withProject ? ["project"] : [];
  if (withProject) properties.project = { type: "string", description: "project id, name or bundle path" };
  for (const [k, f] of Object.entries(shape)) {
    properties[k] = f.type === "strings" ? { type: "array", items: { type: "string" }, description: f.description }
      : f.type === "array" ? { type: "array", description: f.description }
      : { type: f.type, description: f.description, ...(f.enum ? { enum: f.enum } : {}) };
    if (!f.optional) required.push(k);
  }
  return { type: "object", properties, required, additionalProperties: false };
}

/** The zod shape for Cardboard's MCP table, built with Cardboard's own `z` (no zod dependency here). */
export function zodShape(z: any, shape: Shape): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, f] of Object.entries(shape)) {
    let t = f.type === "string" ? (f.enum ? z.enum(f.enum) : z.string()) : f.type === "integer" ? z.number().int() : f.type === "boolean" ? z.boolean()
      : f.type === "strings" ? z.array(z.string()) : f.type === "array" ? z.array(z.unknown()) : z.record(z.string(), z.unknown());
    t = t.describe(f.description);
    out[k] = f.optional ? t.optional() : t;
  }
  return out;
}

/** The standalone tool list (`McpTool` of the package contract). */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  call(ctx: CbContext, args: Record<string, unknown>): Promise<{ text: string; result: unknown; isError: boolean }>;
}

export function mcpTools(): McpTool[] {
  return MCP_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: jsonSchema(t.shape),
    readOnly: t.readOnly,
    async call(ctx, args) {
      const o = await t.run(ctx, args);
      return { text: o.text, result: o.json, isError: (o.exitCode ?? 0) !== 0 };
    },
  }));
}

export interface RegisterMcpDeps {
  /** Cardboard's zod. */
  z: any;
  /** Cardboard's `project` parameter schema (`fe`). */
  projectParam: unknown;
  /** Open a project for a call, as the `cb` process's actor. */
  open(project: string): Promise<CbContext>;
  /** Cardboard's result builder (`Y(structured, text)`). */
  result(structured: unknown, text: string): unknown;
  /** Skip tools Cardboard already serves (default: its own `check_timeline`, which H3 routes through Carton). */
  skip?: string[];
}

/** Add the Carton tools to Cardboard's MCP table: `tool(name, description, shape, readOnly, handler)`. */
export function registerMcp(tool: (name: string, description: string, shape: Record<string, unknown>, readOnly: boolean, handler: (args: any) => Promise<unknown>) => void, deps: RegisterMcpDeps): void {
  const skip = new Set(deps.skip ?? ["check_timeline"]);
  for (const t of MCP_TOOLS) {
    if (skip.has(t.name)) continue;
    tool(t.name, t.description, { project: deps.projectParam, ...zodShape(deps.z, t.shape) }, t.readOnly, async ({ project, ...args }: any) => {
      const ctx = await deps.open(project);
      const o = await t.run(ctx, args);
      const res: any = deps.result(o.json, o.text);
      return (o.exitCode ?? 0) !== 0 && res && typeof res === "object" ? { ...res, isError: true } : res;
    });
  }
}

export { resultText, exitCodeOf };
