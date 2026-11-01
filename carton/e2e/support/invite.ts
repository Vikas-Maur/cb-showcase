// What an invite carries to a machine that holds nothing of the project (§0.1 "Invite to edit"): the shared cut's
// record and its root (state at seq 0) with the root's hash, read from the inviting machine's carton.db while its app
// runs. The joiner opens Carton with `init: {join}` (core) and gets every row from the host.
//   invite <carton.db>    prints {projectId, cut, doc0, rootHash}
import { Carton, hashDoc } from "@carton/core";
import type { HostAdapter } from "@carton/core";
import { openSqliteStore } from "@carton/store-sqlite";
import { cardboardAdapter } from "@carton/cardboard";
import { nodeHasher } from "@carton/local";

const [dbPath] = process.argv.slice(2);
const store = await openSqliteStore(dbPath!);
try {
  const carton = await Carton.open({ adapter: cardboardAdapter as HostAdapter, store, hasher: nodeHasher, actor: { kind: "system", id: "invite", name: "Invite" } });
  const cut = (await carton.cuts()).find((c) => c.id === carton.cut)!;
  const doc0 = await carton.checkout({ branchId: cut.id, seq: 0 });
  process.stdout.write(JSON.stringify({ projectId: carton.projectId, cut, doc0, rootHash: hashDoc(doc0, carton.schema) }) + "\n");
  await carton.close();
} finally {
  await store.close();
}
