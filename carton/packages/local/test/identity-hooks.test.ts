// Identity sources (§10, L1) and the Claude Code hooks: the PreToolUse prefixer and the Stop/SubagentStop hook that
// blocks once per conflict set (§6.2, R3-09).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { identify, parseActorId, localGroup, subagentSuffix, hookDelivered } from "../src/identity.ts";
import { prefixCommand, mentionsCb, stopHook, preToolUseOutput, stopOutput } from "../src/hooks.ts";
import type { NoticeBox, ConflictNotice } from "../src/hooks.ts";

test("CARDBOARD_ACTOR names the Director's turn, and a subagent down to its type and id", () => {
  const d = identify({ env: { CARDBOARD_ACTOR: "director/c1/t7" } });
  assert.deepEqual([d.kind, d.id, d.name, d.chat, d.turn, d.provider, d.group], ["agent", "director/c1/t7", "Director", "c1", "t7", "claude-code", localGroup()]);
  const s = identify({ env: { CARDBOARD_ACTOR: "director/c1/t7/sub-general-purpose-a1b2" } });
  assert.deepEqual([s.kind, s.turn, s.agentType, s.agentId, s.name], ["subagent", "t7", "general-purpose", "a1b2", "Director › general-purpose"]);
  assert.equal(identify({ env: { CARDBOARD_ACTOR: "director/c1/t7; rm -rf /" } }).kind, "external", "a malformed id is not trusted");
});

test("Claude Code hook input: subagent ids from agent_id/agent_type; hyphenated ids stay parseable", () => {
  const a = identify({ env: {}, hook: { session_id: "0123456789abcdef", agent_id: "ab-cd", agent_type: "code-reviewer" } });
  assert.equal(a.id, "claude-code/01234567/sub-code-reviewer-ab_cd");
  assert.deepEqual([a.kind, a.agentType, a.agentId], ["subagent", "code-reviewer", "ab_cd"]);
  assert.equal(parseActorId(`director/c/t${subagentSuffix("general-purpose", "x-y-z")}`)!.agentType, "general-purpose");
  // inside a Director turn the hook input adds the subagent part to the Director's id
  const b = identify({ env: { CARDBOARD_ACTOR: "director/c/t" }, hook: { session_id: "s", agent_id: "q1", agent_type: "editor" } });
  assert.equal(b.id, "director/c/t", "CARDBOARD_ACTOR (source 1) wins when it is set");
});

test("self-declared (L1) for Codex and Gemini; never a director id; environment fallback", () => {
  const c = identify({ env: {}, declared: "codex/fix-captions" });
  assert.deepEqual([c.kind, c.id, c.provider, c.name], ["agent", "codex/fix-captions", "codex", "Codex (fix-captions) (terminal)"]);
  assert.equal(identify({ env: { CARTON_AGENT: "gemini" } }).provider, "gemini");
  assert.notEqual(identify({ env: {}, declared: "director/c/t" }).id, "director/c/t", "only the hook may claim a Director turn");
  assert.equal(identify({ env: { CLAUDECODE: "1" } }).provider, "claude-code");
  assert.equal(identify({ env: { GEMINI_CLI: "1" } }).provider, "gemini");
  assert.equal(identify({ env: { CODEX_SANDBOX: "seatbelt" } }).provider, "codex");
  const t = identify({ env: {} });
  assert.equal(t.kind, "external");
  assert.equal(t.group, localGroup(), "windowless local callers share the window's undo group (§8)");
  assert.equal(hookDelivered(identify({ env: { CARDBOARD_ACTOR: "director/c/t" } })), true);
  assert.equal(hookDelivered(c), false, "Codex gets notices only (L1)");
});

test("PreToolUse prefixer: only commands that run cb, one export in front, the subagent suffix inside a subagent", () => {
  for (const c of ["cb history Demo", "cd x && cb source apply Demo", "echo hi | cardboard verify Demo", "/usr/local/bin/cb undo Demo", "x=$(cb source print Demo)", "cb.cmd history D"]) assert.ok(mentionsCb(c), c);
  for (const c of ["ls -la", "echo cbx", "grep cb file.txt", "npm run abc"]) assert.equal(mentionsCb(c), c === "grep cb file.txt", c);
  const turn = { chat: "chat9", turn: "t3" };
  assert.equal(prefixCommand({ tool_input: { command: "ls" } }, turn), null);
  const r = prefixCommand({ tool_input: { command: "cb source apply Demo" }, agent_id: "a1", agent_type: "editor" }, turn)!;
  assert.equal(r.command, "export CARDBOARD_ACTOR='director/chat9/t3/sub-editor-a1'; cb source apply Demo");
  const out = preToolUseOutput({ tool_input: { command: "cb x", description: "d" } }, prefixCommand({ tool_input: { command: "cb x" } }, turn)) as any;
  assert.equal(out.hookSpecificOutput.updatedInput.description, "d", "other tool input fields are kept");
  // the prefixed command really sets the variable for every cb in a compound command
  const env = execFileSync("sh", ["-c", prefixCommand({ tool_input: { command: "true && sh -c 'echo $CARDBOARD_ACTOR' # cb" } }, turn)!.command], { encoding: "utf8" });
  assert.equal(env.trim(), "director/chat9/t3");
});

class Box implements NoticeBox {
  fresh = new Map<string, ConflictNotice[]>();
  blockedSet = new Map<string, ConflictNotice[]>();
  human: ConflictNotice[] = [];
  ended: string[] = [];
  freshConflicts(a: string) { return this.fresh.get(a) ?? []; }
  markBlocked(a: string, ids: string[]) {
    const f = this.freshConflicts(a);
    this.blockedSet.set(a, [...(this.blockedSet.get(a) ?? []), ...f.filter((n) => ids.includes(n.id))]);
    this.fresh.set(a, f.filter((n) => !ids.includes(n.id)));
  }
  blocked(a: string) { return this.blockedSet.get(a) ?? []; }
  handToHuman(a: string, ids: string[]) { this.human.push(...this.blocked(a).filter((n) => ids.includes(n.id))); this.blockedSet.delete(a); }
  endTurn(a: string) { this.ended.push(a); }
}

test("Stop hook: blocks once with the conflict text, then lets the agent stop; the rest becomes a human card", () => {
  const box = new Box();
  const turn = { chat: "c", turn: "t1" };
  const actor = "director/c/t1/sub-editor-x";
  box.fresh.set(actor, [{ id: "n1", changeId: "r.1", text: "Your change r.1 conflicted after your turn: timelineItems/c5/#time" }]);
  const input = { hook_event_name: "SubagentStop", agent_id: "x", agent_type: "editor" };
  const s1 = stopHook({ ...input, stop_hook_active: false }, box, turn);
  assert.equal(s1.decision, "block");
  assert.match(s1.reason!, /r\.1/);
  assert.deepEqual(stopOutput(s1), { decision: "block", reason: s1.reason });
  const s2 = stopHook({ ...input, stop_hook_active: true }, box, turn);
  assert.deepEqual([s2.decision, s2.handedToHuman], ["allow", 1]);
  assert.equal(box.human[0].changeId, "r.1");
  const s3 = stopHook({ ...input, stop_hook_active: false }, box, turn);
  assert.equal(s3.decision, "allow", "nothing new: no second block");
  assert.deepEqual(stopOutput(s3), {});
  assert.deepEqual(box.ended, [actor, actor], "the turn's pins are released when it really ends");
});
