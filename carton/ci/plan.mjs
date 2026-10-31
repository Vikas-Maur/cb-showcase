// The workflow's test matrix: every (group, OS) of groups.json, filtered by the dispatch inputs, so one agent's change
// re-runs only the groups it touches.
//   CARTON_CI_GROUPS=all|core,stores  CARTON_CI_OS=all|linux,windows,macos  node ci/plan.mjs
import fs from "node:fs";
import path from "node:path";

const config = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "groups.json"), "utf8"));
const list = (v) => (!v || v.trim() === "all" ? null : new Set(v.split(/[\s,]+/).filter(Boolean)));
const groups = list(process.env.CARTON_CI_GROUPS);
const oses = list(process.env.CARTON_CI_OS);
for (const g of groups ?? []) if (!config.groups.some((x) => x.name === g)) throw new Error(`no group "${g}" in groups.json`);

const include = [];
for (const g of config.groups)
  for (const os of g.os)
    if ((!groups || groups.has(g.name)) && (!oses || oses.has(os)))
      include.push({ group: g.name, os, runner: config.runners[os], needs: (Array.isArray(g.needs) ? g.needs : (g.needs?.[os] ?? [])).join(" "), timeout: g.timeout ?? 30 });
if (!include.length) throw new Error("nothing to run for these inputs");

const json = JSON.stringify({ include });
console.log(include.map((m) => `${m.group} (${m.os})${m.needs ? " needs " + m.needs : ""}`).join("\n"));
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${json}\n`);
