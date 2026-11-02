// The Worker hands each request's work to ctx.waitUntil (worker.ts): workerd cancels a request's work when its client
// disconnects unless it is held that way, and a part upload cut off before its `finally` left its R2 part lock held
// for 30 minutes, refusing every resume (cf-lab, 2026-11-02). The cancellation itself is the runtime's; this checks
// the hand-over: the work is the request's own, it settles with the response, and fetch without a ctx still works.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.ts";
import type { Env } from "../src/env.ts";

const env = { AUTH_SECRET: "a-test-secret-of-enough-length-0123456789" } as unknown as Env;
const req = () => new Request("https://host/api/projects/p1/blobs/head?key=m%2Fx", { headers: { authorization: "Bearer not-a-token" } });

test("each request's work is handed to waitUntil, and settles with the response (cf-lab: a killed upload's part lock)", async () => {
  const held: Promise<unknown>[] = [];
  let settled = false;
  const res = await worker.fetch(req(), env, { waitUntil: (p) => void held.push(p.then(() => (settled = true))) });
  assert.equal(held.length, 1, "one hand-over per request");
  await held[0];
  assert.ok(settled, "the held work settles");
  assert.equal(res.status, 401, "the answer is the route's own (a bad token here)");
});

test("the held work never rejects (a failed request's error stays the response's), and fetch without a ctx works as before", async () => {
  const held: Promise<unknown>[] = [];
  const withCtx = await worker.fetch(req(), env, { waitUntil: (p) => void held.push(p) });
  const without = await worker.fetch(req(), env);
  assert.equal(without.status, withCtx.status);
  await assert.doesNotReject(held[0]!);
});
