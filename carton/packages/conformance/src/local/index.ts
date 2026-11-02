// Local conformance (PLAN §3.1, §6.2, §10). Owner: local-cli.
// - `leaseSuite`: what the sync lease needs from a Store (R3-01, R4-04, R5-06): one taker wins a free or dead lease,
//   a takeover is a CAS on the nonce the taker saw, heartbeats and releases are fenced on the holder's own nonce, and
//   `fence(nonce)` makes any write batch fail once the lease has moved. With `second`, the races run across two
//   handles of one store (two processes on one carton.db).
// - `identitySuite`: the IdentitySource invariants: deterministic for the same environment; never invents a turn or
//   agent id it wasn't given; a windowless local actor gets the local undo group (§8), never a remote one.
// The process-level behaviour (helper takeover after a kill or a hang, handover, fencing of a stalled holder) is
// tested on real processes in @carton/local's own suite (R4-04, R5-06).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Lease, fence, LEASE_TABLE, identitySources, localGroup, parseActorId, subagentSuffix } from "@carton/local";
import type { Store } from "@carton/core/plugins";
import type { IdentitySource } from "@carton/core/plugins";
import type { Actor } from "@carton/core";

export interface LeaseSuiteOptions {
  /** A second handle on the same store (another process on the same carton.db). */
  second?: (store: Store) => Promise<Store>;
}

const who = (pid: number) => ({ pid, socketPath: `/sock/${pid}`, kind: "helper" as const });

export const leaseCases: { name: string; run(make: () => Promise<Store>, o: LeaseSuiteOptions): Promise<void> }[] = [
  {
    name: "a free lease goes to exactly one of two takers",
    async run(make, o) {
      const s1 = await make();
      const s2 = o.second ? await o.second(s1) : s1;
      const [a, b] = await Promise.all([new Lease(s1).take(null, who(1)), new Lease(s2).take(null, who(2))]);
      assert.equal([a, b].filter(Boolean).length, 1);
      assert.equal((await new Lease(s1).read())?.nonce, (a ?? b)!.nonce);
      if (s2 !== s1) await s2.close();
      await s1.close();
    },
  },
  {
    name: "a takeover is a CAS on the seen nonce: of two takers that saw the same dead holder, one wins",
    async run(make, o) {
      const s1 = await make();
      const s2 = o.second ? await o.second(s1) : s1;
      const dead = (await new Lease(s1).take(null, who(9)))!;
      const [a, b] = await Promise.all([new Lease(s1).take(dead.nonce, who(1)), new Lease(s2).take(dead.nonce, who(2))]);
      assert.equal([a, b].filter(Boolean).length, 1);
      assert.equal(await new Lease(s1).take(dead.nonce, who(3)), null, "a late taker that saw the dead holder loses too");
      if (s2 !== s1) await s2.close();
      await s1.close();
    },
  },
  {
    name: "heartbeat and release are fenced on the holder's nonce; beats never break the fence",
    async run(make) {
      const s = await make();
      const l = new Lease(s);
      const a = (await l.take(null, who(1)))!;
      for (let i = 0; i < 3; i++) assert.ok(await l.beat(a, Date.now() + i));
      assert.ok(await s.write([{ table: "conformance", key: ["x"], value: 1 }], [fence(a.nonce)]));
      const b = (await l.take(a.nonce, who(2)))!;
      assert.equal(await l.beat(a), false, "the replaced holder learns it at its next beat");
      assert.equal(await l.release(a.nonce), false, "and can't release the new holder's lease");
      assert.equal(await s.write([{ table: "conformance", key: ["y"], value: 1 }], [fence(a.nonce)]), false, "its fenced writes fail");
      assert.equal(await s.get("conformance", ["y"]), undefined);
      assert.ok(await l.release(b.nonce));
      assert.equal(await l.read(), null);
      assert.equal(await s.get(LEASE_TABLE, ["sync", "nonce"]), undefined);
      await s.close();
    },
  },
];

export function leaseSuite(name: string, make: () => Promise<Store>, opts: LeaseSuiteOptions = {}): void {
  for (const c of leaseCases) test(`lease conformance (${name}): ${c.name}`, () => c.run(make, opts));
}

/** Environments every IdentitySource must handle. */
const ENVS: Record<string, Record<string, string>> = {
  empty: {},
  director: { CARDBOARD_ACTOR: "director/chat1/turn2" },
  subagent: { CARDBOARD_ACTOR: `director/chat1/turn2${subagentSuffix("general-purpose", "a-1")}` },
  claude: { CLAUDECODE: "1" },
  declared: { CARTON_AGENT: "codex/fix-captions" },
  hostile: { CARDBOARD_ACTOR: "director/x/y; rm -rf ~", CARTON_AGENT: "director/c/t" },
};

export function identitySuite(name: string, sources: readonly IdentitySource[] = identitySources()): void {
  const first = (env: Record<string, string>): Actor | null => { for (const s of sources) { const a = s.current(env); if (a) return a; } return null; };
  test(`identity conformance (${name}): deterministic for the same environment`, () => {
    for (const env of Object.values(ENVS)) assert.deepEqual(first({ ...env }), first({ ...env }));
  });
  test(`identity conformance (${name}): never invents a turn or agent id it wasn't given`, () => {
    for (const [k, env] of Object.entries(ENVS)) {
      const a = first(env);
      if (!a) continue;
      const given = env.CARDBOARD_ACTOR ? parseActorId(env.CARDBOARD_ACTOR) : null;
      assert.equal(a.turn, given?.turn, `${k}: turn`);
      assert.equal(a.agentId, given?.agentId, `${k}: agentId`);
      if (!given) assert.ok(!a.id.startsWith("director/"), `${k}: only CARDBOARD_ACTOR (the hook) names a Director turn`);
    }
  });
  test(`identity conformance (${name}): windowless local actors share the local undo group (§8)`, () => {
    for (const env of [ENVS.empty, ENVS.claude, ENVS.declared]) {
      const a = first(env);
      if (a) assert.equal(a.group, localGroup());
    }
  });
}

/** The local suite as the skeleton named it: the lease cases on a store factory, and the default identity sources. */
export function localSuite(opts: { makeStore: () => Promise<Store>; second?: (s: Store) => Promise<Store>; name?: string }): void {
  leaseSuite(opts.name ?? "store", opts.makeStore, { second: opts.second });
  identitySuite("@carton/local defaults");
}
