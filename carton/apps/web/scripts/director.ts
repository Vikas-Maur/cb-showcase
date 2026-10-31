// The "Director" bot (PLAN §10, §17): a headless agent process that edits the shared cut through Carton while people
// edit it too. Its writes are attributed as Cardboard's Director's are (`director/<chat>/<turn>`, a subagent as
// `…/sub-<type>-<id>`, §10), in the undo group of the person it acts for, so that person's "Undo turn" undoes the
// whole turn (§8). Each write waits for the sequencer's answer, as `cb` does (§6.2, up to 5 s). It shows in presence
// as working while a turn runs.
//
//   node scripts/director.ts --link "<invite link>" --for <account> [--every <ms>] [--gap <ms>]
//     joins with the invite, then runs a turn every <ms> (default: only on command)
// Commands on stdin, one JSON per line (the e2e drives it this way): {"cmd":"turn","plan":"captions"|"tighten"}, {"cmd":"quit"}.
// Events on stdout, one JSON per line: {"event":"ready",…}, {"event":"turn-done","turn":…,"results":[…]}, {"event":"error",…}.

import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createMemoryStore } from "@carton/store-memory";
import { parseActor } from "@carton/cardboard";
import { webSocketTransport } from "../src/ws-transport.ts";
import type { Actor, Carton, Op, Rec } from "@carton/core";
import { ITEMS } from "../src/demo-doc.ts";
import { parseJoinHash } from "../src/descriptor.ts";
import { trimOps } from "../src/edit.ts";
import { openProject } from "../src/project.ts";
import { Session, memoryKeys } from "../src/session.ts";

export interface DirectorOptions {
  baseUrl: string;
  projectId: string;
  invite: string;
  /** The account of the person the Director acts for: its turns go in that person's undo group. */
  forAccount: string;
  /** Pause between a turn's edits (ms), so people see it work. */
  gapMs?: number;
  log?: (event: Record<string, unknown>) => void;
}

interface Edit {
  /** Made by a subagent of this type (Claude Code's agent_type). */
  sub?: string;
  ops: (doc: Record<string, unknown>) => Op[];
}
interface Plan {
  prompt: string;
  activity: string;
  edits: Edit[];
}

const item = (doc: Record<string, unknown>, id: string) => ((doc[ITEMS] ?? []) as Rec[]).find((r) => r.id === id);
const caption = (id: string, text: string) => (doc: Record<string, unknown>): Op[] => (item(doc, id) ? [{ op: "set", path: [ITEMS, id, "captionText"], value: text }] : []);

export const PLANS: Record<string, Plan> = {
  // "Director edits captions while Bob trims" (§17): text only, so it merges with anyone's trims
  captions: {
    prompt: "punch up the captions",
    activity: "Rewriting captions",
    edits: [
      { ops: caption("cap-1", "Saturday. 7 am. Let's go.") },
      { ops: caption("cap-2", "The long way round, on purpose") },
      { sub: "captions", ops: caption("cap-3", "Coffee first. Always.") },
      { sub: "captions", ops: caption("cap-4", "Same time next weekend?") },
    ],
  },
  // a timing edit: the intro clip loses half a second at its end
  tighten: {
    prompt: "tighter intro",
    activity: "Tightening the intro",
    edits: [
      {
        ops: (doc) => {
          const c = item(doc, "clip-1");
          return c ? trimOps(c, "end", (c.endTime as number) - 0.5) : [];
        },
      },
    ],
  },
};

const hex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");

export class Director {
  readonly carton: Carton;
  readonly #o: DirectorOptions;
  readonly #chat = `demo-${hex(3)}`;
  #turns = 0;
  #activity = "Waiting for a prompt";
  #busy: Promise<unknown> = Promise.resolve();

  private constructor(carton: Carton, o: DirectorOptions) {
    this.carton = carton;
    this.#o = o;
  }

  static async start(o: DirectorOptions): Promise<Director> {
    const session = await Session.join({ baseUrl: o.baseUrl, projectId: o.projectId, invite: o.invite, account: "director", keys: memoryKeys() });
    const me = parseActor("director", { group: o.forAccount })!;
    const { carton } = await openProject({ session, me, store: createMemoryStore(), transport: webSocketTransport() });
    const d = new Director(carton, o);
    // caught up before the first turn, so its edits build on what everyone sees
    for (let i = 0; i < 100 && carton.sync!.status !== "up-to-date"; i++) await new Promise((r) => setTimeout(r, 50));
    // presence isn't stored: say we're here now, and once to each person who appears later
    const heard = new Set<string>();
    carton.on((e) => {
      if (e.type !== "presence" || !e.state) return;
      const k = `${e.actor.kind}/${e.actor.id}`;
      if (heard.has(k)) return;
      heard.add(k);
      carton.sync!.presence({ activity: d.#activity });
    });
    carton.sync!.presence({ activity: d.#activity });
    return d;
  }

  /** The actor of this turn, or of its subagent (§10: `director/<chat>/<turn>[/sub-<type>-<id>]`). */
  actor(turn: string, sub?: string): Actor {
    const id = `director/${this.#chat}/${turn}${sub ? `/sub-${sub}-${hex(3)}` : ""}`;
    return parseActor(id, { group: this.#o.forAccount })!;
  }

  /** Run one turn: its edits in order, each waiting for the sequencer; the last one names the version with the prompt. */
  turn(planName: string): Promise<{ turn: string; results: { status: string; id?: string }[] }> {
    const run = async () => {
      const plan = PLANS[planName];
      if (!plan) throw new Error(`no plan ${planName}`);
      const turn = `turn-${++this.#turns}`;
      const results: { status: string; id?: string }[] = [];
      this.#say(plan.activity);
      for (let i = 0; i < plan.edits.length; i++) {
        const e = plan.edits[i]!;
        if (i) await new Promise((r) => setTimeout(r, this.#o.gapMs ?? 700));
        const { doc } = await this.carton.head();
        const ops = e.ops(doc);
        if (!ops.length) continue;
        const last = i === plan.edits.length - 1;
        const r = await this.carton.commit({ ops, author: this.actor(turn, e.sub), wait: 5000, ...(last ? { name: plan.prompt } : {}) });
        results.push({ status: r.status, ...(r.status === "pending" ? { id: r.id } : {}) });
        this.#say(plan.activity);
      }
      this.#say("Waiting for a prompt");
      return { turn, results };
    };
    const p = this.#busy.then(run, run);
    this.#busy = p.catch(() => {});
    return p;
  }

  #say(activity: string): void {
    this.#activity = activity;
    this.carton.sync!.presence({ activity });
  }

  async stop(): Promise<void> {
    this.carton.sync?.presence(null);
    await this.carton.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const arg = (k: string, d?: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  const say = (e: Record<string, unknown>) => process.stdout.write(JSON.stringify(e) + "\n");
  const link = new URL(arg("--link") ?? "");
  const j = parseJoinHash(link.hash);
  if (!j) throw new Error("--link must be an invite link (…/#join=<project>.<invite>)");
  const d = await Director.start({ baseUrl: link.origin, projectId: j.projectId, invite: j.invite, forAccount: arg("--for", "alice")!, gapMs: Number(arg("--gap", "700")) });
  say({ event: "ready", projectId: j.projectId });
  const every = Number(arg("--every", "0"));
  const order = Object.keys(PLANS);
  let n = 0;
  const timer = every > 0 ? setInterval(() => void d.turn(order[n++ % order.length]!).then((r) => say({ event: "turn-done", ...r })), every) : null;
  const quit = async () => {
    if (timer) clearInterval(timer);
    await d.stop();
    say({ event: "stopped" });
    process.exit(0);
  };
  createInterface({ input: process.stdin }).on("line", (line) => {
    let m: { cmd?: string; plan?: string };
    try {
      m = JSON.parse(line);
    } catch {
      return say({ event: "error", error: "not JSON" });
    }
    if (m.cmd === "turn") void d.turn(m.plan ?? "captions").then((r) => say({ event: "turn-done", ...r }), (e) => say({ event: "error", error: (e as Error).message }));
    else if (m.cmd === "quit") void quit();
  }).on("close", () => void quit());
  process.on("SIGTERM", () => void quit());
  // a bot never outlives its demo: stop after two hours at most
  setTimeout(() => void quit(), Number(arg("--max-ms", "7200000"))).unref();
}
