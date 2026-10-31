// The node host for hosts-schema.ts's H-SV check, in a process of its own, as a host runs for real. The test can always
// end it: a host left open in the test's own process (a close that never returns, a hook that never ran) keeps
// node --test from exiting, and CI waits out its step timeout (route 36: 20 minutes on Windows).
// Started with no `schemaVersion`, the default under test. argv: the data folder; env HSV_SECRET: the test's secret.
// Prints one JSON line, {"url"} (project "p") or {"error"}; when its stdin ends, closes the host and exits.
interface NodeHostModule {
  startNodeHost(opts: Record<string, unknown>): Promise<{ urlFor(projectId: string): string; close(): Promise<void> }>;
}
interface ServerModule {
  createHmacAuth(opts: { secret: string }): unknown;
}
/** A module by a specifier the type checker doesn't follow: the hosts' real code is only in some workspaces. */
const load = async <T>(spec: string): Promise<Partial<T>> => (await import(spec)) as Partial<T>;

const say = (line: Record<string, unknown>) => process.stdout.write(JSON.stringify(line) + "\n");
const dataDir = process.argv[2];
const secret = process.env.HSV_SECRET;
try {
  if (!dataDir || !secret) throw new Error("usage: hsv-node-host.ts <dataDir>, with HSV_SECRET set");
  const { startNodeHost } = await load<NodeHostModule>("@carton/server-node");
  const { createHmacAuth } = await load<ServerModule>("@carton/server");
  if (!startNodeHost || !createHmacAuth) throw new Error("server-node's startNodeHost or @carton/server's createHmacAuth moved: update hosts-schema.ts");
  const host = await startNodeHost({ dataDir, auth: createHmacAuth({ secret }), secret, durability: "normal" }); // no schemaVersion
  process.stdin.once("end", () => {
    host.close().then(
      () => process.exit(0),
      (e: unknown) => {
        console.error("the host's close failed:", e);
        process.exit(1);
      },
    );
  });
  process.stdin.resume();
  say({ url: host.urlFor("p") });
} catch (e) {
  say({ error: e instanceof Error ? (e.stack ?? e.message) : String(e) });
  process.exit(1);
}
