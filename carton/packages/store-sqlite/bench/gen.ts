// Build a carton.db with `changes` confirmed changes on one cut, the id index, and a keyframe every 64 changes.
// usage: node bench/gen.ts <file> <changes> <keyframe items>
import * as fs from "node:fs";
import { openSqliteStore } from "../src/index.ts";
import { change, doc } from "./fixture.ts";

const [file, nArg, kfArg] = process.argv.slice(2);
const N = Number(nArg), KF = 64;
for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
const s = await openSqliteStore(file);
const cut = "c0ffee00c0ffee00";
const kf = doc(Number(kfArg));
await s.write([
  { table: "meta", key: ["projectId"], value: "bench-project" },
  { table: "cuts", key: [cut], value: { id: cut, name: "Main cut", forkOf: null, owner: "ana", kind: "main", protected: false, sequencer: { local: "store" } } },
  { table: "keyframes", key: [cut, 0], value: kf },
]);
for (let seq = 1; seq <= N; seq += 1000) {
  const ws = [];
  for (let i = seq; i < Math.min(seq + 1000, N + 1); i++) {
    const c = change(i, cut);
    ws.push({ table: "changes", key: [cut, i], value: c }, { table: "ids", key: [c.id], value: [cut, i] });
    if (i % KF === 0) ws.push({ table: "keyframes", key: [cut, i], value: kf });
  }
  await s.write(ws);
}
s.db.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
await s.close();
console.log(JSON.stringify({ file, changes: N, keyframeItems: Number(kfArg), bytes: fs.statSync(file).size }));
