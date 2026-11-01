// Plans a carton-agent.yml run: the groups an agent asked for in its pushed commit's `CI-Groups:` trailer.
//
//   CI-Groups: cardboard-real:windows, conformance:linux, core
//
// Each entry is a group of carton/ci/groups.json, optionally `:<os>` (linux, windows, macos); a group without an OS
// runs on every system the group lists. Entries are separated by commas or spaces; several trailer lines add up.
// No trailer, or `CI-Groups: none`: nothing runs (the matrix is empty and the workflow's test job is skipped).
// A name that isn't a group, or an OS the group doesn't run on, fails the plan with the list of what exists.
//
//   CARTON_CI_MESSAGE=<head commit message> node ci/plan-agent.mjs
import fs from "node:fs";
import path from "node:path";

const config = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "groups.json"), "utf8"));
const message = process.env.CARTON_CI_MESSAGE ?? "";
const entries = [...message.matchAll(/^CI-Groups:[ \t]*(.*)$/gim)].flatMap((m) => m[1].split(/[\s,]+/).filter(Boolean));
const known = config.groups.map((g) => `${g.name} (${g.os.join(", ")})`).join("; ");

const include = [];
const seen = new Set();
for (const e of entries) {
  if (e.toLowerCase() === "none") continue;
  const [name, os] = e.split(":");
  const g = config.groups.find((x) => x.name === name);
  if (!g) throw new Error(`CI-Groups: no group "${name}". Groups: ${known}`);
  if (os && !g.os.includes(os)) throw new Error(`CI-Groups: group "${name}" doesn't run on "${os}" (it runs on ${g.os.join(", ")})`);
  for (const o of os ? [os] : g.os) {
    if (seen.has(`${name}:${o}`)) continue;
    seen.add(`${name}:${o}`);
    include.push({ group: name, os: o, runner: config.runners[o], needs: (Array.isArray(g.needs) ? g.needs : (g.needs?.[o] ?? [])).join(" "), timeout: g.timeout ?? 30 });
  }
}

console.log(include.length ? include.map((m) => `${m.group} (${m.os})${m.needs ? " needs " + m.needs : ""}`).join("\n") : "no CI-Groups trailer: nothing to run");
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify({ include })}\n`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `count=${include.length}\n`);
}
