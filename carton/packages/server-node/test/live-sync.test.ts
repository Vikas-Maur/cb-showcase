// Two real sync clients (core's ReplicaQueue + SyncClient) through server-node over WebSocket, and through the
// in-process host: they converge through a clash, and on server-node through a restart.
import { liveSyncSuite } from "@carton/conformance";
import { nodeFixture, inProcessFixture } from "./fixture.ts";

liveSyncSuite("server-node (WebSocket)", () => nodeFixture());
liveSyncSuite("in-process", inProcessFixture);
