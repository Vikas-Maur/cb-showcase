// The sync lease on the Store contract: CAS on the seen nonce, heartbeat and release fenced on our own nonce, and the
// fence condition that makes any write batch fail once the lease has moved. One race runs across real processes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Lease, fence, LEASE_TABLE } from "../src/lease.ts";
import { openTestStore } from "./support/sqlite-store.ts";
import { scratch } from "./support/scratch.ts";

const dir = mkdtempSync(join(scratch(), "lease-"));
const who = (pid: number) => ({ pid, socketPath: `/x/${pid}.sock`, kind: "helper" as const });

test("take is a CAS on the nonce the taker saw; beat and release only work for the holder", async () => {
  const store = openTestStore(join(dir, "a.db"));
  const lease = new Lease(store);
  assert.equal(await lease.read(), null);
  const a = await lease.take(null, who(1));
  assert.ok(a);
  assert.equal(await lease.take(null, who(2)), null, "a second taker that saw it free loses");
  assert.equal((await lease.read())?.pid, 1);
  const b = await lease.take(a.nonce, who(2));
  assert.ok(b, "a taker that saw holder 1 takes over");
  assert.equal(await lease.take(a.nonce, who(3)), null, "a third taker that also saw holder 1 loses: exactly one takeover");
  assert.equal(await lease.beat(a), false, "the replaced holder's heartbeat fails: it is fenced");
  assert.equal(await lease.release(a.nonce), false, "and it can't release someone else's lease");
  assert.ok(await lease.beat(b));
  assert.ok((await lease.read())!.heartbeat >= b.heartbeat - 1);
  // any write batch can be fenced on the holder's nonce
  assert.equal(await store.write([{ table: "pending", key: ["x"], value: 1 }], [fence(a.nonce)]), false);
  assert.equal(await store.write([{ table: "pending", key: ["x"], value: 1 }], [fence(b.nonce)]), true);
  assert.ok(await lease.release(b.nonce));
  assert.equal(await lease.read(), null);
  assert.equal(await store.get(LEASE_TABLE, ["sync", "nonce"]), undefined);
  await store.close();
});

test("heartbeats never break the fence: the nonce has its own key", async () => {
  const store = openTestStore(join(dir, "b.db"));
  const lease = new Lease(store);
  const a = (await lease.take(null, who(1)))!;
  for (let i = 0; i < 5; i++) assert.ok(await lease.beat(a, Date.now() + i));
  assert.ok(await store.write([{ table: "pending", key: ["y"], value: 2 }], [fence(a.nonce)]));
  await store.close();
});

const RACER = fileURLToPath(new URL("./support/lease-racer.ts", import.meta.url));
test("eight processes race to take over the same dead holder: exactly one wins", async () => {
  const path = join(dir, "race.db");
  const store = openTestStore(path);
  const lease = new Lease(store);
  const dead = (await lease.take(null, who(999999)))!;
  const kids = Array.from({ length: 8 }, () => spawn(process.execPath, [RACER, path, dead.nonce], { stdio: ["ignore", "pipe", "inherit"] }));
  const outs = await Promise.all(kids.map((k) => new Promise<string>((res) => { let s = ""; k.stdout.on("data", (d) => (s += d)); k.on("exit", () => res(s.trim())); })));
  const wins = outs.filter((o) => o.startsWith("won"));
  assert.equal(wins.length, 1, `exactly one winner: ${outs.join(", ")}`);
  assert.equal((await lease.read())?.pid, Number(wins[0].split(" ")[1]));
  await store.close();
});
