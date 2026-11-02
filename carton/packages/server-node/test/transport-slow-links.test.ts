// The WebSocket transport raises Node's connect attempt time (250 ms by default) to 2 s, so a sync client connects over
// a link with a long round trip (the Cloudflare lab, 2026-11-02). Its own process: the default starts at Node's.
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { webSocketTransport } from "../src/transport.ts";

test("making a WebSocket transport raises Node's connect attempt time to 2 s, and keeps a longer one", () => {
  assert.equal(net.getDefaultAutoSelectFamilyAttemptTimeout(), 250, "Node's default, before");
  webSocketTransport();
  assert.equal(net.getDefaultAutoSelectFamilyAttemptTimeout(), 2000);
  net.setDefaultAutoSelectFamilyAttemptTimeout(4000);
  webSocketTransport();
  assert.equal(net.getDefaultAutoSelectFamilyAttemptTimeout(), 4000);
});
