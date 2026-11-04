// How actors are named and coloured. A subagent is always shown with the agent that started it ("Director › Explore"),
// because Credits go down to the subagent (§0.1) and an editor needs to know whose agent it was.

import type { Actor } from "./model.ts";

// Colours that read on Cardboard's dark panels (#151515–#262626) and stay apart from its clip colours.
const PALETTE = ["#f2a65a", "#7cc4fa", "#b892ff", "#5fd3a8", "#f27fa5", "#e8d06a", "#8fb3ff", "#ff9b85", "#6fd6e3", "#c6a4f5"];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * A stable presence colour for an actor. Agents take the colour of the person who started them. An entry that isn't
 * a UI actor (core's `{kind, id}` from the sync layer, with no `key`) is coloured by its id, then its name: never a
 * crash in the panel that draws it (UI audit P1-1).
 */
export function actorColor(a: Actor, byKey?: (key: string) => Actor | undefined): string {
  if (a.color) return a.color;
  if (a.kind !== "human" && a.parent && byKey) {
    const p = byKey(a.parent);
    if (p) return actorColor(p, byKey);
  }
  const loose = a as Partial<Actor> & { id?: unknown };
  const seed = typeof loose.key === "string" ? loose.key : typeof loose.id === "string" ? loose.id : typeof loose.name === "string" ? loose.name : "";
  return PALETTE[hash(seed) % PALETTE.length]!;
}

/** One or two letters for an avatar. Uses grapheme-safe slicing so "Émile" and emoji names don't split. No name: "?". */
export function initials(name: string): string {
  const parts = (typeof name === "string" ? name : "").trim().split(/\s+/).filter(Boolean);
  const first = (s: string) => Array.from(s)[0] ?? "";
  if (!parts.length) return "?";
  if (parts.length === 1) return first(parts[0]!).toUpperCase();
  return (first(parts[0]!) + first(parts[parts.length - 1]!)).toUpperCase();
}

/** A person with no name we know: never an id or an empty slot (design QA G30). */
export const NO_NAME = "Teammate";

/**
 * A teammate as every author slot names them (design QA G27): their first name, "Leo" for "Leo Park", as DESIGN has it
 * ("Leo's Director", "Leo's Main cut", "Leo and Mia are here"). No name at all: NO_NAME.
 */
export function firstName(name: unknown): string {
  const n = typeof name === "string" ? name.trim() : "";
  return n ? n.split(/\s+/)[0]! : NO_NAME;
}

/**
 * The name in an author slot: short, in words an editor knows. The person is `you` ("You"), a teammate their first name
 * ("Leo"), an agent its product name ("Director", "Claude Code"), and someone else's agent is named by its owner ("Leo's
 * Director"), so two Directors in one project are told apart. A subagent is the agent that started it ("Director"): its
 * type goes in actorDetail(), never in the slot. A system actor has no name ("").
 */
export function actorLabel(a: Actor, byKey?: (key: string) => Actor | undefined, you?: string): string {
  if (a.kind === "system") return "";
  if (a.kind === "human") return a.isYou && you ? you : firstName(a.name);
  const owned = (agent: Actor): string => {
    const owner = !agent.isYou && agent.parent && byKey ? byKey(agent.parent) : undefined;
    return owner && owner.kind === "human" ? `${firstName(owner.name)}'s ${agent.name}` : agent.name;
  };
  if (a.kind === "subagent") {
    const parent = a.parent && byKey ? byKey(a.parent) : undefined;
    return parent && parent.kind !== "human" ? owned(parent) : a.name;
  }
  return owned(a);
}

/**
 * More than the slot says, for a tooltip or a details view: a subagent's type and an agent's model ("Director ›
 * general-purpose · Opus 5.5"). Undefined when it would only repeat the slot.
 */
export function actorDetail(a: Actor, byKey?: (key: string) => Actor | undefined, you?: string): string | undefined {
  const label = actorLabel(a, byKey, you);
  if (!label) return undefined;
  // a teammate's whole name, where the slot has their first name ("Leo" → "Leo Park")
  const whole = a.kind === "human" && !(a.isYou && you) && typeof a.name === "string" ? a.name.trim() : "";
  let d = a.kind === "subagent" && a.subagentType ? `${label} › ${a.subagentType}` : whole || label;
  if (a.model) d += ` · ${a.model}`;
  return d === label ? undefined : d;
}

/**
 * Which agent an actor is, for its own mark (PLAN 3.1, DESIGN §6.1: the Director, Claude Code and Codex each have one,
 * never one sparkle for all): told by its product name. A subagent is its agent's name. Null for a person, the system
 * or any other agent.
 */
export function agentOf(a: Actor): "director" | "claude" | "codex" | null {
  if (a.kind !== "agent" && a.kind !== "subagent") return null;
  const n = typeof a.name === "string" ? a.name : "";
  return /claude/i.test(n) ? "claude" : /codex/i.test(n) ? "codex" : /director/i.test(n) ? "director" : null;
}

/** The chain from the person down to this actor: [Alice, Director, Explore]. */
export function actorChain(a: Actor, byKey: (key: string) => Actor | undefined): Actor[] {
  const out: Actor[] = [a];
  const seen = new Set([a.key]);
  let cur = a;
  while (cur.parent && !seen.has(cur.parent)) {
    const p = byKey(cur.parent);
    if (!p) break;
    out.unshift(p);
    seen.add(p.key);
    cur = p;
  }
  return out;
}
