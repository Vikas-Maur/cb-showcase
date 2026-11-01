// Actor identity from CARDBOARD_ACTOR (§10, L1). Same results as @carton/local's parseActorId.
import test from "node:test";
import assert from "node:assert/strict";
import { parseActor, cardboardIdentity, subagentActorId } from "../src/identity.ts";

test("a Director turn", () => {
  assert.deepEqual(parseActor("director/c1/t7"), { kind: "agent", id: "director/c1/t7", name: "Director", provider: "claude-code", chat: "c1", turn: "t7" });
});

test("a Director subagent, down to its type and id", () => {
  const id = subagentActorId("director/c1/t7", "general-purpose", "a1b2-c3");
  assert.equal(id, "director/c1/t7/sub-general-purpose-a1b2_c3");
  assert.deepEqual(parseActor(id), { kind: "subagent", id, name: "Director › general-purpose", provider: "claude-code", chat: "c1", turn: "t7", agentType: "general-purpose", agentId: "a1b2_c3" });
});

test("host Claude Code, and self-declared providers (L1)", () => {
  assert.deepEqual(parseActor("claude-code/s9"), { kind: "agent", id: "claude-code/s9", name: "Claude Code", provider: "claude-code" });
  assert.deepEqual(parseActor("codex/fix-captions", { group: "local:me@box" }), { group: "local:me@box", kind: "agent", id: "codex/fix-captions", name: "Codex" });
  assert.equal(parseActor("my-tool")?.name, "my-tool");
});

test("not an actor id: empty parts, unsafe characters", () => {
  for (const v of ["", "a//b", "has space", "x\ny", "a/b/../c".replace("..", "")]) assert.equal(parseActor(v), null, JSON.stringify(v));
});

test("cardboardIdentity reads CARDBOARD_ACTOR and nothing else", () => {
  assert.equal(cardboardIdentity.current({}), null);
  assert.equal(cardboardIdentity.current({ CARDBOARD_ACTOR: "director/c/t" })?.turn, "t");
  assert.equal(cardboardIdentity.current({ CARDBOARD_ACTOR: "bad actor" }), null);
});
