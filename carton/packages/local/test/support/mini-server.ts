// A stand-in sequencer for the local runtime's process tests, until `@carton/server` and `server-node` land: one
// branch, dedup by change id (an already-confirmed id is acked as a duplicate with its seq, R3-01), hello with the
// confirmed list of the client's pending ids (R10-01), fan-out of new rows. JSON lines over TCP on 127.0.0.1.
//   mini-server <portFile> [--hold-first-push-ms N --hold-marker M]
// The hold knob delays the first push whose change carries marker M (a stalled retransmit from a dying helper).
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { writeFileSync } from "node:fs";

const [portFile, ...rest] = process.argv.slice(2);
const opt = (k: string) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
const holdMs = Number(opt("--hold-first-push-ms") ?? 0);
const holdMarker = opt("--hold-marker");
let held = false;

interface Row { seq: number; id: string; author: unknown; ops: unknown[]; by: number }
const rows: Row[] = [];
const ids = new Map<string, number>();
const stats = { pushes: 0, accepts: 0, duplicates: 0, log: [] as { t: number; id: string; from: number; dup: boolean }[] };
const conns = new Set<{ s: Socket; pid: number }>();

const send = (s: Socket, m: object) => { if (!s.destroyed) s.write(JSON.stringify(m) + "\n"); };

function onPush(c: { s: Socket; pid: number }, m: any) {
  stats.pushes++;
  for (const ch of m.changes) {
    const dup = ids.has(ch.id);
    stats.log.push({ t: Date.now(), id: ch.id, from: c.pid, dup });
    if (dup) { stats.duplicates++; send(c.s, { type: "ack", id: ch.id, seq: ids.get(ch.id), epoch: m.epoch, duplicate: true }); continue; }
    const row: Row = { seq: rows.length + 1, id: ch.id, author: ch.author, ops: ch.ops, by: c.pid };
    rows.push(row);
    ids.set(ch.id, row.seq);
    stats.accepts++;
    send(c.s, { type: "ack", id: ch.id, seq: row.seq, epoch: m.epoch });
    for (const o of conns) if (o !== c) send(o.s, { type: "changes", rows: [row] });
  }
}

const srv = createServer((s) => {
  s.setEncoding("utf8");
  s.setNoDelay(true);
  const c = { s, pid: 0 };
  conns.add(c);
  let buf = "";
  s.on("data", (d: string) => {
    buf += d;
    for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      if (m.type === "hello") {
        c.pid = m.pid ?? 0;
        const confirmed = (m.pending ?? []).filter((id: string) => ids.has(id)).map((id: string) => ({ id, seq: ids.get(id) }));
        send(s, { type: "hello", rows: rows.slice(m.have ?? 0), confirmed, head: rows.length });
      } else if (m.type === "push") {
        if (holdMs && !held && holdMarker && m.changes.some((ch: any) => JSON.stringify(ch.ops).includes(holdMarker))) {
          held = true;
          setTimeout(() => onPush(c, m), holdMs);
        } else onPush(c, m);
      } else if (m.type === "stats") send(s, { type: "stats", rows: rows.map((r) => ({ seq: r.seq, id: r.id, by: r.by })), ...stats });
    }
  });
  s.on("error", () => {});
  s.on("close", () => conns.delete(c));
});
srv.listen(0, "127.0.0.1", () => {
  const a = srv.address();
  writeFileSync(portFile, String(typeof a === "object" && a ? a.port : 0));
});
// never outlive the test run
setTimeout(() => process.exit(0), Number(opt("--lifetime-ms") ?? 120000)).unref();
