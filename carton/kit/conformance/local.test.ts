// Template: copy it into your repo and swap the lines marked "← your …" for your own.
// Check that your Store can carry the local sync lease (one helper per machine, fenced writes), and that your
// identity sources keep the IdentitySource invariants. store-sqlite stands in for your Store.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { leaseSuite, identitySuite, localSuite } from "@carton/conformance";
import { openSqliteStore, type SqliteStore } from "@carton/store-sqlite"; // ← your Store
import { identitySources } from "@carton/local";
import { cardboardIdentity } from "@carton/cardboard";

const root = process.env.CARTON_SCRATCH ?? join(tmpdir(), "carton-conformance");
mkdirSync(root, { recursive: true });
const dir = mkdtempSync(join(root, "local-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const fresh = () => openSqliteStore(join(dir, `lease-${++n}`, "carton.db"));

// `second`: another process's handle on the same carton.db, so the takeover races run across handles.
leaseSuite("my-store", fresh, { second: (s) => openSqliteStore((s as SqliteStore).path) });

// Your identity sources, first match wins (default: @carton/local's identitySources()).
identitySuite("my-identity-chain", [cardboardIdentity, ...identitySources()]);

// Both at once, as the skeleton named it: the lease cases plus the default identity sources.
localSuite({ name: "my-store (localSuite)", makeStore: fresh, second: (s) => openSqliteStore((s as SqliteStore).path) });
