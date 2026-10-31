// The host, transport and storage suites on server-node, and on @carton/server's in-process reference host.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { sequencerHostSuite, transportSuite, sequencerStorageSuite } from "@carton/conformance";
import { nodeSqliteStorage, type NodeSqliteStorage } from "../src/index.ts";
import { nodeFixture, inProcessFixture } from "./fixture.ts";
import { scratch } from "./scratch.ts";

sequencerHostSuite("server-node", () => nodeFixture());
transportSuite("server-node (WebSocket)", () => nodeFixture());
sequencerHostSuite("in-process (@carton/server)", inProcessFixture);
transportSuite("in-process", inProcessFixture);

const dir = scratch("storage");
sequencerStorageSuite("node:sqlite", async () => nodeSqliteStorage(join(dir, "s.db")), {
  reopen: async (s) => {
    (s as NodeSqliteStorage).close();
    return nodeSqliteStorage(join(dir, "s.db"));
  },
  close: async (s) => {
    (s as NodeSqliteStorage).close();
    rmSync(dir, { recursive: true, force: true });
  },
});
