// The system suite (quick: P9, chaos and G1 left out) with the sequencer on doSqlStorage, the Durable Object's
// adapter, over an emulated ctx.storage.sql: the suite needs a fresh database per simulated world, synchronously,
// which only a process with node:sqlite can give. Inside real workerd the same adapter runs the storage checks, the
// host and transport suites, the host behaviour suite and live sync (workerd.test.ts).
import { systemSuite, sequencerStorageSuite } from "@carton/conformance";
import { doSqlStorage } from "../src/storage.ts";
import { emulatedDoStorage } from "./do-sql-emulation.ts";

sequencerStorageSuite("doSqlStorage over the emulated ctx.storage.sql", async () => doSqlStorage(emulatedDoStorage()));
systemSuite("DO SQL adapter (doSqlStorage)", { storage: () => doSqlStorage(emulatedDoStorage()), quick: true });
