// A CbProject over the fake Carton: writes go through @carton/local's runWrite, as the lease holder runs them.
import { runWrite } from "@carton/local";
import type { Actor, Doc } from "@carton/core";
import type { CbContext, CbProject } from "../../src/commands.ts";
import { FakeCarton } from "./fake-carton.ts";

export const doc0 = (): Doc => ({
  tracks: [{ id: "V1", name: "Video" }, { id: "A1", name: "Music" }],
  timelineItems: [
    { id: "c1", trackId: "V1", name: "Intro", startTime: 0, endTime: 5 },
    { id: "c2", trackId: "V1", name: "Interview", startTime: 5, endTime: 20 },
    { id: "m1", trackId: "A1", name: "Song", startTime: 0, endTime: 30 },
  ],
});

export const human: Actor = { kind: "human", id: "human:me", name: "me", group: "local:me@box" };
export const director = (turn: string, sub?: [string, string]): Actor => ({
  kind: sub ? "subagent" : "agent", id: `director/c1/${turn}${sub ? `/sub-${sub[0]}-${sub[1]}` : ""}`, name: sub ? `Director › ${sub[0]}` : "Director",
  chat: "c1", turn, provider: "claude-code", group: "local:me@box", ...(sub ? { agentType: sub[0], agentId: sub[1] } : {}),
});

export function project(doc: Doc = doc0()): { fake: FakeCarton; proj: CbProject; ctx: (actor?: Actor) => CbContext } {
  const fake = new FakeCarton(doc);
  let n = 0;
  const carton = fake as any;
  const mk = (actor: Actor): CbProject => ({ carton, write: (op, o) => runWrite(carton, { id: `cli.${++n}`, actor: o?.actor ?? actor, op }) });
  return { fake, proj: mk(human), ctx: (actor = human) => ({ project: mk(actor), actor, now: () => fake.clock + 30_000 }) };
}
