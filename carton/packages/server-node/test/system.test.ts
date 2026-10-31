// sync-sequencer's suites on this host: the whole system suite (system-v11's tests, H1–H4, the v12 rules, P9) with
// the sequencer on server-node's own storage, and the host behaviour suite over this host's WebSocket transport.
import { systemSuite, hostSuite } from "@carton/conformance";
import { nodeSqliteStorage } from "../src/index.ts";
import { nodeFixture } from "./fixture.ts";

systemSuite("server-node storage (node:sqlite)", { storage: () => nodeSqliteStorage(":memory:") });
hostSuite("server-node (WebSocket)", () => nodeFixture());
