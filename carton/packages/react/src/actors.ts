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

/** A stable presence colour for an actor. Agents take the colour of the person who started them. */
export function actorColor(a: Actor, byKey?: (key: string) => Actor | undefined): string {
  if (a.color) return a.color;
  if (a.kind !== "human" && a.parent && byKey) {
    const p = byKey(a.parent);
    if (p) return actorColor(p, byKey);
  }
  return PALETTE[hash(a.key) % PALETTE.length]!;
}

/** One or two letters for an avatar. Uses grapheme-safe slicing so "Émile" and emoji names don't split. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = (s: string) => Array.from(s)[0] ?? "";
  if (!parts.length) return "?";
  if (parts.length === 1) return first(parts[0]!).toUpperCase();
  return (first(parts[0]!) + first(parts[parts.length - 1]!)).toUpperCase();
}

/**
 * "Director › Explore" for a subagent, the name otherwise. `you` replaces the local person's name. Someone else's
 * agent is named by its owner ("Bob Okafor's Director"), so two Directors in one project are told apart.
 */
export function actorLabel(a: Actor, byKey?: (key: string) => Actor | undefined, you?: string): string {
  if (a.kind === "human") return a.isYou && you ? you : a.name;
  const owned = (agent: Actor): string => {
    const owner = !agent.isYou && agent.parent && byKey ? byKey(agent.parent) : undefined;
    return owner && owner.kind === "human" ? `${owner.name}'s ${agent.name}` : agent.name;
  };
  if (a.kind === "subagent") {
    const parent = a.parent && byKey ? byKey(a.parent) : undefined;
    const sub = a.subagentType ? `${a.subagentType}` : a.name;
    return parent ? `${owned(parent)} › ${sub}` : sub;
  }
  return owned(a);
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
