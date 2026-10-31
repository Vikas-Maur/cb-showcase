// The host behaviour suite against the in-process host (createInProcessHost from @carton/server), with a restart
// that builds a new host on the same storage (what a Durable Object's wake or a Node restart does).
import type { AuthContext, AuthProvider } from "@carton/core/plugins";
import { createInProcessHost, type InProcessHost } from "@carton/server";
import { hostSuite } from "../../src/system/host-suite.ts";
import { sqliteStorage } from "../../src/system/sqlite.ts";

hostSuite("in-process", async () => {
  const tokens = new Map<string, AuthContext>();
  const auth: AuthProvider = { kind: "table", async verify(t) { return tokens.get(t) ?? null; } };
  const storage = sqliteStorage();
  let host: InProcessHost = createInProcessHost({ storage, auth, name: "suite" });
  let n = 0;
  return {
    get host() { return host; },
    get transport() { return host.transport; },
    auth,
    async token(role = "editor") {
      const t = `tok-${++n}`;
      tokens.set(t, { account: `acct-${n}`, credential: `acct-${n}/device-${n}`, role, projectId: "p", expires: Date.now() + 3600_000 });
      return t;
    },
    async restart() {
      await host.close();
      host = createInProcessHost({ storage, auth, name: "suite" });
    },
    async close() {
      await host.close();
      storage.close();
    },
  };
});
