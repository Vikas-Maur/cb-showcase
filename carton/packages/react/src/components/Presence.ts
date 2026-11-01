// Live presence (§12): who is here (people, their agents and the agents' subagents) and ghosts of remote drags.
//
// The avatars subscribe to "peers", which changes about once a second. Ghosts move at 10–20 Hz, so the ghost layer
// does not render through React at all: it subscribes to "ghosts" directly and moves its elements in one
// requestAnimationFrame per frame. React renders the layer once.

import { createElement as h, memo, useEffect, useMemo, useRef } from "react";
import { actorColor, actorDetail, actorLabel } from "../actors.ts";
import { useCartonUi, useCurrentCutId, usePeers, useWords } from "../hooks.ts";
import type { Actor, Ghost, Peer } from "../model.ts";
import { Avatar, cx } from "./ui.ts";

export interface PresenceProps {
  /** Show at most this many groups, then "+N". */
  max?: number;
  /** Only peers on this cut (default: the current cut). Pass null for everyone. */
  cutId?: string | null;
  className?: string;
}

interface Group {
  root: Peer;
  agents: Peer[];
}

/** People first, each followed by the agents and subagents acting for them. */
export function groupPeers(peers: readonly Peer[]): Group[] {
  const byKey = new Map(peers.map((p) => [p.actor.key, p]));
  const rootOf = (p: Peer): Peer => {
    let cur = p;
    const seen = new Set<string>();
    while (cur.actor.parent && byKey.has(cur.actor.parent) && !seen.has(cur.actor.key)) {
      seen.add(cur.actor.key);
      cur = byKey.get(cur.actor.parent)!;
    }
    return cur;
  };
  const groups = new Map<string, Group>();
  for (const p of peers) {
    const r = rootOf(p);
    let g = groups.get(r.actor.key);
    if (!g) groups.set(r.actor.key, (g = { root: r, agents: [] }));
    if (r !== p) g.agents.push(p);
  }
  const rank = (g: Group) => (g.root.actor.isYou ? 0 : g.root.actor.kind === "human" ? 1 : 2);
  return [...groups.values()].sort((a, b) => rank(a) - rank(b) || a.root.actor.name.localeCompare(b.root.actor.name));
}

const PeerAvatar = memo(function PeerAvatar({ peer, size }: { peer: Peer; size: number }) {
  const ui = useCartonUi();
  const words = useWords();
  // An avatar alone: its tooltip is its only label, so it says it all ("Director › Explore", the model).
  const label = (actorDetail(peer.actor, ui.actor.bind(ui), words.you) ?? actorLabel(peer.actor, ui.actor.bind(ui), words.you)) + (peer.idle ? ` · ${words.idle}` : peer.activity ? ` · ${peer.activity}` : "");
  return h("span", { className: "carton-peer", "data-idle": peer.idle ? "" : undefined, "data-kind": peer.actor.kind }, h(Avatar, { actor: peer.actor, size, title: label }));
});

export function PresenceAvatars({ max = 5, cutId, className }: PresenceProps) {
  const peers = usePeers();
  // The current cut's id only: a commit moving the head doesn't re-render the avatars (U6).
  const currentId = useCurrentCutId();
  const words = useWords();
  const on = cutId === undefined ? currentId : cutId;
  const groups = useMemo(() => groupPeers(on == null ? peers : peers.filter((p) => p.cutId === on)), [peers, on]);
  if (!groups.length) return null;
  const shown = groups.slice(0, max);
  const hidden = groups.length - shown.length;
  return h(
    "div",
    { className: cx("carton-presence", className), role: "group", "aria-label": words.hereNow(peers.length) },
    ...shown.map((g) =>
      h(
        "span",
        { key: g.root.actor.key, className: "carton-presence-group", "data-has-agents": g.agents.length ? "" : undefined },
        h(PeerAvatar, { peer: g.root, size: 24 }),
        ...g.agents.map((a) => h(PeerAvatar, { key: a.actor.key, peer: a, size: a.actor.kind === "subagent" ? 16 : 20 })),
      ),
    ),
    hidden > 0 ? h("span", { className: "carton-presence-more", "data-carton-tip": words.hereNow(peers.length) }, words.more_(hidden)) : null,
  );
}

export interface GhostLayerProps {
  /** Output seconds → x in px, relative to the layer. */
  timeToX: (t: number) => number;
  /** A track's vertical band in px, relative to the layer; null when the track is not shown. */
  trackBand: (trackId: string) => { top: number; height: number } | null;
  /** Change this when the timeline zooms or scrolls, so ghosts are placed again. */
  layoutKey?: unknown;
  className?: string;
}

/**
 * Ghosts of remote drags over the host's timeline. The host positions the layer over its tracks and maps time and
 * tracks to pixels. The layer is pointer-transparent, so it never steals the editor's clicks.
 */
export function GhostLayer(p: GhostLayerProps) {
  const ui = useCartonUi();
  const words = useWords();
  const ref = useRef<HTMLDivElement>(null);
  const map = useRef(p);
  map.current = p;
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const redraw = useRef(() => {});

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let frame = 0;
    const draw = () => {
      frame = 0;
      const ghosts = ui.ghosts();
      const seen = new Set<string>();
      for (const g of ghosts) {
        const key = `${g.actorKey}|${g.itemId}`;
        seen.add(key);
        let el = nodes.current.get(key);
        const actor: Actor | undefined = ui.actor(g.actorKey);
        if (!el) {
          el = document.createElement("div");
          el.className = "carton-ghost";
          const tag = document.createElement("span");
          tag.className = "carton-ghost-tag";
          el.appendChild(tag);
          root.appendChild(el);
          nodes.current.set(key, el);
        }
        place(el, g, actor);
      }
      for (const [key, el] of nodes.current)
        if (!seen.has(key)) {
          el.remove();
          nodes.current.delete(key);
        }
    };
    const place = (el: HTMLDivElement, g: Ghost, actor: Actor | undefined) => {
      const band = map.current.trackBand(g.trackId);
      if (!band) {
        el.style.display = "none";
        return;
      }
      const x0 = map.current.timeToX(g.start), x1 = map.current.timeToX(g.end);
      el.style.display = "";
      el.style.transform = `translate(${x0}px, ${band.top}px)`;
      el.style.width = `${Math.max(2, x1 - x0)}px`;
      el.style.height = `${band.height}px`;
      const name = actor ? actorLabel(actor, ui.actor.bind(ui), words.you) : "";
      const color = actor ? actorColor(actor, ui.actor.bind(ui)) : "#999";
      el.style.setProperty("--carton-actor", color);
      const tag = el.firstChild as HTMLSpanElement;
      const text = g.label ? `${name} · ${g.label}` : name;
      if (tag.textContent !== text) tag.textContent = text;
      el.setAttribute("aria-label", words.dragging(name));
    };
    // Coalesce: many ghost updates in one frame cost one layout pass.
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };
    redraw.current = schedule;
    schedule();
    const off = ui.subscribe("ghosts", schedule);
    return () => {
      off();
      redraw.current = () => {};
      if (frame) cancelAnimationFrame(frame);
      for (const el of nodes.current.values()) el.remove();
      nodes.current.clear();
    };
  }, [ui, words]);

  // Re-place every ghost after a zoom or scroll.
  useEffect(() => redraw.current(), [p.layoutKey]);

  return h("div", { ref, className: cx("carton-ghosts", p.className), "aria-hidden": true, style: { position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden" } });
}
