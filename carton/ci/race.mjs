// P10 (PLAN §6.4) on the runner's file system: the portable matrix of bench/race/race.ts, small, on the shipped
// displace-then-install code. NTFS on Windows and APFS on macOS were open (cardboard-adapter's notes).
//   node ci/race.mjs [--trials 1] [--rounds 2000]
// Fails when the shipped protocol (displace, temp+rename writers) lost any foreign write. The controls (naive,
// hardlink) are expected to lose some; with few rounds they may not, which only means the window wasn't hit, so they
// are reported, not gated. In-place writers are measured, not proved safe (L19): reported, not gated. A hosted runner
// is a shared VM, so the timings here are informational only.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CARTON, OS, dirs, machine, summary } from "./env.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const trials = opt("--trials", "1");
const rounds = opt("--rounds", "2000");
const dir = path.join(dirs.root, "carton-race");
fs.mkdirSync(dir, { recursive: true });
fs.mkdirSync(dirs.results, { recursive: true });

function fsType(d) {
  const out = (cmd, a) => spawnSync(cmd, a, { encoding: "utf8" }).stdout?.trim() ?? "";
  if (OS === "windows") return out("powershell.exe", ["-NoProfile", "-Command", `(Get-Volume -FilePath '${d}').FileSystemType`]) || "unknown";
  if (OS === "macos") {
    const dev = out("df", [d]).split("\n").at(-1)?.split(/\s+/)[0];
    return /\((\w+)/.exec(out("mount", []).split("\n").find((l) => l.startsWith(dev + " ")) ?? "")?.[1] ?? "unknown";
  }
  return out("findmnt", ["-n", "-o", "FSTYPE", "--target", d]) || out("stat", ["-f", "-c", "%T", d]) || "unknown";
}

const fsLabel = `${OS}-${fsType(dir)}`;
const out = path.join(dirs.results, `race-${OS}.jsonl`);
fs.rmSync(out, { force: true });
const race = path.join(CARTON, "bench", "race");
console.log(`P10 race: ${fsLabel} at ${dir}, ${trials} trial(s) x ${rounds} rounds per config`);
const r = spawnSync(process.execPath, ["race.ts", "--dir", dir, "--fs", fsLabel, "--trials", trials, "--rounds", rounds, "--out", out], { cwd: race, stdio: "inherit" });
if (r.status !== 0) throw new Error(`race.ts exited ${r.status ?? r.signal}`);
const table = spawnSync(process.execPath, ["summarize.ts", out], { cwd: race, encoding: "utf8" });
console.log(table.stdout);

const rows = fs.readFileSync(out, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const lostOf = (x) => x.lostByEngine ?? (x.mode === "turn" ? x.unaccounted : 0);
const totals = (pred) => {
  const l = rows.filter(pred);
  return { trials: l.length, rounds: l.reduce((a, x) => a + (x.rounds ?? 0), 0), writes: l.reduce((a, x) => a + (x.landed ?? 0), 0), lost: l.reduce((a, x) => a + lostOf(x), 0), busy: l.reduce((a, x) => a + (x.busy ?? 0), 0), eexist: l.reduce((a, x) => a + (x.eexist ?? 0), 0) };
};
const renameRows = (p) => (x) => x.protocol === p && x.style === "rename" && x.writers > 0 && !x.settle;
const result = {
  machine: machine(),
  fs: fsLabel,
  trials: Number(trials),
  rounds: Number(rounds),
  displace: totals(renameRows("displace")),
  naive: totals(renameRows("naive")),
  hardlink: totals(renameRows("hardlink")),
  inplaceSettle2: totals((x) => x.protocol === "displace" && x.style === "inplace" && x.settle === 2),
};
fs.writeFileSync(path.join(dirs.results, `race-${OS}.json`), JSON.stringify(result, null, 1));

const ok = result.displace.trials > 0 && result.displace.lost === 0;
const line = (name, t) => `| ${name} | ${t.trials} | ${t.rounds} | ${t.writes} | **${t.lost}** | ${t.eexist} | ${t.busy} |`;
summary(
  `### P10 race on ${fsLabel} (${trials} trial(s) x ${rounds} rounds per config)\n\n${ok ? "✅" : "❌"} shipped \`displace\`: ${result.displace.lost} of ${result.displace.writes} foreign writes lost by the engine\n\n` +
    `| protocol (temp+rename writers) | trials | engine rounds | foreign writes | lost by the engine | EEXIST retries | busy retries |\n|---|---|---|---|---|---|---|\n` +
    [line("displace (shipped)", result.displace), line("naive (control)", result.naive), line("hardlink (control)", result.hardlink), line("displace + settle 2, in-place writers (measured)", result.inplaceSettle2)].join("\n") +
    "\n\n<details><summary>race.ts tables</summary>\n\n" + table.stdout + "\n</details>\n",
);
console.log(`${ok ? "PASS" : "FAIL"}: displace lost ${result.displace.lost} of ${result.displace.writes} foreign writes (${result.displace.trials} trials); controls lost naive ${result.naive.lost}, hardlink ${result.hardlink.lost}`);
process.exitCode = ok ? 0 : 1;
