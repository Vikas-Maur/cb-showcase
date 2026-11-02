// The Stop/SubagentStop hook as its own process, as host Claude Code runs it per event (`carton hook stop`): reads the
// hook input on stdin, decides against the project's carton.db, prints Claude Code's hook output.
//   stop-hook <projectDir> <projectId>     env: CARDBOARD_ACTOR (the Director turn)
import { openProjectStore } from "@carton/store-sqlite";
import { runHook } from "../../src/hook-cli.ts";

const [projectDir, projectId] = process.argv.slice(2);
let s = "";
for await (const c of process.stdin) s += c;
const out = await runHook("stop", JSON.parse(s || "{}"), { openStore: async () => (await openProjectStore({ bundleDir: projectDir, projectId, skipLinkProbe: true })).store });
process.stdout.write(JSON.stringify(out) + "\n");
