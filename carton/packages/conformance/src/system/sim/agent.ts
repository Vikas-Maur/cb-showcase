// Agents as they behave toward files and `cb` (port of system-v11 `agent.mjs`).
// - Claude Code's rule (checks: true): Edit/Write refuse a file whose content changed since the agent last read it
//   (or last wrote it). 2.1.314 compares length and sha256; here the content hash.
// - checks: false models a writer without that rule (a whole-file write tool, a script, an editor's overwrite).
// - hooked: Cardboard's hooks are installed (Director, or host Claude Code with --settings): reads of the shared
//   timeline.tsx are reported (freeze start), Stop/SubagentStop runs the conflict hook, `cb` carries the actor id.
import * as A from "./adapter.ts";
import type { Sim } from "./kernel.ts";
import { TIMELINE, parse, type Replica, type SimActor } from "./replica.ts";

export class Agent {
  readonly r: Replica;
  readonly sim: Sim;
  readonly name: string;
  readonly hooked: boolean;
  readonly checks: boolean;
  readonly toolMs: number;
  readonly actor: SimActor;
  readonly seen = new Map<string, string>();
  readonly stats = { reads: 0, edits: 0, refusals: 0, retries: 0, writes: 0 };
  stopHookActive = false;
  constructor(r: Replica, { name, hooked = true, checks = true, actor = {}, toolMs = 40 }: { name: string; hooked?: boolean; checks?: boolean; actor?: Partial<SimActor>; toolMs?: number }) {
    this.r = r;
    this.sim = r.sim;
    this.name = name;
    this.hooked = hooked;
    this.checks = checks;
    this.toolMs = toolMs;
    this.actor = r.newActor({ kind: "agent", id: name, name, hooked, windowless: !hooked && !actor.window, ...actor });
  }
  async read(path: string): Promise<ReturnType<typeof parse>> {
    await this.sim.sleep(this.toolMs);
    if (this.hooked && path === TIMELINE) this.r.worker?.hookRead(this.actor); // PreToolUse hook, before the read
    const f = this.r.fs.read(path)!;
    this.seen.set(path, f.hash);
    this.stats.reads++;
    return parse(f.content);
  }
  /** Read-modify-write of the body; the header line is kept as the agent saw it. */
  async edit(path: string, mutate: (d: A.SimDoc) => void): Promise<boolean> {
    await this.sim.sleep(this.toolMs);
    const f = this.r.fs.read(path)!;
    if (this.checks && this.seen.get(path) !== f.hash) {
      this.stats.refusals++;
      return false; // "modified since read"
    }
    const p = parse(f.content);
    const d = A.clone(p.doc);
    mutate(d);
    const nf = this.r.fs.write(path, `${p.header}\n${A.snapshot(d)}\n`, this);
    this.seen.set(path, nf.hash);
    this.stats.edits++;
    return true;
  }
  /** A whole-file write of content the agent built earlier (no staleness check). */
  async write(path: string, content: string): Promise<void> {
    await this.sim.sleep(this.toolMs);
    const nf = this.r.fs.write(path, content, this);
    this.seen.set(path, nf.hash);
    this.stats.writes++;
  }
  /** Claude Code's loop: on "modified since read", re-read and try again after a short think. */
  async editUntilDone(path: string, mutate: (d: A.SimDoc) => void, retryThink: [number, number] = [1000, 4000]): Promise<void> {
    for (;;) {
      if (await this.edit(path, mutate)) return;
      this.stats.retries++;
      await this.read(path);
      await this.sim.sleep(this.sim.uni(...retryThink));
    }
  }
  cb(req: Record<string, any>, opts?: { retryOnReset?: boolean }): Promise<Record<string, any>> {
    return this.r.cb(this.actor, req, opts);
  }
  stop(): { decision: "allow" | "block"; reason?: string; handedToHuman?: number } {
    const d = this.r.worker!.stopHook(this.actor, this.stopHookActive);
    this.stopHookActive = d.decision === "block";
    return d;
  }
}
