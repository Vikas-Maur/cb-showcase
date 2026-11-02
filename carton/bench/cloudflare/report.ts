// The report's tables, printed from measured.json (so no number is copied by hand): the cost inputs with n, median,
// range and every run's value, then the speeds and the limits.
//
//   node bench/cloudflare/report.ts [measured.json] > tables.md
import { readFileSync } from "node:fs";
import { join } from "node:path";

const m = JSON.parse(readFileSync(process.argv[2] ?? join(import.meta.dirname, "results", "measured.json"), "utf8"));
const fmt = (x: unknown) => (typeof x === "number" ? (Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 1 ? x.toFixed(2) : x === 0 ? "0" : x.toPrecision(3)) : x === null || x === undefined ? "–" : String(x));
const p = (s: string) => console.log(s);

p("### Cost inputs\n");
p("| input | value | unit | status | n | min – max | every run |");
p("|---|---|---|---|---|---|---|");
for (const [k, v] of Object.entries<any>(m.inputs)) p(`| \`${k}\` | ${fmt(v.value)} | ${v.unit} | ${v.status} | ${v.n} | ${v.min !== undefined ? `${fmt(v.min)} – ${fmt(v.max)}` : "–"} | ${(v.values ?? []).map(fmt).join(", ") || "–"} |`);
p("\n### Speeds\n");
p("| id | network | storage | parties | MB | metric | p50 | p90 | p99 | unit | runs | note |");
p("|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const s of m.speeds) p(`| ${s.id} | ${s.network} | ${s.storage} | ${s.parties ?? "–"} | ${s.sizeMB ?? "–"} | ${s.metric} | ${fmt(s.p50)} | ${fmt(s.p90)} | ${fmt(s.p99)} | ${s.unit} | ${s.runs} | ${String(s.note ?? "").replace(/\|/g, "/")} |`);
p("\n### Limits\n");
p("| id | value | observed | Carton |");
p("|---|---|---|---|");
for (const l of m.limits) p(`| ${l.id} (${l.status}) | ${l.value} | ${l.observed} | ${l.carton} |`);
