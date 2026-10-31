// One writer process of the cross-process CAS test (port of proofs/sqlite-check.js). It appends `count` changes the
// way the local sequencer does: read the head, then a conditional batch that writes [cut, head + 1] only if that key
// is still absent, retrying on false. It also measures how long its event loop stalled.
// argv: <db path> <writer name> <count>
import { openSqliteStore } from "../src/index.ts";

const [file, name, countArg] = process.argv.slice(2);
const count = Number(countArg);
const store = await openSqliteStore(file);

let last = performance.now();
let maxStall = 0;
const beat = setInterval(() => {
  const now = performance.now();
  maxStall = Math.max(maxStall, now - last);
  last = now;
}, 1);

// Start together: say ready, then wait for the parent's "go" (sent once every writer is ready), so a slow process
// start (Electron on Windows) can't let one writer finish before another begins.
process.stdout.write("ready\n");
await new Promise<void>((resolve) => {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => String(d).includes("go") && resolve());
});
process.stdin.pause();
last = performance.now();

let lostRaces = 0;
for (let i = 0; i < count; i++) {
  const id = `${name}.${i}`;
  for (;;) {
    const top = await store.range("changes", { prefix: ["main"], reverse: true, limit: 1 });
    const seq = (top.length ? (top[0].key[1] as number) : 0) + 1;
    const ok = await store.write(
      [{ table: "changes", key: ["main", seq], value: { id, seq, author: name } }, { table: "ids", key: [id], value: ["main", seq] }],
      [{ table: "changes", key: ["main", seq], expect: "absent" }],
    );
    if (ok) break;
    lostRaces++;
  }
  // A store call that finds no lock resolves without yielding; yield between appends, as an engine thread serves
  // other work between commits, so the heartbeat measures only time spent inside the store.
  await new Promise((r) => setImmediate(r));
}
clearInterval(beat);
const busyRetries = store.db.busyRetries;
await store.close();
process.stdout.write(JSON.stringify({ name, maxStallMs: Math.round(maxStall * 10) / 10, busyRetries, lostRaces }) + "\n");
