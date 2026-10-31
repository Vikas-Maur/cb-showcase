// Late-conflict notices in carton.db for the Stop/SubagentStop hook: blocks once per conflict set even across hook
// processes, then hands what's left to the person (§6.2, R3-09); the hook-command form for host Claude Code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore } from "@carton/store-memory";
import { StoreNoticeBox, humanCards } from "../src/notices.ts";
import { stopHook } from "../src/hooks.ts";
import { runHook, hookSettings, turnFromEnv } from "../src/hook-cli.ts";
import { actorKey } from "../src/writes.ts";
import { parseActorId } from "../src/identity.ts";

const seed = async (store: ReturnType<typeof createMemoryStore>, actorId: string, change: string) => {
  const a = parseActorId(actorId)!;
  await store.write([{ table: "notices", key: [actorKey(a), 1000, 0], value: { to: actorKey(a), kind: "late-conflict", change, text: `Your change ${change} conflicted after your turn: timelineItems/c5/#time`, cards: [{ kind: "group", path: "timelineItems/c5/#time", base: 1, ours: 2, theirs: 3 }] } }]);
};

test("StoreNoticeBox: block once, then hand the rest to the person; state survives a new box (a new hook process)", async () => {
  const data = createMemoryStore();
  const actor = "director/c1/t1/sub-editor-a1";
  await seed(data, actor, "r.1");
  const turn = { chat: "c1", turn: "t1" };
  const input = { hook_event_name: "SubagentStop", session_id: "s", agent_id: "a1", agent_type: "editor" };
  const s1 = await new StoreNoticeBox(data).run(actor, (b) => stopHook({ ...input, stop_hook_active: false }, b, turn));
  assert.equal(s1.decision, "block");
  assert.match(s1.reason!, /r\.1/);
  // a second Stop without stop_hook_active (the agent tried to stop again) doesn't block on the same set
  const s1b = await new StoreNoticeBox(createMemoryStore({ shared: data.data })).run(actor, (b) => stopHook({ ...input, stop_hook_active: false }, b, turn));
  assert.equal(s1b.decision, "allow", "blocked at most once per conflict set");
  const s2 = await new StoreNoticeBox(createMemoryStore({ shared: data.data })).run(actor, (b) => stopHook({ ...input, stop_hook_active: true }, b, turn));
  assert.deepEqual([s2.decision, s2.handedToHuman], ["allow", 1]);
  const cards = await humanCards(data);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].change, "r.1");
  assert.equal(cards[0].from, actor);
  // a new conflict later in the same turn blocks again (a new set)
  await seed(data, actor, "r.2");
  const s3 = await new StoreNoticeBox(data).run(actor, (b) => stopHook({ ...input, stop_hook_active: false }, b, turn));
  assert.equal(s3.decision, "block");
  assert.match(s3.reason!, /r\.2/);
  assert.doesNotMatch(s3.reason!, /r\.1/);
});

test("hook commands: pre-tool-use rewrites cb calls; stop reads the project's notices; turn from CARDBOARD_ACTOR", async () => {
  assert.deepEqual(turnFromEnv({ CARDBOARD_ACTOR: "director/c9/t2/sub-x-y" }), { chat: "c9", turn: "t2" });
  const pre: any = await runHook("pre-tool-use", { session_id: "abcdef1234", tool_input: { command: "cb history Demo" }, agent_id: "q", agent_type: "editor" }, { env: {} });
  assert.equal(pre.hookSpecificOutput.updatedInput.command, "export CARDBOARD_ACTOR='claude-code/abcdef12/sub-editor-q'; cb history Demo");
  assert.deepEqual(await runHook("pre-tool-use", { tool_input: { command: "ls" } }, { env: {} }), {});
  const store = createMemoryStore();
  await seed(store, "claude-code/abcdef12", "r.9");
  const stop: any = await runHook("stop", { hook_event_name: "Stop", session_id: "abcdef1234", stop_hook_active: false }, { env: {}, openStore: async () => createMemoryStore({ shared: store.data }) });
  assert.equal(stop.decision, "block");
  assert.deepEqual(await runHook("stop", { hook_event_name: "Stop", session_id: "abcdef1234" }, { env: {}, openStore: async () => null }), {});
  const s: any = hookSettings({ command: "carton", projectDir: "/Users/x/Movies/My Project.cardboard" });
  assert.equal(s.hooks.PreToolUse[0].matcher, "Bash");
  assert.equal(s.hooks.SubagentStop[0].hooks[0].command, "carton hook stop --project '/Users/x/Movies/My Project.cardboard'");
  // nothing in a path is expanded by the shell: single quotes, a quote inside escaped
  const evil = hookSettings({ command: "carton", projectDir: "/p/$(touch pwned)/it's" }) as any;
  assert.equal(evil.hooks.Stop[0].hooks[0].command, "carton hook stop --project '/p/$(touch pwned)/it'\\''s'");
});
