// Actor identity from CARDBOARD_ACTOR (§10, L1).
import test from "node:test";
import assert from "node:assert/strict";
import { parseActor, cardboardIdentity, subagentActorId } from "../src/identity.ts";

test("a Director turn", () => {
  assert.deepEqual(parseActor("director/c1/t7"), { kind: "agent", id: "director/c1/t7", name: "Director", chat: "c1", turn: "t7", provider: "claude" });
});

test("a Director subagent, down to its type and id", () => {
  const id = subagentActorId("director/c1/t7", "general-purpose", "a1b2-c3");
  assert.equal(id, "director/c1/t7/sub-general-purpose-a1b2_c3");
  assert.deepEqual(parseActor(id), { kind: "subagent", id, name: "Director › general-purpose", chat: "c1", turn: "t7", provider: "claude", agentType: "general-purpose", agentId: "a1b2_c3" });
});

test("host Claude Code through --settings, and an unknown hooked agent", () => {
  assert.equal(parseActor("claude-code/s9/t2")?.name, "Claude Code");
  assert.deepEqual(parseActor("cursor/s/t"), { kind: "agent", id: "cursor/s/t", name: "cursor", chat: "s", turn: "t" });
});

test("anything else is self-declared, with no turn (a windowless actor); defaults fill the rest", () => {
  assert.deepEqual(parseActor("codex", { group: "win-1", model: "gpt" }), { group: "win-1", model: "gpt", kind: "agent", id: "codex", name: "codex" });
  assert.equal(parseActor("a/b")?.turn, undefined);
  assert.equal(parseActor(""), null);
  assert.equal(parseActor("x\ny"), null);
});

test("cardboardIdentity reads CARDBOARD_ACTOR and nothing else", () => {
  assert.equal(cardboardIdentity.current({}), null);
  assert.equal(cardboardIdentity.current({ CARDBOARD_ACTOR: "director/c/t" })?.kind, "agent");
});
