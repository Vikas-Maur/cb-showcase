// A mock CartonUi with realistic, seeded data: a project with thousands of versions (Director turns, named
// versions, folds), several cuts, people with their agents and subagents, ghosts of drags, conflict cards, and a
// shot diff. The gallery, the tests and the benchmarks use it; a host can use it to try the components before its
// Carton is wired. `live()` drives it like a busy shared project (versions arriving, presence, ghosts at 20 Hz).

import { TopicHub } from "./hub.ts";
import { shortDate } from "./format.ts";
import type {
  Actor,
  CartonUi,
  Comparison,
  Conflict,
  ConflictChoice,
  Credits,
  Cut,
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
  director: { key: "agent/director", kind: "agent", name: "Director", parent: "human/alice", isYou: true } as Actor,
  explore: { key: "agent/director/sub-explore-4f1a", kind: "subagent", name: "Director", subagentType: "Explore", parent: "agent/director", isYou: true } as Actor,
  captions: { key: "agent/director/sub-captions-9b2c", kind: "subagent", name: "Director", subagentType: "caption-fixer", parent: "agent/director", isYou: true } as Actor,
  terminal: { key: "agent/claude-code-terminal", kind: "agent", name: "Claude Code", parent: "human/alice", isYou: true, model: "Opus 5.5" } as Actor,
  bobsDirector: { key: "agent/director-bob", kind: "agent", name: "Director", parent: "human/bob" } as Actor,
};

const CLIPS = ["Intro", "Interview A", "B-roll city", "Product close-up", "Interview B", "Drone shot", "Team at work", "Logo sting", "CTA", "Outro", "Street crowd", "Hands typing"];
// Prompts a Director turn is labelled with. "tighter intro" is the newest turn's (and the undo button's), so the
// generated ones never reuse it; they are dealt in order, so neighbouring checkpoints never share a label.
const TURNS = [
  "add captions to the interview",
  "punch up the music at the drop",
  "remove the silences",
  "make a 30s version for Instagram",
  "color match the b-roll",
  "swap the logo sting for the new one",
  "shorten the outro to 3 seconds",
  "cut the ums from Priya's answer",
  "open on the drone shot",
  "add a lower third for Bob",
  "duck the music under the voiceover",
  "try a faster pace in the middle",
  "fix the jump cut at 0:42",
  "make the CTA land on the beat",
  "balance the interview levels",
  "add the product close-up before the CTA",
];
const NAMES = ["Rough cut", "Sent to client, Monday", "Before the color pass", "Approved by Priya", "Rough cut v2", "Fine cut", "Picture lock"];

const fmt = (x: number) => `${Math.floor(x / 60)}:${(x % 60).toFixed(1).padStart(4, "0")}`;

function summaryFor(r: () => number): string {
  const c = CLIPS[Math.floor(r() * CLIPS.length)]!;
  const t = ["V1", "V2"][Math.floor(r() * 2)]!;
  const a = Math.round(r() * 600) / 10, b = Math.round((a + (r() - 0.5) * 4) * 10) / 10;
  switch (Math.floor(r() * 9)) {
    case 0: return `Trimmed '${c}' end ${(r() * 8 + 2).toFixed(1)} s → ${(r() * 8 + 1).toFixed(1)} s`;
    case 1: return `Moved '${c}' ${fmt(a)} → ${fmt(Math.max(0, b))}`;
    case 2: return `Added caption '${["we cut editing time", "in half", "meet the team", "built for speed"][Math.floor(r() * 4)]}' on 'Captions' at ${fmt(a)}`;
    case 3: return `Changed '${c}' saturation 1.1 → ${(1 + r() * 0.5).toFixed(1)}`;
    case 4: return `Deleted video '${c}'`;
    case 5: return `Removed ${(r() * 3 + 0.5).toFixed(1)} s from '${t}' at ${fmt(a)} (later items pulled left)`;
    case 6: return `Slipped '${c}' source in ${(r() * 4).toFixed(1)} s → ${(r() * 4 + 1).toFixed(1)} s`;
    case 7: return `Added video '${c}' on '${t}' at ${fmt(a)}`;
    default: return `Changed '${c}' volume 100 → ${Math.round(40 + r() * 60)}`;
  }
}

export interface MockOptions {
  /** How many versions History starts with. */
  versions?: number;
  seed?: number;
  /** "Now" for the generated times (default: Date.now()). */
  now?: number;
}

/** A CartonUi plus the knobs a gallery, test or benchmark needs. */
export interface MockUi extends CartonUi {
  readonly hub: TopicHub<Topic>;
  /** Append a version (newest), as a commit or a sync would. */
  addVersion(v?: Partial<Version>): Version;
  /** Confirm the provisional versions (the server acked them). */
  confirmAll(): void;
  setSync(s: SyncStatus): void;
  setPeers(p: readonly Peer[]): void;
  setGhosts(g: readonly Ghost[]): void;
  setConflicts(c: readonly Conflict[]): void;
  setPublished(p: Published | null): void;
  setUndo(u: UndoTurn | null): void;
  /** Drive it like a busy shared project. Returns a stop function. */
  live(opts?: { versionsPerSecond?: number; ghostHz?: number; presenceHz?: number; burst?: number }): () => void;
  /** Make the shot diff bigger (benchmarks). */
  setShotCount(n: number): void;
}

export function createMockUi(opts: MockOptions = {}): MockUi {
  const r = rng(opts.seed ?? 7);
  const now0 = opts.now ?? Date.now();
  const hub = new TopicHub<Topic>();
  const actors = new Map<string, Actor>(Object.values(people).map((a) => [a.key, a]));

  // ------------------------------------------------------------ history (oldest first; index 0 of a view = newest)
  const all: Version[] = [];
  const named: number[] = [];
  const turns: number[] = [];
  const pos = new Map<string, number>();
  let revision = 0;
  let n = 0;
  let turnsDealt = 0;
  const authorsPool = [people.alice, people.alice, people.alice, people.director, people.explore, people.captions, people.bob, people.bob, people.terminal, people.priya, people.bobsDirector];

  const push = (v: Version) => {
    const i = all.length;
    all.push(v);
    pos.set(v.id, i);
    if (v.name) named.push(i);
    if (v.kind === "turn") turns.push(i);
    revision++;
  };

  const make = (at: number, over: Partial<Version> = {}): Version => {
    n++;
    const author = over.author ?? authorsPool[Math.floor(r() * authorsPool.length)]!;
    const isTurn = over.kind ? over.kind === "turn" : (author.kind === "agent" && r() < 0.8) || (author.kind === "subagent" && r() < 0.1);
    const kind = over.kind ?? (isTurn ? "turn" : r() < 0.02 ? "fold" : r() < 0.015 ? "restore" : "edit");
    const turnAuthor = isTurn && author.kind === "subagent" ? people.director : author;
    const base: Version = {
      id: `rid0a1b2c3.${n}`,
      seq: n,
      ref: `main@${n}`,
      at,
      author: turnAuthor,
      kind,
      summary:
        kind === "fold"
          ? `Folded in 6 changes from '30s Instagram cut'`
          : kind === "restore"
            ? `Restored '${NAMES[Math.floor(r() * NAMES.length)]}'`
            : summaryFor(r),
      ...(kind === "turn" ? { turn: { label: TURNS[turnsDealt++ % TURNS.length]!, edits: 2 + Math.floor(r() * 18) } } : {}),
    };
    if (kind === "fold" && r() < 0.5) return { ...base, summary: "Folded in some of '30s Instagram cut' (2 left out)", foldRest: true, ...over };
    return { ...base, ...over };
  };

  const total = opts.versions ?? 240;
  let at = now0 - total * 95_000;
  for (let i = 0; i < total; i++) {
    at += 20_000 + Math.floor(r() * 150_000);
    if (at > now0 - 30_000) at = now0 - 30_000 - (total - i) * 1000;
    const v = make(at, i > 0 && i % 397 === 0 ? { name: NAMES[(i / 397) % NAMES.length] } : {});
    push(v);
  }
  // The newest few: a Director turn a minute ago, a named version, and two of yours still waiting to sync (L5).
  if (total >= 4) {
    push(make(now0 - 6 * 60_000, { name: "Sent to client, Monday", author: people.alice, kind: "edit", summary: "Changed 'Titles' text 'Summer sale' → 'Summer launch'", published: true }));
    push(make(now0 - 70_000, { author: people.director, kind: "turn", turn: { label: "tighter intro", edits: 12 }, summary: "Trimmed 'Intro' end 6.0 s → 4.5 s" }));
    push(make(now0 - 20_000, { author: people.alice, kind: "edit", summary: "Moved 'B-roll city' 0:12.0 → 0:14.5", provisional: true, seq: null, ref: "main@pending-1" }));
    push(make(now0 - 5_000, { author: people.alice, kind: "edit", summary: "Trimmed 'Interview A' end 9.2 s → 8.0 s", provisional: true, seq: null, ref: "main@pending-2" }));
  }

  const viewOf = (f: HistoryFilter) => (f === "named" ? named : f === "turns" ? turns : null);
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
  };

  // ------------------------------------------------------------ the rest of the state
  const headOf = () => all[all.length - 1]?.ref ?? "main@0";
  let cuts: readonly Cut[] = [
    { id: "cut-main", name: "Main cut", label: "Main cut", current: true, readOnly: false, kind: "main", owner: people.alice, head: headOf(), updatedAt: now0 - 5_000, shared: true },
    { id: "cut-ig", name: "30s Instagram cut", label: "30s Instagram cut", current: false, readOnly: false, kind: "cut", owner: people.alice, head: "ig@41", updatedAt: now0 - 3_600_000 },
    { id: "cut-dir", name: "Director's cut: punchier open", label: "Director's cut: punchier open", current: false, readOnly: false, kind: "director", owner: people.director, head: "dir@12", updatedAt: now0 - 900_000 },
    { id: "cut-offline", name: `Offline edits (${shortDate(now0 - 86_400_000)})`, label: `Offline edits (${shortDate(now0 - 86_400_000)})`, current: false, readOnly: false, kind: "offline", owner: people.alice, head: "off@9", updatedAt: now0 - 86_400_000 },
    { id: "cut-bob-main", name: "Main cut", label: "Bob's Main cut", current: false, readOnly: true, kind: "main", owner: people.bob, head: "bobmain@88", updatedAt: now0 - 7_200_000 },
  ];
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
      mine: { author: people.alice, summary: "Trimmed the end to 0:05.0", at: now0 - 40_000 },
      theirs: { author: people.director, summary: "Moved it to start at 0:02.0 and end at 0:08.0", at: now0 - 70_000 },
      canKeepBoth: false,
      reason: "Both changed when this clip plays. Doing both would end it before it starts.",
      provisional: "theirs",
    },
    {
      id: "items/title-1/textContent",
      title: "Title text",
      mine: { author: people.alice, summary: "\"Summer sale\"", at: now0 - 300_000 },
      theirs: { author: people.bob, summary: "\"Summer launch\"", at: now0 - 240_000 },
      canKeepBoth: true,
      provisional: "theirs",
    },
  ];
  let undo: UndoTurn | null = { id: "rid0a1b2c3.turn", author: people.director, label: "tighter intro", at: now0 - 70_000, edits: 12 };
  let published: Published | null = { cutId: "cut-main", cutName: "Main cut", ref: "main@" + Math.max(1, total - 3), versionName: "Sent to client, Monday", at: now0 - 6 * 60_000, newerEdits: 3, url: "https://cardboard.ai/s/demo" };
  let preview: Preview | null = null;
  let shotCount = 26;

  const set = <T>(topic: Topic, apply: () => T) => {
    const v = apply();
    hub.notify(topic);
    return v;
  };

  const addVersion = (over: Partial<Version> = {}) => {
    const v = make(Date.now(), over);
    push(v);
    hub.notify("history");
    const cur = cuts.find((c) => c.current);
    if (cur && !over.provisional) {
      cuts = cuts.map((c) => (c === cur ? { ...c, head: v.ref, updatedAt: v.at } : c));
      hub.notify("cuts");
    }
    if (published && cur && published.cutId === cur.id) {
      published = { ...published, newerEdits: published.newerEdits + 1 };
      hub.notify("published");
    }
    return v;
  };

  const ui: MockUi = {
    hub,
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
    me: () => people.alice,
    actor: (key) => actors.get(key),

    async compare(a, b) {
      const d = await ui.shotDiff(a, b);
      const side = (ref: string, shots: readonly Shot[], label: string) => {
        const v = all.find((x) => x.ref === ref);
        return { label: v?.name ?? label, ref, at: v?.at ?? Date.now(), author: v?.author ?? people.alice, clipCount: shots.length + 6, length: shots.length ? shots[shots.length - 1]!.end : 0 };
      };
      const between = all.filter((x) => x.ref !== a && x.ref !== b).slice(-7).map((x) => x.summary);
      const c: Comparison = { a: side(a, d.a, d.aLabel), b: side(b, d.b, d.bLabel), diff: diffSummary(d), changes: between };
      return c;
    },

    async credits(itemId) {
      const c: Credits = {
        clip: itemId === "item-broll" ? "B-roll city" : "Intro",
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
      const p: FoldPlan = {
        from,
        into,
        changes: [
          { id: "items/intro", summary: "Trimmed 'Intro' end 6.0 s → 3.5 s", author: people.director, at: now0 - 3_400_000 },
          { id: "items/interview-a", summary: "Removed 4.0 s from 'V1' at 0:09.0 (later items pulled left)", author: people.director, at: now0 - 3_300_000 },
          { id: "items/cap-12", summary: "Added caption 'built for speed' on 'Captions' at 0:21.5", author: people.captions, at: now0 - 3_200_000 },
          { id: "tracks/music", summary: "Changed 'Music' volume 100 → 70", author: people.alice, at: now0 - 3_000_000 },
          { id: "items/logo", summary: "Deleted video 'Logo sting'", author: people.alice, at: now0 - 2_900_000 },
          { id: "root/aspectRatio", summary: "Changed the aspect ratio 16:9 → 9:16", author: people.alice, at: now0 - 2_800_000 },
        ],
        // In a fold, each side says which cut it is on: yours is the cut you fold into.
        conflicts: [conflicts[0] ?? defaultCard(now0)].map((c) => ({ ...c, mine: { ...c.mine, where: into.label }, theirs: { ...c.theirs, where: from.label }, provisional: "mine" as const })),
        warnings: ["'B-roll city' overlaps 'Interview A' by 0.4 s on 'V1'", "The font 'Denton' isn't on this computer, so the title may look different"],
      };
      return p;
    },

    async switchCut(id) {
      cuts = cuts.map((c) => (c.current !== (c.id === id) ? { ...c, current: c.id === id } : c));
      hub.notify("cuts");
    },
    async newCut(name, fromRef) {
      const c: Cut = { id: `cut-${cuts.length + 1}`, name, label: name, current: true, readOnly: false, kind: "cut", owner: people.alice, head: fromRef, updatedAt: Date.now() };
      cuts = [...cuts.map((x) => (x.current ? { ...x, current: false } : x)), c];
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
      addVersion({ author: people.alice, kind: "fold", summary: left ? `Folded in some of '${from?.label}' (${left} left out)` : `Folded in '${from?.label}'` });
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
      addVersion({ author: people.alice, kind: "fold", summary: "Folded in the rest of '30s Instagram cut'" });
      return { ok: true };
    },
    async restore(ref) {
      const v = all.find((x) => x.ref === ref);
      addVersion({ author: people.alice, kind: "restore", summary: `Restored '${v?.name ?? v?.summary ?? ref}'` });
    },
    async nameVersion(id, name) {
      const p = pos.get(id);
      if (p == null) return;
      const v = { ...all[p]!, name };
      all[p] = v;
      if (!named.includes(p)) {
        named.push(p);
        named.sort((x, y) => x - y);
      }
      revision++;
      hub.notify("history");
    },
    async undo(id) {
      if (!undo || undo.id !== id) return { ok: false, error: "Nothing to undo" };
      addVersion({ author: people.alice, kind: "undo", summary: `Undid Director: ${undo.label}` });
      set("undo", () => (undo = null));
      return { ok: true };
    },
    async publish(cutId) {
      const c = cuts.find((x) => x.id === cutId);
      set("published", () => (published = { cutId, cutName: c?.label ?? "Main cut", ref: headOf(), at: Date.now(), newerEdits: 0, url: published?.url }));
    },
    openPreview(ref, label) {
      set("preview", () => (preview = ref ? { ref, label: label ?? ref } : null));
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
    blockEdit: () => set("preview", () => (preview = preview ? { ...preview, blockedEdit: true } : preview)),
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
    mine: { author: people.alice, summary: "Trimmed the end to 0:05.0", at: now0 - 40_000 },
    theirs: { author: people.director, summary: "Moved it to start at 0:02.0", at: now0 - 70_000 },
    canKeepBoth: false,
  };
}

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
    a.push({ start: t, end: t + d, sig: 1000 + i, label: CLIPS[i % CLIPS.length] });
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
  return { a, b, matches, aLabel: "Sent to client, Monday", bLabel: "Current" };
}
