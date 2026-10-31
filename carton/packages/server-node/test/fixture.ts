// HostFixtures for the conformance suites: the real Node host (with a restart on the same data directory), and the
// in-process reference host.
import type { Role } from "@carton/core/plugins";
import type { HostFixture } from "@carton/conformance";
import { createHmacAuth } from "@carton/server";
import { startNodeHost, createInProcessHost, webSocketTransport, type NodeHost, type NodeHostOptions } from "../src/index.ts";
import { scratch } from "./scratch.ts";

export const PROJECT = "conformance-project";
const SECRET = "test-only-secret-test-only-secret-0123";
let devN = 0;

export function issuer(auth: ReturnType<typeof createHmacAuth>, projectId = PROJECT) {
  return {
    token: (role: Role = "editor") => {
      const account = `acct-${++devN}`;
      return auth.issue({ account, credential: `${account}/dev-${devN}-${Math.random().toString(36).slice(2, 8)}`, role, projectId, ttlMs: 3600_000 });
    },
    tokenFor: (o: { credential: string; account?: string; role?: Role; projectId?: string }) =>
      auth.issue({ account: o.account ?? o.credential.split("/")[0]!, credential: o.credential, role: o.role ?? "editor", projectId: o.projectId ?? projectId, ttlMs: 3600_000 }),
  };
}

export async function nodeFixture(extra: Partial<NodeHostOptions> = {}): Promise<HostFixture & { node(): NodeHost }> {
  const auth = createHmacAuth({ secret: SECRET });
  const dataDir = scratch("host");
  const opts: NodeHostOptions = { dataDir, auth, secret: SECRET, durability: "normal", ...extra };
  let node = await startNodeHost(opts);
  const port = node.port;
  const host = { kind: "node", get url() { return node.urlFor(PROJECT); }, close: () => node.close() };
  return {
    host,
    transport: webSocketTransport({ keepaliveMs: 0 }),
    auth,
    ...issuer(auth),
    node: () => node,
    async restart() {
      await node.close();
      node = await startNodeHost({ ...opts, port });
    },
    async rows() {
      return node.room(PROJECT)?.storage.stats() ?? { rowsRead: 0, rowsWritten: 0 };
    },
    close: () => node.close(),
  };
}

export async function inProcessFixture(): Promise<HostFixture> {
  const auth = createHmacAuth({ secret: SECRET });
  const { host, transport, inner } = createInProcessHost({ auth, projectId: PROJECT });
  return {
    host,
    transport,
    auth,
    ...issuer(auth),
    async rows() {
      const st = inner.sequencer.stats; // live getters: copy the numbers
      return { rowsRead: st.rowsRead, rowsWritten: st.rowsWritten };
    },
    close: () => host.close(),
  };
}
