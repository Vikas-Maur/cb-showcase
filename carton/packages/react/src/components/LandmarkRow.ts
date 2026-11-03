// Landmarks in History (docs/carton-ux/v2 DESIGN-V2 §2.1, §2.2, §2.5, §2.6): the versions people remember, made
// automatically: Exported, Sent, Named, an agent's turn, the day's Start, and Before (a safety point just before a
// restore, a fold, an undo of a turn or a Bring back). A landmark row reads as one phrase, "EXPORTED 1080p for the
// client", with a picture where an ordinary row has its avatar.
//
// Cost: landmarks are read once (`ui.landmarks()`) and again only when topic "landmarks" says so; a row asks nothing.
// A picture is asked for the first time its row is drawn (the list is virtual, so only rows in view), one at a time,
// and kept here for the panel's life; until then, and when there is none, the landmark's own icon shows at once.

import { createElement as h, memo, useEffect, useState } from "react";
import { useCartonUi, useWords } from "../hooks.ts";
import { Icon, type IconName } from "../icons.ts";
import type { CartonUi, Landmark, LandmarkKind } from "../model.ts";
import type { Words } from "../words.ts";

/** The order a row shows its landmarks in, when it is more than one (DESIGN-V2 §2.1): Named, Sent, Exported, Before, Start, then a turn. */
const RANK: Record<LandmarkKind, number> = { named: 0, sent: 1, shared: 1, published: 1, exported: 2, safety: 3, session: 4, turn: 5 };
/** Each landmark's tag colour and its icon, the fallback tile's (DESIGN-V2 §2.1, §2.2). */
export const LANDMARK_TONE: Record<LandmarkKind, string> = { exported: "ok", sent: "info", shared: "info", published: "info", named: "warn", safety: "warn", session: "muted", turn: "muted" };
const LANDMARK_ICON: Record<LandmarkKind, IconName> = { exported: "exportUp", sent: "send", shared: "send", published: "send", named: "bookmarkFill", safety: "shield", session: "sun", turn: "sparkle" };

/** The landmarks by History row id, each row's best first; `ids`: every landmark's row (the Landmarks filter). */
export interface LandmarkIndex {
  readonly byVersion: ReadonlyMap<string, readonly Landmark[]>;
  readonly ids: ReadonlySet<string>;
  /** Newest first, as `landmarks()` answers. */
  readonly list: readonly Landmark[];
}

const EMPTY: LandmarkIndex = { byVersion: new Map(), ids: new Set(), list: [] };

/** Group landmarks by version, each version's best first (pure). */
export function indexLandmarks(list: readonly Landmark[]): LandmarkIndex {
  const byVersion = new Map<string, Landmark[]>();
  for (const l of list) {
    const xs = byVersion.get(l.versionId);
    if (xs) xs.push(l);
    else byVersion.set(l.versionId, [l]);
  }
  for (const xs of byVersion.values()) xs.sort((a, b) => RANK[a.kind] - RANK[b.kind]);
  return { byVersion, ids: new Set(byVersion.keys()), list };
}

/**
 * The current cut's landmarks (CartonUi.landmarks, Carton UX v2 N0), read on mount and again on topic "landmarks" or a
 * cut switch. A host without them has none: History looks as before.
 */
export function useLandmarks(cutId: string | undefined): LandmarkIndex {
  const ui = useCartonUi();
  const [index, setIndex] = useState<LandmarkIndex>(EMPTY);
  useEffect(() => {
    if (typeof ui.landmarks !== "function") return;
    let live = true, seq = 0;
    const read = () => {
      const mine = ++seq;
      ui.landmarks!().then(
        (list) => live && mine === seq && setIndex(list.length ? indexLandmarks(list) : EMPTY),
        () => {},
      );
    };
    read();
    const off = ui.subscribe("landmarks", read);
    return () => {
      live = false;
      off();
    };
  }, [ui, cutId]);
  return index;
}

/** A landmark's title, the words after its tag (DESIGN-V2 §2.1): "1080p for the client", "Shared with Leo", "Sent to client". */
export function landmarkTitle(l: Landmark, words: Words, fallback: string): string {
  switch (l.kind) {
    case "exported":
      return words.exportedTitle(l.label);
    case "sent":
    case "shared":
      return words.sharedWith(l.label);
    case "published":
      return l.label || words.publishedTitle;
    case "session":
      return words.sessionTitle;
    case "safety":
      return l.before ? words.safetyTitle[l.before] : (l.label ?? fallback);
    default:
      return l.label || fallback;
  }
}

/** The small capitals before a landmark's title ("EXPORTED"), in its own colour. A turn has none: its agent's mark says it. */
export function LandmarkTag({ kind }: { kind: LandmarkKind }) {
  const words = useWords();
  const text = words.landmarkTags[kind];
  return text ? h("span", { className: "carton-landmark-tag", "data-tone": LANDMARK_TONE[kind], "data-kind": kind }, text) : null;
}

// ------------------------------------------------------------------------------------------------- pictures

/** Pictures already read, by key (`Landmark.picture`): a data URL, or null for none. Kept for the page's life, at most 400. */
const pictures = new Map<string, string | null>();
const waiting = new Map<string, Array<(url: string | null) => void>>();
let busy = false;
const queue: Array<{ ui: CartonUi; key: string }> = [];

/** Read pictures one at a time (DESIGN-V2 §6: one at a time, never a burst when the list scrolls). */
function pump() {
  if (busy) return;
  const next = queue.shift();
  if (!next) return;
  busy = true;
  const done = (url: string | null) => {
    if (pictures.size >= 400) pictures.delete(pictures.keys().next().value!);
    pictures.set(next.key, url);
    for (const f of waiting.get(next.key) ?? []) f(url);
    waiting.delete(next.key);
    busy = false;
    pump();
  };
  next.ui.landmarkPicture!(next.key).then((u) => done(typeof u === "string" && u.startsWith("data:image/") ? u : null), () => done(null));
}
function askPicture(ui: CartonUi, key: string, f: (url: string | null) => void): () => void {
  const list = waiting.get(key);
  if (list) list.push(f);
  else {
    waiting.set(key, [f]);
    queue.push({ ui, key });
    pump();
  }
  return () => {
    const xs = waiting.get(key);
    if (!xs) return;
    const i = xs.indexOf(f);
    if (i >= 0) xs.splice(i, 1);
    // nobody waits for it any more (its row scrolled away): leave it unread
    if (!xs.length) {
      waiting.delete(key);
      const q = queue.findIndex((x) => x.key === key);
      if (q >= 0) queue.splice(q, 1);
    }
  };
}
/** Forget a picture (the host made a new one for the key). */
export function forgetPicture(key: string) {
  pictures.delete(key);
}
/** The tiles showing a key, told when its picture is made (`keepPicture`). */
const shown = new Map<string, Set<(url: string | null) => void>>();
function keepPicture(key: string, url: string) {
  if (pictures.size >= 400 && !pictures.has(key)) pictures.delete(pictures.keys().next().value!);
  pictures.set(key, url);
  for (const f of shown.get(key) ?? []) f(url);
}
/** Keys a picture was tried for in this page (made or not): each is tried once. */
const tried = new Set<string>();

/** How long the stage shows a version before its picture is taken (it has drawn by then). */
export const PICTURE_SETTLE_MS = 600;

/**
 * Pictures for landmarks (DESIGN-V2 §2.2), made in the page, never on the save path: when the stage shows a landmark's
 * version (held to peek, viewed, or your edit while it is that version) and it has none yet, the host's `capture`
 * (one small JPEG of what the stage shows) runs once, PICTURE_SETTLE_MS after it showed, and never while something
 * plays. Each version is tried once a page. A host without `capture`, or without `saveLandmarkPicture`, makes none.
 */
export function useStagePictures(o: { marks: LandmarkIndex; shownId: string | null; busy: boolean; capture?: (() => Promise<string | null>) | undefined }) {
  const ui = useCartonUi();
  const { marks, shownId, busy, capture } = o;
  const l = shownId ? marks.byVersion.get(shownId)?.find((x) => x.kind !== "turn") : undefined;
  const key = l?.picture ?? null;
  useEffect(() => {
    if (!key || busy || !capture || typeof ui.saveLandmarkPicture !== "function" || tried.has(key) || typeof pictures.get(key) === "string") return;
    let live = true;
    const t = setTimeout(() => {
      if (!live) return;
      tried.add(key);
      capture().then(
        (url) => {
          if (!url || !url.startsWith("data:image/jpeg")) return;
          return ui.saveLandmarkPicture!(key, url).then(() => keepPicture(key, url));
        },
        () => {},
      ).catch(() => {});
    }, PICTURE_SETTLE_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [ui, key, busy, capture]);
}
/** Tests: how many pictures were asked for, and a clean cache. */
export const __pictures = { clear: () => (pictures.clear(), waiting.clear(), tried.clear(), (queue.length = 0), (busy = false)), size: () => pictures.size };

/**
 * A landmark's picture (DESIGN-V2 §2.2): 44 × 25 px, the frame at its first change, rounded like Cardboard's media
 * tiles. Its icon on a dark tile shows at once, and stays when there is no picture (footage offline, a version still
 * arriving): never a spinner, never a black tile.
 */
export const LandmarkTile = memo(function LandmarkTile({ kind, picture }: { kind: LandmarkKind; picture: string }) {
  const ui = useCartonUi();
  const [url, setUrl] = useState<string | null>(() => pictures.get(picture) ?? null);
  useEffect(() => {
    // a picture made while it shows (useStagePictures) comes in at once
    let set = shown.get(picture);
    if (!set) shown.set(picture, (set = new Set()));
    set.add(setUrl);
    const off = () => {
      set!.delete(setUrl);
      if (!set!.size) shown.delete(picture);
    };
    if (typeof ui.landmarkPicture !== "function") return off;
    if (pictures.has(picture)) {
      setUrl(pictures.get(picture) ?? null);
      return off;
    }
    const stop = askPicture(ui, picture, setUrl);
    return () => (stop(), off());
  }, [ui, picture]);
  return h(
    "span",
    { className: "carton-landmark-tile", "data-kind": kind, "data-picture": url ? "" : undefined, "aria-hidden": true },
    url ? h("img", { src: url, alt: "", draggable: false, decoding: "async" }) : h(Icon, { name: LANDMARK_ICON[kind], size: 12 }),
  );
});
