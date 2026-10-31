// A host's answer to a hello at a given document schema version (H-SV): a fresh cut is adopted through the protocol's
// own hand-off, then a hello names it. Used by each host's test that it takes the current Cardboard client as shipped.
import type { Transport } from "@carton/core/plugins";
import type { sync } from "@carton/core";

/** Adopts a cut, then says hello at `schemaVersion`: the host's answer to the hello. */
export async function helloAtSchema(transport: Transport, url: string, token: string, schemaVersion: number): Promise<sync.ServerMessage> {
  const c = await transport.connect(url, { token });
  const got: sync.ServerMessage[] = [];
  const next = (pred: (m: sync.ServerMessage) => boolean) =>
    new Promise<sync.ServerMessage>((ok, fail) => {
      const t = setTimeout(() => fail(new Error(`no answer; got ${got.map((m) => m.type)}`)), 10_000);
      const look = () => {
        const m = got.find(pred);
        if (m) return clearTimeout(t), ok(m);
        setTimeout(look, 20);
      };
      look();
    });
  c.onMessage((m) => got.push(m));
  const branchId = `sv-${Date.now().toString(36)}-${schemaVersion}`;
  const rec = { id: branchId, name: "main", forkOf: null, owner: "o", kind: "main", sequencer: { kind: "server", since: 0 } };
  c.send({ type: "adopt", branchId, n: 0, stateHash: "", rows: [], rec, doc0: { tracks: [], timelineItems: [] }, closure: [] } as never);
  const adopted = await next((m) => m.type === "adopted" || m.type === "adoptError");
  if (adopted.type !== "adopted") throw new Error(`adopt refused: ${JSON.stringify(adopted)}`);
  c.send({ type: "hello", branchId, have: 0, pending: [], rids: [], schemaVersion } as sync.ClientMessage);
  const answer = await next((m) => m.type === "hello" || m.type === "error");
  c.close();
  return answer;
}
