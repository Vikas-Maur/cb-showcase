// The concurrent-edit mix of the card-rate check (port of core-v5 `mix.mjs`; definitions in cardrate.ts's header).
// Edits are plain JS on project.json-shaped docs. The prototype picked the mix with env MIX; here it is a parameter.
import * as E from "@carton/core";
import type { RemapMaps } from "@carton/core";
import { pick } from "./gen.ts";
import type { Rng } from "./gen.ts";
import type { HostDoc } from "./fixtures/cardboard-schema.ts";

type Item = Record<string, any>;

/** Where edits land: `win` seconds wide windows, `local` of edits inside the window. */
export interface Mix {
  name: "realistic" | "stress";
  win: number;
  local: number;
}
export const REALISTIC: Mix = { name: "realistic", win: 60, local: 0.7 };
/** The same edit kinds, both writers inside one 10 s window (a hot spot, not typical). */
export const STRESS: Mix = { name: "stress", win: 10, local: 1 };

/** Mutable per-run state: the window's start and a counter for new ids and texts. */
export interface MixState {
  win: number;
  k: number;
}
export type Chooser = (pred: (i: Item) => boolean) => Item | null;

export const r3 = (x: number): number => Math.round(x * 1000) / 1000;
export const W = (mix: Mix, r: Rng, base: HostDoc, n: MixState): Chooser => {
  const choose: Chooser = (pred) => {
    const all = (base.timelineItems as Item[]).filter(pred);
    if (!all.length) return null;
    const lo = n.win,
      hi = n.win + mix.win;
    const near = all.filter((i) => i.endTime > lo && i.startTime < hi);
    return r() < mix.local && near.length ? pick(r, near) : pick(r, all);
  };
  return choose;
};
export const roll = <K extends string>(r: Rng, table: readonly (readonly [K, number])[]): K => {
  let x = r(),
    acc = 0;
  for (const [k, p] of table) if ((acc += p) >= x) return k;
  return table.at(-1)![0];
};
export const HUMAN = [["tout", 0.2], ["move", 0.15], ["grade", 0.15], ["tin", 0.1], ["text", 0.1], ["volume", 0.08], ["slip", 0.05], ["fxAdd", 0.05], ["del", 0.04], ["add", 0.04], ["speed", 0.02], ["ripple", 0.02]] as const;
export const AGENT = [["caption", 0.25], ["title", 0.15], ["tout", 0.15], ["retime", 0.1], ["addTitle", 0.1], ["grade", 0.08], ["gap", 0.07], ["transform", 0.05], ["del", 0.03], ["fxOrder", 0.02]] as const;
export type EditKind = (typeof HUMAN)[number][0] | (typeof AGENT)[number][0];

export interface MixEdit {
  kind: EditKind;
  id: string;
  /** The recorded decomposition (a human's GUI edit records its kind). */
  rec?: E.TimeEdit;
  remap?: RemapMaps;
}

/** One edit on a host-shaped doc. */
export function editOnce(mix: Mix, r: Rng, d: HostDoc, kind: EditKind, choose: Chooser, who: string, n: MixState): MixEdit | null {
  const items = d.timelineItems as Item[];
  const byId = (id: string) => items.find((x) => x.id === id)!;
  const media = (p: (i: Item) => boolean) => choose((i) => p(i));
  const tracks = new Map((d.tracks as Item[]).map((t) => [t.name, t.id]));
  switch (kind) {
    case "tout":
    case "tin":
    case "move":
    case "slip":
    case "speed": {
      const it = media((i) => ["video", "audio", "text"].includes(i.type) && i.endTime - i.startTime > 1.2);
      if (!it) return null;
      const x = byId(it.id),
        v = x.playbackSpeed ?? 1;
      if (kind === "tout") {
        const dl = -r3(0.1 + r() * 0.8);
        x.endTime = r3(x.endTime + dl);
        x.trimEnd = r3(x.trimEnd + dl * v);
        return { kind, id: x.id, rec: { tout: dl } };
      }
      if (kind === "tin") {
        const dl = r3(0.1 + r() * 0.6);
        x.startTime = r3(x.startTime + dl);
        x.trimStart = r3(x.trimStart + dl * v);
        return { kind, id: x.id, rec: { tin: dl } };
      }
      if (kind === "move") {
        const dl = r3((r() - 0.5) * 4) || 0.5;
        if (x.startTime + dl < 0) return null;
        x.startTime = r3(x.startTime + dl);
        x.endTime = r3(x.endTime + dl);
        return { kind, id: x.id, rec: { move: dl } };
      }
      if (kind === "slip") {
        const dl = r3(0.2 + r() * 0.5);
        x.trimStart = r3(x.trimStart + dl);
        x.trimEnd = r3(x.trimEnd + dl);
        return { kind, id: x.id, rec: { slip: dl } };
      }
      const s2 = pick(r, [0.5, 1.5, 2]);
      x.playbackSpeed = s2;
      x.endTime = r3(x.startTime + (x.trimEnd - x.trimStart) / s2);
      return { kind, id: x.id, rec: { speed: s2 } };
    }
    case "retime": {
      const it = media((i) => i.type === "caption");
      if (!it) return null;
      const x = byId(it.id);
      const ds = r3((r() - 0.5) * 0.6),
        de = r3((r() - 0.5) * 0.6);
      if (x.endTime + de - (x.startTime + ds) < 0.3) return null;
      x.startTime = r3(x.startTime + ds);
      x.endTime = r3(x.endTime + de);
      x.trimEnd = r3(x.trimStart + (x.endTime - x.startTime));
      return { kind, id: x.id };
    }
    case "grade": {
      const it = media((i) => i.type === "video" || i.type === "adjustment");
      if (!it) return null;
      const x = byId(it.id);
      if (x.type === "adjustment") x.colorGrading = { ...x.colorGrading, exposure: r3(r() * 0.4 - 0.2) };
      else x.colorGrade = { ...(x.colorGrade ?? {}), saturation: r3(0.8 + r() * 0.5) };
      return { kind, id: x.id };
    }
    case "text":
    case "title": {
      const it = media((i) => i.type === "text");
      if (!it) return null;
      byId(it.id).textContent = `${who} ${n.k++}`;
      return { kind, id: it.id };
    }
    case "caption": {
      const it = media((i) => i.type === "caption" && i.captionSegments?.length);
      if (!it) return null;
      const x = byId(it.id);
      const s = pick(r, x.captionSegments as Item[]);
      x.captionSegments = (x.captionSegments as Item[]).map((g) => (g === s ? { ...g, text: `${g.text} (fixed ${n.k++})` } : g));
      return { kind, id: x.id };
    }
    case "volume": {
      const it = media((i) => i.type === "audio" || i.type === "video");
      if (!it) return null;
      byId(it.id).volume = r3(r());
      return { kind, id: it.id };
    }
    case "transform": {
      const it = media((i) => i.transform);
      if (!it) return null;
      const x = byId(it.id);
      x.transform = { ...x.transform, x: r3(r() * 200 - 100) };
      return { kind, id: x.id };
    }
    case "fxAdd": {
      const it = media((i) => i.type === "video");
      if (!it) return null;
      const x = byId(it.id);
      x.effects = [...(x.effects ?? []), { id: `fx-${who}-${n.k++}`, type: "glow", amount: 0.5 }];
      return { kind, id: x.id };
    }
    case "fxOrder": {
      const it = media((i) => i.effects?.length > 1);
      if (!it) return null;
      const x = byId(it.id);
      x.effects = [...x.effects].reverse();
      return { kind, id: x.id };
    }
    case "del": {
      const it = media((i) => i.type !== "audio");
      if (!it) return null;
      d.timelineItems = items.filter((x) => x.id !== it.id);
      return { kind, id: it.id };
    }
    case "add":
    case "addTitle": {
      const t = kind === "addTitle" ? tracks.get("Titles") : tracks.get("B-roll");
      const s = r3(n.win + r() * mix.win);
      d.timelineItems = [...items, { id: `${who}-new-${n.k++}`, trackId: t, type: kind === "addTitle" ? "text" : "video", startTime: s, endTime: r3(s + 2), trimStart: 0, trimEnd: 2, textContent: "New", name: "new" }];
      return { kind, id: (d.timelineItems as Item[]).at(-1)!.id };
    }
    case "ripple":
    case "gap": {
      // delete a clip on Main (human, recorded) or close the gap after a Voiceover clip (agent, unrecorded)
      const lane = kind === "ripple" ? tracks.get("Main") : tracks.get("Voiceover");
      const onLane = items.filter((i) => i.trackId === lane).sort((a, b) => a.startTime - b.startTime);
      const inWin = onLane.filter((i) => i.startTime >= n.win && i.startTime < n.win + mix.win);
      if (onLane.length < 3) return null;
      if (kind === "ripple") {
        const x = pick(r, inWin.length ? inWin : onLane);
        const len = r3(x.endTime - x.startTime);
        d.timelineItems = items.filter((i) => i.id !== x.id).map((i) => (i.trackId === lane && i.startTime >= x.endTime - 1e-9 ? { ...i, startTime: r3(i.startTime - len), endTime: r3(i.endTime - len) } : i));
        return { kind, id: x.id, remap: { [lane]: E.rippleDelete(x.startTime, len) } };
      }
      const k = onLane.findIndex((i, j) => j + 1 < onLane.length && onLane[j + 1]!.startTime - i.endTime > 0.5 && i.startTime >= n.win);
      if (k < 0) return null;
      const gap = r3(onLane[k + 1]!.startTime - onLane[k]!.endTime);
      d.timelineItems = items.map((i) => (i.trackId === lane && i.startTime >= onLane[k + 1]!.startTime - 1e-9 ? { ...i, startTime: r3(i.startTime - gap), endTime: r3(i.endTime - gap) } : i));
      return { kind, id: onLane[k + 1]!.id };
    }
  }
  return null;
}
