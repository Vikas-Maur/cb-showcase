// Node abandons each connect attempt after 250 ms by default (happy eyeballs), so over a link with a longer round
// trip nothing connects (the Cloudflare lab, 2026-11-02: a 400 ms link failed every request). The blob clients' fetch
// raises it. Each test file runs in its own process, so the default starts at Node's own.
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { allowSlowLinks, nodeFetch, SLOW_LINK_ATTEMPT_MS } from "../src/index.ts";

test("setting up the Node fetch raises Node's connect attempt time from 250 ms to 2 s", () => {
  assert.equal(net.getDefaultAutoSelectFamilyAttemptTimeout(), 250, "Node's default, before");
  assert.ok(nodeFetch(), "on Node there is a node:https fetch");
  assert.equal(net.getDefaultAutoSelectFamilyAttemptTimeout(), SLOW_LINK_ATTEMPT_MS);
});

test("a longer attempt time the app chose is kept; a shorter one is raised", () => {
  net.setDefaultAutoSelectFamilyAttemptTimeout(5000);
  assert.equal(allowSlowLinks(), 5000);
  assert.equal(net.getDefaultAutoSelectFamilyAttemptTimeout(), 5000);
  net.setDefaultAutoSelectFamilyAttemptTimeout(300);
  assert.equal(allowSlowLinks(), SLOW_LINK_ATTEMPT_MS);
  assert.equal(net.getDefaultAutoSelectFamilyAttemptTimeout(), SLOW_LINK_ATTEMPT_MS);
});
