// A mock CartonUi with realistic, seeded data: a project with thousands of versions (agent turns, named versions,
// folds), several cuts, people with their agents and subagents, ghosts of drags, conflict cards, and a shot diff. The
// gallery, the tests and the benchmarks use it; a host can use it to try the components before its Carton is wired.
// `live()` drives it like a busy shared project (versions arriving, presence, ghosts at 20 Hz).
//
// Its newest versions are the redesign's story (docs/carton-ux, DESIGN §3 and the mockups): Main cut today, a 0:38
// edit, Claude Code's turn "Tighten the intro and add a lower third" on top (Now), your six changes before it, the
// Director's "Add captions to the interview", "Sent to client", a fold, a restore and a Codex trim. Every change is a
// structured row (`changes`, `changesIn`), in the sentences of DESIGN §8, at its place in the edit (0:00–0:38). Pass
// `now` at 12:48 pm to read the mockups' clock times.

import { TopicHub } from "./hub.ts";
import { cutColors } from "./cuts.ts";
import { clock, shortDate, versionLabel, versionShort } from "./format.ts";
import type {
  Actor,
  CartonUi,
  Change,
  ClipKind,
  ClipVersions,
  Comparison,
  Conflict,
  ConflictChoice,
  Credits,
  Cut,
  FilterStatus,
  FoldPlan,
  FoldResult,
  Ghost,
  HistoryFilter,
  HistorySource,
  Peer,
  Preview,
  Published,
  Shot,
  ShotDiff,
  SyncStatus,
  Topic,
  UndoTurn,
  Version,
  Viewing,
  ViewTarget,
  Working,
} from "./model.ts";
import { diffSummary } from "./shots.ts";

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const people = {
  alice: { key: "human/alice", kind: "human", name: "Alice Moreau", isYou: true } as Actor,
  bob: { key: "human/bob", kind: "human", name: "Bob Okafor" } as Actor,
  priya: { key: "human/priya", kind: "human", name: "Priya Shah" } as Actor,
  leo: { key: "human/leo", kind: "human", name: "Leo" } as Actor,
  mia: { key: "human/mia", kind: "human", name: "Mia" } as Actor,
  director: { key: "agent/director", kind: "agent", name: "Director", parent: "human/alice", isYou: true } as Actor,
  explore: { key: "agent/director/sub-explore-4f1a", kind: "subagent", name: "Director", subagentType: "Explore", parent: "agent/director", isYou: true } as Actor,
  captions: { key: "agent/director/sub-captions-9b2c", kind: "subagent", name: "Director", subagentType: "caption-fixer", parent: "agent/director", isYou: true } as Actor,
  terminal: { key: "agent/claude-code-terminal", kind: "agent", name: "Claude Code", parent: "human/alice", isYou: true, model: "Opus 5.5" } as Actor,
  codex: { key: "agent/codex-alice", kind: "agent", name: "Codex", parent: "human/alice", isYou: true } as Actor,
  bobsDirector: { key: "agent/director-bob", kind: "agent", name: "Director", parent: "human/bob" } as Actor,
  leosDirector: { key: "agent/director-leo", kind: "agent", name: "Director", parent: "human/leo" } as Actor,
};

/** The story's edit (the mockups' timeline, 0:38): every clip with its kind, place and id. */
export const TIMELINE: readonly { readonly id: string; readonly name: string; readonly clip: ClipKind; readonly at: number; readonly end: number }[] = [
  { id: "item-intro", name: "Intro", clip: "video", at: 0, end: 5 },
  { id: "item-summer", name: "Summer launch", clip: "title", at: 2, end: 7 },
  { id: "item-interview-a", name: "Interview A", clip: "video", at: 5, end: 12 },
  { id: "item-jane", name: "Jane Smith, Founder", clip: "title", at: 12, end: 17 },
  { id: "item-closeup", name: "Product close-up", clip: "video", at: 12, end: 18 },
  { id: "item-interview-b", name: "Interview B", clip: "video", at: 18, end: 27 },
  { id: "item-cap-1", name: "we cut editing time", clip: "caption", at: 24.5, end: 27 },
  { id: "item-cap-2", name: "in half", clip: "caption", at: 27.5, end: 29.5 },
  { id: "item-broll", name: "B-roll 3", clip: "video", at: 27, end: 31 },
  { id: "item-team", name: "Meet the team", clip: "title", at: 26, end: 31 },
  { id: "item-outro", name: "Outro", clip: "video", at: 31, end: 38 },
  { id: "item-music", name: "Upbeat.wav", clip: "audio", at: 0, end: 38 },
  { id: "item-logo", name: "Logo sting", clip: "image", at: 35, end: 38 },
  { id: "item-cta", name: "CTA", clip: "code", at: 33, end: 36 },
];
/** The edit's length in the story (seconds). */
export const STORY_LENGTH = 38;
const clipOf = (id: string) => TIMELINE.find((c) => c.id === id)!;

// Prompts an agent turn is labelled with, dealt in order so neighbouring turns never share a label.
const TURNS = [
  "Add captions to the interview",
  "Punch up the music at the drop",
  "Remove the silences",
  "Make a 30s version for Instagram",
  "Color match the b-roll",
  "Swap the logo sting for the new one",
  "Shorten the outro to 3 seconds",
  "Cut the ums from Priya's answer",
  "Open on the drone shot",
  "Add a lower third for Bob",
  "Duck the music under the voiceover",
  "Try a faster pace in the middle",
  "Fix the jump cut at 0:22",
  "Make the CTA land on the beat",
  "Balance the interview levels",
  "Add the product close-up before the CTA",
];
const NAMES = ["Rough cut", "Sent to client, Monday", "Before the color pass", "Approved by Priya", "Rough cut v2", "Fine cut", "Picture lock"];
const CAPTIONS = ["we cut editing time", "in half", "meet the team", "built for speed"];

const tc = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s) % 60).padStart(2, "0")}`;
const secs = (d: number) => `${Math.abs(d) < 10 && !Number.isInteger(d) ? Math.abs(d).toFixed(1) : Math.round(Math.abs(d))} s`;

/** One change, as core's describe() words it (DESIGN §8 "Change sentences"). */
function mk(c: Omit<Change, "key"> & { key?: string }): Change {
  return { key: c.key ?? (c.itemId ? `timelineItems/${c.itemId}` : c.text), ...c } as Change;
}
/** A random change in the story's edit: every sentence form, at its place in 0:00–0:38. */
function randomChange(r: () => number): Change {
  const clips = TIMELINE.filter((c) => c.clip !== "audio");
  const c = clips[Math.floor(r() * clips.length)]!;
  const base = { itemId: c.id, clip: c.clip } as const;
  switch (Math.floor(r() * 8)) {
    case 0: {
      const end = Math.max(c.at + 1, Math.round(c.end - 0.5 - r() * 2));
      return mk({ ...base, kind: "change", text: `Trimmed “${c.name}”, now ends at ${tc(end)}`, at: c.at, end });
    }
    case 1: {
      const start = Math.min(c.end - 1, Math.round(c.at + 0.5 + r() * 2));
      return mk({ ...base, kind: "change", text: `Trimmed “${c.name}”, now starts at ${tc(start)}`, at: start, end: c.end });
    }
    case 2: {
      const d = Math.round((r() - 0.5) * 6) || 1;
      const at = Math.max(0, c.at + d);
      return mk({ ...base, kind: "change", text: `Moved “${c.name}” ${secs(d)} ${d > 0 ? "later" : "earlier"} (now starts at ${tc(at)})`, at, end: at + (c.end - c.at) });
    }
    case 3: {
      const t = CAPTIONS[Math.floor(r() * CAPTIONS.length)]!;
      const at = Math.round(r() * 30);
      return mk({ key: `timelineItems/cap-${Math.floor(r() * 1e6)}`, itemId: undefined, clip: "caption", kind: "add", text: `Added caption “${t}”`, at, end: at + 2 });
    }
    case 4:
      return mk({ ...base, kind: "remove", text: `Removed “${c.name}”`, at: c.at, end: c.end });
    case 5:
      return c.clip === "title"
        ? mk({ ...base, kind: "change", text: `Made “${c.name}” bigger (font size 100 → ${120 + Math.floor(r() * 100)})`, at: c.at, end: c.end })
        : mk({ ...base, kind: "change", text: `Changed the saturation of “${c.name}” to ${(1 + r() * 0.5).toFixed(1)}`, at: c.at, end: c.end });
    case 6:
      return mk({ ...base, kind: "change", text: `Moved “${c.name}” to a new track`, at: c.at, end: c.end });
    default:
      return mk({ itemId: "item-music", clip: "audio", kind: "change", text: `Changed the volume of “Upbeat.wav” to ${Math.round(40 + r() * 60)}%`, at: 0, end: STORY_LENGTH, key: "timelineItems/item-music" });
  }
}

export interface MockOptions {
  /** How many versions History starts with (before the story's newest ones). */
  versions?: number;
  seed?: number;
  /** "Now" for the generated times (default: Date.now()). 12:48 pm gives the mockups' clock times. */
  now?: number;
  /** Two of your newest changes still on their way (offline, "Not sent yet"). Default: false. */
  provisional?: boolean;
}

/** A CartonUi plus the knobs a gallery, test or benchmark needs. */
export interface MockUi extends CartonUi {
  readonly hub: TopicHub<Topic>;
  /** Append a version (newest), as a commit or a sync would. Its changes default to one random change. */
  addVersion(v?: Partial<Version>, changes?: readonly Change[]): Version;
  /** Confirm the provisional versions (the server acked them). */
  confirmAll(): void;
  setSync(s: SyncStatus): void;
  setPeers(p: readonly Peer[]): void;
  setGhosts(g: readonly Ghost[]): void;
  setConflicts(c: readonly Conflict[]): void;
  setPublished(p: Published | null): void;
  setUndo(u: UndoTurn | null): void;
  /** An agent working (PLAN 0.7), or null: the Director's "Add music under the interview" by default. */
  setWorking(w: Working | null | "director"): void;
  /** Drive it like a busy shared project. Returns a stop function. */
  live(opts?: { versionsPerSecond?: number; ghostHz?: number; presenceHz?: number; burst?: number }): () => void;
  /** Make the shot diff bigger (benchmarks). */
  setShotCount(n: number): void;
  /** How many times `changes`/`changesIn` computed a list (tests: only an open card asks). */
  readonly counts: { changes: number; changesIn: number; clipVersions: number };
}

const MIN = 60_000;

export function createMockUi(opts: MockOptions = {}): MockUi {
  const r = rng(opts.seed ?? 7);
  const now0 = opts.now ?? Date.now();
  const hub = new TopicHub<Topic>();
  const actors = new Map<string, Actor>(Object.values(people).map((a) => [a.key, a]));
  const counts = { changes: 0, changesIn: 0, clipVersions: 0 };

  // ------------------------------------------------------------ history (oldest first; index 0 of a view = newest)
  const all: Version[] = [];
  const named: number[] = [];
  const turns: number[] = [];
  const mine: number[] = [];
  const pos = new Map<string, number>();
  // What each version did (its rows in the card), by id
  const did = new Map<string, readonly Change[]>();
  let revision = 0;
  let n = 0;
  let turnsDealt = 0;
  const authorsPool = [people.alice, people.alice, people.alice, people.director, people.explore, people.captions, people.bob, people.bob, people.terminal, people.priya, people.bobsDirector];

  const isMine = (v: Version) => v.author.kind === "human" && !!v.author.isYou;
  const isNamed = (v: Version) => !!v.name && v.kind !== "turn";
  const push = (v: Version, changes: readonly Change[]) => {
    const i = all.length;
    all.push(v);
    pos.set(v.id, i);
    did.set(v.id, changes);
    if (isNamed(v)) named.push(i);
    if (v.kind === "turn") turns.push(i);
    if (isMine(v)) mine.push(i);
    revision++;
  };

  const make = (at: number, over: Partial<Version> = {}, changes?: readonly Change[]): [Version, readonly Change[]] => {
    n++;
    const author = over.author ?? authorsPool[Math.floor(r() * authorsPool.length)]!;
    // a version given its own sentence is that edit; else agents' versions are mostly turns
    const isTurn = over.kind ? over.kind === "turn" : over.summary === undefined && ((author.kind === "agent" && r() < 0.8) || (author.kind === "subagent" && r() < 0.1));
    const kind = over.kind ?? (isTurn ? "turn" : over.summary !== undefined ? "edit" : r() < 0.02 ? "fold" : r() < 0.015 ? "restore" : "edit");
    const turnAuthor = isTurn && author.kind === "subagent" ? people.director : author;
    const list = changes ?? (kind === "turn" ? Array.from({ length: 2 + Math.floor(r() * 6) }, () => randomChange(r)) : [randomChange(r)]);
    const id = `rid0a1b2c3.${n}`;
    const prompt = kind === "turn" ? TURNS[turnsDealt++ % TURNS.length]! : undefined;
    const base: Version = {
      id,
      seq: n,
      ref: `main@${n}`,
      at,
      author: turnAuthor,
      kind,
      summary: kind === "fold" ? "Folded in “30s Instagram cut”" : kind === "restore" ? `Restored the ${clock(at - 40 * MIN, { now: now0 })} version` : list[list.length - 1]!.text,
      changes: list.length,
      base: `main@${n - 1}`,
      // (a generated turn carries its prompt as its label only: the story's turns are named, as the app names them)
      ...(prompt ? { turn: { label: prompt, edits: list.length } } : {}),
    };
    if (kind === "fold" && r() < 0.5) return [{ ...base, foldRest: true, leftOut: 1, ...over }, list];
    return [{ ...base, ...over }, list];
  };

  const total = opts.versions ?? 240;
  // The generated history ends where the story starts (80 min ago), from the project's start on: a short one stays
  // within today, a long one spans days
  let at = now0 - 80 * MIN - total * 95_000;
  if (total > 0) {
    push({ id: "rid0a1b2c3.0", seq: 0, ref: "main@0", at: at - 60_000, author: people.alice, kind: "edit", summary: "Project created", start: "created", changes: 0 }, []);
  }
  for (let i = 0; i < total; i++) {
    at += 20_000 + Math.floor(r() * 150_000);
    if (at > now0 - 80 * MIN) at = now0 - 80 * MIN - (total - i) * 1000;
    const [v, list] = make(at, i > 0 && i % 397 === 0 ? { name: NAMES[(i / 397) % NAMES.length] } : {});
    push(v, list);
  }

  // ------------------------------------------------------------ the story: Main cut today, newest last
  const story: [number, Partial<Version>, Change[]][] = [];
  if (total >= 4) {
    const t = (min: number) => now0 - min * MIN;
    const intro = clipOf("item-intro"), ib = clipOf("item-interview-b"), close = clipOf("item-closeup");
    story.push(
      [t(77), { author: people.codex, kind: "edit" }, [mk({ itemId: close.id, clip: "video", kind: "change", text: "Trimmed “Product close-up”, now ends at 0:16", at: close.at, end: 16 })]],
      [t(68), { author: people.alice, kind: "restore", summary: `Restored the ${clock(t(106), { now: now0 })} version` }, [
        mk({ itemId: intro.id, clip: "video", kind: "change", text: "Trimmed “Intro”, now ends at 0:06", at: 0, end: 6 }),
        mk({ itemId: "item-summer", clip: "title", kind: "change", text: "Changed “Summer sale” to “Summer launch”", at: 2, end: 7 }),
        mk({ itemId: "item-interview-a", clip: "video", kind: "change", text: "Moved “Interview A” 1 s earlier (now starts at 0:05)", at: 5, end: 12 }),
        mk({ itemId: "item-team", clip: "title", kind: "add", text: "Added title “Meet the team”", at: 26, end: 31 }),
        mk({ itemId: "item-outro", clip: "video", kind: "change", text: "Trimmed “Outro”, now ends at 0:38", at: 31, end: 38 }),
      ]],
      [t(56), { author: people.alice, kind: "fold", summary: "Folded in “30s cut”", leftOut: 1 }, [
        mk({ itemId: "item-broll", clip: "video", kind: "change", text: "Trimmed “B-roll 3”, now ends at 0:31", at: 27, end: 31 }),
        mk({ itemId: "item-cta", clip: "code", kind: "change", text: "Moved “CTA” 1 s earlier (now starts at 0:33)", at: 33, end: 36 }),
      ]],
      [t(43), { author: people.alice, kind: "edit", name: "Sent to client", published: true }, [mk({ itemId: "item-summer", clip: "title", kind: "change", text: "Changed “Summer sale” to “Summer launch”", at: 2, end: 7 })]],
      [t(28), { author: people.director, kind: "turn", name: "Add captions to the interview" }, [
        mk({ itemId: ib.id, clip: "video", kind: "change", text: "Moved “Interview B” 2 s later (now starts at 0:06)", at: 6, end: 15 }),
        mk({ itemId: "item-cap-1", clip: "caption", kind: "change", text: "Changed caption to “we cut editing time”", at: 25, end: 27 }),
        mk({ itemId: "item-cap-2", clip: "caption", kind: "change", text: "Changed caption to “in half”", at: 28, end: 29.5 }),
        ...["meet the team", "built for speed", "one timeline", "every agent", "no lost work", "fold it in", "ship it", "made in Cardboard", "thanks for watching"].map((c, i) =>
          mk({ key: `timelineItems/item-cap-add-${i}`, itemId: `item-cap-add-${i}`, clip: "caption", kind: "add", text: `Added caption “${c}”`, at: 6 + i * 3, end: 8 + i * 3 }),
        ),
      ]],
      // your six changes, 12:30–12:41 pm: one group row ("You · 6 changes")
      [t(18), { author: people.alice }, [mk({ key: "frameRate", clip: "project", kind: "change", text: "Changed the frame rate to 30 fps" })]],
      [t(15), { author: people.alice }, [mk({ itemId: "item-cap-1", clip: "caption", kind: "change", text: "Changed caption to “we cut editing time”", at: 25, end: 27 })]],
      [t(13), { author: people.alice }, [mk({ itemId: ib.id, clip: "video", kind: "change", text: "Moved “Interview B” 1 s later (now starts at 0:05)", at: 5, end: 14 })]],
      [t(11), { author: people.alice }, [mk({ itemId: "item-cap-1", clip: "caption", kind: "change", text: "Made “we cut editing time” bigger (font size 48 → 56)", at: 25, end: 27 })]],
      [t(9), { author: people.alice }, [mk({ itemId: ib.id, clip: "video", kind: "change", text: "Trimmed “Interview B”, now ends at 0:15", at: 5, end: 15 })]],
      [t(7), { author: people.alice }, [mk({ itemId: ib.id, clip: "video", kind: "change", text: "Moved “Interview B” 2 s later (now starts at 0:06)", at: 6, end: 15 })]],
      // Claude Code's turn, the newest: "Now"
      [t(0.5), { author: people.terminal, kind: "turn", name: "Tighten the intro and add a lower third" }, [
        mk({ itemId: intro.id, clip: "video", kind: "change", text: "Trimmed “Intro”, now ends at 0:05", at: 2, end: 5 }),
        mk({ itemId: "item-summer", clip: "title", kind: "change", text: "Moved “Summer launch” 1 s earlier (now starts at 0:05)", at: 5, end: 10 }),
        mk({ itemId: "item-jane", clip: "title", kind: "add", text: "Added lower third “Jane Smith, Founder”", at: 12, end: 17 }),
        mk({ itemId: "item-broll", clip: "video", kind: "remove", text: "Removed “B-roll 3”", at: 22, end: 26 }),
      ]],
    );
    for (const [when, over, list] of story) {
      const [v0] = make(when, over, list);
      const v = v0.kind === "turn" && over.name ? { ...v0, turn: { label: over.name, edits: list.length } } : v0;
      push(v, list);
    }
    if (opts.provisional) {
      const [p1, l1] = make(now0 - 20_000, { author: people.alice, kind: "edit", provisional: true, seq: null, ref: "main@pending-1" }, [mk({ itemId: "item-outro", clip: "video", kind: "change", text: "Trimmed “Outro”, now ends at 0:36", at: 31, end: 36 })]);
      push(p1, l1);
      const [p2, l2] = make(now0 - 5_000, { author: people.alice, kind: "edit", provisional: true, seq: null, ref: "main@pending-2" }, [mk({ itemId: "item-interview-a", clip: "video", kind: "change", text: "Trimmed “Interview A”, now ends at 0:11", at: 5, end: 11 })]);
      push(p2, l2);
    }
  }

  // The "Only “clip”" filter: the versions whose changes touch the clip (the per-version index), newest first
  const itemViews = new Map<string, { rev: number; ids: number[] }>();
  const itemView = (item: string): number[] => {
    let v = itemViews.get(item);
    if (!v || v.rev !== revision) {
      const ids: number[] = [];
      for (let i = 0; i < all.length; i++) if (did.get(all[i]!.id)?.some((c) => c.itemId === item)) ids.push(i);
      itemViews.set(item, (v = { rev: revision, ids }));
    }
    return v.ids;
  };
  const viewOf = (f: HistoryFilter): number[] | null => (typeof f === "object" ? itemView(f.item) : f === "named" ? named : f === "turns" ? turns : f === "mine" ? mine : null);
  const history: HistorySource = {
    all: () => all,
    slice: (from) => all.slice(Math.max(0, from)),
    revision: () => revision,
    count: (f) => (f === "all" ? all.length : viewOf(f)!.length),
    at: (f, i) => {
      const view = viewOf(f);
      const len = view ? view.length : all.length;
      if (i < 0 || i >= len) return undefined;
      return all[view ? view[len - 1 - i]! : len - 1 - i];
    },
    indexOf: (f, id) => {
      const p = pos.get(id);
      if (p == null) return -1;
      const view = viewOf(f);
      if (!view) return all.length - 1 - p;
      // The views are ascending, so a binary search finds it.
      let lo = 0, hi = view.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (view[mid] === p) return view.length - 1 - mid;
        if (view[mid]! < p) lo = mid + 1;
        else hi = mid - 1;
      }
      return -1;
    },
    status: (): FilterStatus => ({ loading: false }),
  };

  // ------------------------------------------------------------ the rest of the state
  const headOf = () => {
    for (let i = all.length - 1; i >= 0; i--) if (!all[i]!.provisional) return all[i]!.ref;
    return "main@0";
  };
  // Who changed each cut last and its colour dot (the cuts menu, PLAN 6.1): Main cut has none, a teammate's cut its owner's
  const colored = (list: Cut[]): readonly Cut[] => {
    const colors = cutColors(list, (id) => list.find((c) => c.id === id)?.owner);
    return list.map((c) => (colors.has(c.id) ? { ...c, color: colors.get(c.id)! } : c));
  };
  let cuts: readonly Cut[] = colored([
    { id: "cut-main", name: "Main cut", label: "Main cut", current: true, readOnly: false, kind: "main", owner: people.alice, head: headOf(), updatedAt: now0 - 30_000, updatedBy: people.alice, shared: true },
    { id: "cut-ig", name: "30s Instagram cut", label: "30s Instagram cut", current: false, readOnly: false, kind: "cut", owner: people.alice, head: "ig@41", updatedAt: now0 - 130 * MIN, updatedBy: people.director },
    { id: "cut-dir", name: "Director's cut: punchier open", label: "Director's cut: punchier open", current: false, readOnly: false, kind: "director", owner: people.director, head: "dir@12", updatedAt: now0 - 900_000, updatedBy: people.director },
    { id: "cut-offline", name: `Offline edits (${shortDate(now0 - 86_400_000)})`, label: `Offline edits (${shortDate(now0 - 86_400_000)})`, current: false, readOnly: false, kind: "offline", owner: people.alice, head: "off@9", updatedAt: now0 - 86_400_000, updatedBy: people.alice },
    { id: "cut-bob-main", name: "Main cut", label: "Bob's Main cut", current: false, readOnly: true, kind: "main", owner: people.bob, head: "bobmain@88", updatedAt: now0 - 7_200_000, updatedBy: people.bob },
  ]);
  let sync: SyncStatus = { kind: "syncing", waiting: 2 };
  let peers: readonly Peer[] = [
    { actor: people.alice, cutId: "cut-main", idle: false, activity: "Editing" },
    { actor: people.director, cutId: "cut-main", idle: false, activity: "Working on “tighter intro”" },
    { actor: people.explore, cutId: "cut-main", idle: false, activity: "Looking at the b-roll" },
    { actor: people.bob, cutId: "cut-main", idle: false, activity: "Editing captions" },
    { actor: people.bobsDirector, cutId: "cut-main", idle: false, activity: "Adding captions" },
    { actor: people.priya, cutId: "cut-main", idle: true },
  ];
  let ghosts: readonly Ghost[] = [
    { actorKey: people.bob.key, itemId: "item-broll", trackId: "V1", start: 12.5, end: 16.5, label: "B-roll city" },
    { actorKey: people.bobsDirector.key, itemId: "item-cap", trackId: "Captions", start: 19, end: 22.5, label: "built for speed" },
  ];
  let conflicts: readonly Conflict[] = [
    {
      id: "items/intro/#time",
      title: "'Intro' timing",
      mine: { author: people.alice, summary: "Trimmed the end to 0:05.0", at: now0 - 40_000, what: "trim" },
      theirs: { author: people.director, summary: "Moved it to start at 0:02.0 and end at 0:08.0", at: now0 - 70_000, what: "move" },
      canKeepBoth: false,
      reason: "Both changed when this clip plays. Doing both would end it before it starts.",
      provisional: "theirs",
      item: "item-intro",
      clip: "Intro",
    },
    {
      id: "items/title-1/textContent",
      title: "Title text",
      mine: { author: people.alice, summary: "\"Summer sale\"", at: now0 - 300_000, what: "change" },
      theirs: { author: people.bob, summary: "\"Summer launch\"", at: now0 - 240_000, what: "change" },
      canKeepBoth: true,
      provisional: "theirs",
      item: "item-summer",
      clip: "Summer launch",
    },
  ];
  let undo: UndoTurn | null = { id: "rid0a1b2c3.turn", author: people.director, label: "tighter intro", at: now0 - 70_000, edits: 12 };
  let published: Published | null = { cutId: "cut-main", cutName: "Main cut", ref: "main@" + Math.max(1, total - 3), versionName: "Sent to client, Monday", at: now0 - 6 * 60_000, newerEdits: 3, url: "https://cardboard.ai/s/demo" };
  let viewing: Viewing | null = null;
  let preview: Preview | null = null;
  const WORKING: Working = { actor: people.director, label: "Add music under the interview", edits: 2, since: now0 - 90_000, cutId: "cut-main" };
  let working: Working | null = null;
  let shotCount = 26;

  const set = <T>(topic: Topic, apply: () => T) => {
    const v = apply();
    hub.notify(topic);
    return v;
  };

  const addVersion = (over: Partial<Version> = {}, changes?: readonly Change[]) => {
    const [v, list] = make(Date.now(), over, changes);
    push(v, list);
    hub.notify("history");
    const cur = cuts.find((c) => c.current);
    if (cur && !over.provisional) {
      cuts = cuts.map((c) => (c === cur ? { ...c, head: v.ref, updatedAt: v.at, updatedBy: v.author } : c));
      hub.notify("cuts");
    }
    if (published && cur && published.cutId === cur.id) {
      published = { ...published, newerEdits: published.newerEdits + 1 };
      hub.notify("published");
    }
    if (working && v.author.key === working.actor.key) set("working", () => (working = { ...working!, edits: working!.edits + 1 }));
    return v;
  };

  /** The index in `all` of a ref; -1 when it isn't a version here. */
  const indexOfRef = (ref: string) => {
    for (let i = all.length - 1; i >= 0; i--) if (all[i]!.ref === ref) return i;
    return -1;
  };
  // Changes from a to b: what the versions after a up to b did, the newest change per clip, in timeline order
  const changeCache = new Map<string, readonly Change[]>();
  const between = (a: string, b: string): readonly Change[] => {
    const key = `${a}|${b}`;
    const hit = changeCache.get(key);
    if (hit) return hit;
    counts.changes++;
    const ia = indexOfRef(a), ib = indexOfRef(b);
    const lo = Math.min(ia, ib), hi = Math.max(ia, ib);
    const byKey = new Map<string, Change>();
    if (ia !== ib && lo >= -1 && hi >= 0)
      for (let i = lo + 1; i <= hi; i++) {
        const v = all[i]!;
        for (const c of did.get(v.id) ?? []) byKey.set(c.key, { ...c, author: v.author, when: v.at });
      }
    const out = [...byKey.values()].sort((x, y) => (x.at ?? Infinity) - (y.at ?? Infinity));
    changeCache.set(key, out);
    if (changeCache.size > 16) changeCache.delete(changeCache.keys().next().value!);
    return out;
  };
  const labelCtx = { now: now0, actor: (k: string) => actors.get(k) };
  const versionOf = (target: { versionId?: string; ref?: string }) => {
    const i = target.versionId !== undefined ? pos.get(target.versionId) : target.ref !== undefined ? indexOfRef(target.ref) : -1;
    return i === undefined || i < 0 ? undefined : all[i];
  };
  const setViewing = (v: Viewing | null) => {
    viewing = v;
    preview = v ? { ref: v.ref, label: v.label, ...(v.blockedEdit ? { blockedEdit: true } : {}) } : null;
    hub.notify("viewing");
    hub.notify("preview");
  };

  const ui: MockUi = {
    hub,
    counts,
    subscribe: (topic, fn) => hub.subscribe(topic, fn),
    sync: () => sync,
    cuts: () => cuts,
    history: () => history,
    peers: () => peers,
    ghosts: () => ghosts,
    conflicts: () => conflicts,
    undoTurn: () => undo,
    published: () => published,
    preview: () => preview,
    viewing: () => viewing,
    working: () => working,
    me: () => people.alice,
    actor: (key) => actors.get(key),

    async compare(a, b) {
      const d = await ui.shotDiff(a, b);
      const side = (ref: string, shots: readonly Shot[], label: string) => {
        const v = all.find((x) => x.ref === ref);
        return { label: v?.name ?? label, ref, at: v?.at ?? Date.now(), author: v?.author ?? people.alice, clipCount: shots.length + 6, length: shots.length ? shots[shots.length - 1]!.end : 0 };
      };
      const list = between(a, b);
      const c: Comparison = { a: side(a, d.a, d.aLabel), b: side(b, d.b, d.bLabel), diff: diffSummary(d), changes: list.map((x) => x.text), changeCount: list.length };
      return c;
    },

    async changes(a, b) {
      return between(a, b);
    },
    async changesIn(versionId) {
      counts.changesIn++;
      const i = pos.get(versionId);
      if (i === undefined) return [];
      const v = all[i]!;
      return [...(did.get(versionId) ?? [])].map((c) => ({ ...c, author: v.author, when: v.at })).sort((x, y) => (x.at ?? Infinity) - (y.at ?? Infinity));
    },
    async clipVersions(itemId): Promise<ClipVersions> {
      counts.clipVersions++;
      return { ids: itemView(itemId).map((i) => all[i]!.id).reverse() };
    },

    async credits(itemId) {
      const clip = TIMELINE.find((c) => c.id === itemId);
      const c: Credits = {
        clip: clip?.name ?? (itemId === "item-broll" ? "B-roll city" : "Intro"),
        lines: [
          { what: "Timing", author: people.explore, at: now0 - 4 * 60_000 },
          { what: "Text", author: people.captions, at: now0 - 25 * 60_000 },
          { what: "Color", author: people.alice, at: now0 - 26 * 3_600_000 },
          { what: "Added", author: people.bob, at: now0 - 3 * 86_400_000 },
        ],
      };
      return c;
    },

    async shotDiff(a, b) {
      return makeShotDiff(shotCount, opts.seed ?? 7, a === b);
    },

    async planFold(fromId, intoId) {
      const from = cuts.find((c) => c.id === fromId)!, into = cuts.find((c) => c.id === intoId)!;
      // The mockups' fold (after/fold-*.png): every change as a change row, the aspect ratio locked, one conflict
      const row = (id: string, summary: string, author: Actor, ago: number, change: Omit<Change, "key" | "text">, more: Partial<FoldPlan["changes"][number]> = {}) => ({
        id,
        summary,
        author,
        at: now0 - ago,
        change: { key: id, text: summary, ...change },
        ...more,
      });
      const p: FoldPlan = {
        from,
        into,
        // 30s Instagram cut was made from Main cut (and the other cuts from Main too), 2 h 28 min ago
        ...(from.kind === "main" || into.kind === "main" ? { made: { which: from.kind === "main" ? ("into" as const) : ("from" as const), at: now0 - 148 * MIN } } : {}),
        changes: [
          row("items/intro", "Trimmed “Intro”, now ends at 0:03", people.director, 130 * MIN, { kind: "change", clip: "video", itemId: "item-intro", at: 0, end: 3 }),
          row("items/summer", "Changed “Summer launch” to “Summer sale”", people.alice, 70 * MIN, { kind: "change", clip: "title", itemId: "item-summer", at: 3, end: 7 }),
          row("items/closeup", "Removed “Product close-up”", people.director, 65 * MIN, { kind: "remove", clip: "video", itemId: "item-closeup", at: 12, end: 16 }),
          row("aspectRatio", "Changed the aspect ratio to 9:16", people.director, 131 * MIN, { kind: "change", clip: "project" }, { locked: true }),
        ],
        // In a fold, each side says which cut it is on: yours is the cut you fold into.
        conflicts: [
          {
            id: "timelineItems/item-interview-b/#time",
            title: "'Interview B' timing",
            clip: "Interview B",
            item: "item-interview-b",
            mine: { author: people.alice, summary: "starts at 0:18", at: now0 - 13 * MIN, what: "move", where: into.label },
            theirs: { author: people.director, summary: "starts at 0:20", at: now0 - 70 * MIN, what: "move", where: from.label },
            canKeepBoth: false,
            provisional: "mine",
          },
        ],
        warnings: ["“B-roll 3” overlaps “Interview A” by 0.4 s", "The font “Denton” isn't on this computer, so the title may look different"],
      };
      return p;
    },

    async switchCut(id, o) {
      if (o?.onlyFrom !== undefined && cuts.find((c) => c.current)?.id !== o.onlyFrom) return;
      cuts = cuts.map((c) => (c.current !== (c.id === id) ? { ...c, current: c.id === id } : c));
      hub.notify("cuts");
    },
    async newCut(name, fromRef) {
      const made: Cut = { id: `cut-${cuts.length + 1}`, name, label: name, current: true, readOnly: false, kind: "cut", owner: people.alice, head: fromRef, updatedAt: Date.now(), updatedBy: people.alice };
      cuts = colored([...cuts.map((x) => (x.current ? { ...x, current: false } : x)), made]);
      const c = cuts[cuts.length - 1]!;
      hub.notify("cuts");
      return c;
    },
    async renameCut(id, name) {
      cuts = cuts.map((c) => (c.id === id ? { ...c, name, label: name } : c));
      hub.notify("cuts");
    },
    async fold(fromId, intoId, o): Promise<FoldResult> {
      const from = cuts.find((c) => c.id === fromId);
      const left = o.leaveOut.length;
      addVersion({ author: people.alice, kind: "fold", summary: `Folded in “${from?.label}”`, ...(left ? { leftOut: left, foldRest: true } : {}) });
      if (conflicts.length) set("conflicts", () => (conflicts = conflicts.filter((c) => !(c.id in o.choices))));
      return { ok: true };
    },
    async resolve(id, _choice: ConflictChoice) {
      set("conflicts", () => (conflicts = conflicts.filter((c) => c.id !== id)));
    },
    async foldRest(versionId) {
      const p = pos.get(versionId);
      if (p == null || !all[p]!.foldRest) return { ok: false, error: "Nothing left to fold in" };
      const { foldRest: _f, ...v } = all[p]!;
      all[p] = v;
      revision++;
      addVersion({ author: people.alice, kind: "fold", summary: "Folded in the rest of “30s Instagram cut”" });
      return { ok: true };
    },
    async restore(ref) {
      const v = all.find((x) => x.ref === ref);
      addVersion({ author: people.alice, kind: "restore", summary: v?.name ? `Restored “${v.name}”` : `Restored the ${clock(v?.at ?? Date.now(), { now: Date.now() })} version` });
    },
    async nameVersion(id, name) {
      const p = pos.get(id);
      if (p == null) return;
      const v = { ...all[p]!, name };
      all[p] = v;
      if (isNamed(v) && !named.includes(p)) {
        named.push(p);
        named.sort((x, y) => x - y);
      }
      revision++;
      hub.notify("history");
    },
    async undo(id) {
      if (!undo || undo.id !== id) return { ok: false, error: "Nothing to undo" };
      addVersion({ author: people.alice, kind: "undo", summary: `Undid Director's “${undo.label}”` });
      set("undo", () => (undo = null));
      return { ok: true };
    },
    async undoTurnOf(versionId) {
      const p = pos.get(versionId);
      const v = p === undefined ? undefined : all[p];
      if (!v || v.kind !== "turn") return { ok: false, error: "That isn't an agent turn" };
      const n = did.get(versionId)?.length ?? 0;
      addVersion({ author: people.alice, kind: "undo", summary: `Took out ${versionLabel(v, labelCtx)}`, changes: n }, [...(did.get(versionId) ?? [])]);
      return { ok: true };
    },
    async publish(cutId) {
      const c = cuts.find((x) => x.id === cutId);
      set("published", () => (published = { cutId, cutName: c?.label ?? "Main cut", ref: headOf(), at: Date.now(), newerEdits: 0, url: published?.url }));
    },
    openPreview(ref, label) {
      // the deprecated path: its caller's label, as before
      if (!ref) return setViewing(null);
      const v = versionOf({ ref });
      setViewing({ ref, kind: "version", ...(v ? { versionId: v.id } : {}), label: label ?? (v ? versionLabel(v, { ...labelCtx, start: true }) : ref), short: v ? versionShort(v, labelCtx) : (label ?? ref) });
    },
    async view(target: ViewTarget | null) {
      if (!target) return setViewing(null);
      if (target.kind === "cut") {
        const c = cuts.find((x) => x.id === target.cutId);
        if (!c) throw new Error("Couldn't load this version. Try again.");
        const owner = c.owner && !c.owner.isYou ? c.owner.name.split(" ")[0] : undefined;
        return setViewing({ ref: c.head, kind: "cut", cutId: c.id, label: owner ? `${owner}'s ${c.name}` : c.label, short: c.label });
      }
      if (target.kind === "conflict") {
        const c = conflicts.find((x) => x.id === target.conflictId);
        if (!c) throw new Error("Couldn't load this version. Try again.");
        const side = target.side === "mine" ? c.mine : c.theirs;
        const clip = c.clip ?? c.title;
        const label = target.side === "mine" ? `Your ${side.what ?? "change"} of “${clip}”` : `${side.author.name}'s ${side.what ?? "change"} of “${clip}”`;
        return setViewing({ ref: `see:${c.id}:${target.side}`, kind: "conflict", conflictId: c.id, side: target.side, label, short: label });
      }
      const v = versionOf(target);
      if (target.kind === "before") {
        const ref = target.ref ?? (v ? (v.base ?? v.ref) : undefined);
        if (!ref) throw new Error("Couldn't load this version. Try again.");
        const of = v ? versionLabel(v, labelCtx) : (target.label ?? "this version");
        return setViewing({ ref, kind: "before", ...(v ? { versionId: v.id } : {}), label: `Before ${of}`, short: v ? `Before · ${versionShort(v, labelCtx)}` : `Before ${of}` });
      }
      if (v?.provisional) throw new Error("Available once it's sent");
      const ref = v?.ref ?? target.ref;
      if (!ref) throw new Error("Couldn't load this version. Try again.");
      return setViewing({ ref, kind: "version", ...(v ? { versionId: v.id } : {}), label: v ? versionLabel(v, { ...labelCtx, start: true }) : (target.label ?? ref), short: v ? versionShort(v, labelCtx) : (target.label ?? ref) });
    },

    addVersion,
    confirmAll() {
      for (let i = all.length - 1; i >= 0 && all[i]!.provisional; i--) {
        const v = all[i]!;
        const seq = (all[i - 1]?.seq ?? i) + 1;
        all[i] = { ...v, provisional: undefined, seq, ref: `main@${seq}` };
      }
      revision++;
      hub.notify("history");
    },
    setSync: (s) => set("sync", () => (sync = s)),
    setPeers: (p) => set("peers", () => (peers = p)),
    setGhosts: (g) => set("ghosts", () => (ghosts = g)),
    setConflicts: (c) => set("conflicts", () => (conflicts = c)),
    setPublished: (p) => set("published", () => (published = p)),
    setUndo: (u) => set("undo", () => (undo = u)),
    setWorking: (w) => set("working", () => (working = w === "director" ? WORKING : w)),
    blockEdit: () => viewing && !viewing.blockedEdit && setViewing({ ...viewing, blockedEdit: true }),
    setShotCount: (k) => (shotCount = k),

    live(o = {}) {
      const timers: ReturnType<typeof setInterval>[] = [];
      const vps = o.versionsPerSecond ?? 2;
      const burst = o.burst ?? 1;
      if (vps > 0)
        timers.push(
          setInterval(() => {
            for (let k = 0; k < burst; k++) addVersion({ author: r() < 0.5 ? people.bob : people.bobsDirector, kind: "edit" });
            // Status words change only when the state does: a busy project stays "Up to date".
            if (sync.kind !== "upToDate") ui.setSync({ kind: "upToDate" });
          }, 1000 / vps),
        );
      const gh = o.ghostHz ?? 20;
      if (gh > 0) {
        const t0 = Date.now();
        timers.push(
          setInterval(() => {
            const t = (Date.now() - t0) / 1000;
            const x = 10 + 6 * Math.sin(t * 1.3);
            ui.setGhosts([
              { actorKey: people.bob.key, itemId: "item-broll", trackId: "V1", start: x, end: x + 4, label: "B-roll city" },
              { actorKey: people.bobsDirector.key, itemId: "item-cap", trackId: "Captions", start: 20 + 3 * Math.cos(t), end: 22 + 3 * Math.cos(t), label: "built for speed" },
            ]);
          }, 1000 / gh),
        );
      }
      const ph = o.presenceHz ?? 1;
      if (ph > 0) {
        let k = 0;
        timers.push(
          setInterval(() => {
            k++;
            ui.setPeers(peers.map((p) => (p.actor.key === people.priya.key ? { ...p, idle: k % 2 === 0 } : p)));
          }, 1000 / ph),
        );
      }
      return () => timers.forEach(clearInterval);
    },
  };
  return ui;
}

function defaultCard(now0: number): Conflict {
  return {
    id: "items/intro/#time",
    title: "'Intro' timing",
    mine: { author: people.alice, summary: "Trimmed the end to 0:05.0", at: now0 - 40_000, what: "trim" },
    theirs: { author: people.director, summary: "Moved it to start at 0:02.0", at: now0 - 70_000, what: "move" },
    canKeepBoth: false,
    item: "item-intro",
    clip: "Intro",
  };
}

const SHOT_NAMES = ["Intro", "Interview A", "B-roll city", "Product close-up", "Interview B", "Drone shot", "Team at work", "Logo sting", "CTA", "Outro", "Street crowd", "Hands typing"];
/**
 * A shot diff with every kind of change: a trim, a removal, an insertion of two shots, a replacement, and long
 * unchanged runs. Matches are built with the shots, as core's lcs() would return them for these signatures.
 */
export function makeShotDiff(count = 26, seed = 7, same = false): ShotDiff {
  const r = rng(seed * 31 + count);
  const a: Shot[] = [];
  let t = 0;
  for (let i = 0; i < count; i++) {
    const d = Math.round((1.5 + r() * 3) * 10) / 10;
    a.push({ start: t, end: t + d, sig: 1000 + i, label: SHOT_NAMES[i % SHOT_NAMES.length] });
    t += d;
  }
  if (same) return { a, b: a.slice(), matches: a.map((_, i) => [i, i] as const), aLabel: "Before", bLabel: "After" };
  // Edits at fixed proportions of the edit, so every size has the same shape.
  const trim = Math.floor(count * 0.12), drop = Math.floor(count * 0.3), ins = Math.floor(count * 0.5), repl = Math.floor(count * 0.72);
  const b: Shot[] = [];
  const matches: [number, number][] = [];
  t = 0;
  let extra = 0;
  for (let i = 0; i < count; i++) {
    const s = a[i]!;
    const d = s.end - s.start;
    if (i === drop) continue;
    if (i === trim) {
      b.push({ start: t, end: t + d - 0.8, sig: 5000 + i, label: s.label });
      t += d - 0.8;
      continue;
    }
    if (i === repl) {
      b.push({ start: t, end: t + 2.4, sig: 6000 + i, label: "Drone shot" });
      t += 2.4;
      continue;
    }
    matches.push([i, b.length]);
    b.push({ start: t, end: t + d, sig: s.sig, label: s.label });
    t += d;
    if (i === ins)
      for (const lab of ["Hands typing", "Street crowd"]) {
        b.push({ start: t, end: t + 1.8, sig: 7000 + extra++, label: lab });
        t += 1.8;
      }
  }
  return { a, b, matches, aLabel: "Sent to client, Monday", bLabel: "Your edit" };
}
