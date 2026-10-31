// The workflows' matrices. Tests (carton-ci.yml): every (group, OS) of groups.json, filtered so one agent's change
// re-runs only the groups it touches. The filter comes from the dispatch inputs, or on a push from a tag in the head
// commit's message, `[carton-ci groups=core,stores os=windows]` (a workflow that isn't on the default branch can't be
// dispatched). Measurements (carton-measure.yml, `--measure`): the ids of measure.json named by
// `[carton-measure ids=a,b]` or `[carton-measure agents=stores,ui]`, all of them for a bare `[carton-measure]`.
//   CARTON_CI_GROUPS=all|core,stores  CARTON_CI_OS=all|linux,windows,macos  CARTON_CI_MESSAGE=<commit message>
//   node ci/plan.mjs [--measure]
import fs from "node:fs";
import path from "node:path";

const list = (v) => (!v || v.trim() === "all" ? null : new Set(v.split(/[\s,]+/).filter(Boolean)));
const tagOf = (name) => new RegExp(`\\[${name}\\b([^\\]]*)\\]`).exec(process.env.CARTON_CI_MESSAGE ?? "")?.[1];
const field = (tag, k) => new RegExp(`\\b${k}=([\\w,-]+)`).exec(tag ?? "")?.[1];
const include = [];

if (process.argv.includes("--measure")) {
  const config = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "measure.json"), "utf8"));
  const tag = tagOf("carton-measure");
  if (tag === undefined) throw new Error("no [carton-measure …] tag in the head commit's message");
  const ids = list(field(tag, "ids"));
  const agents = list(field(tag, "agents"));
  for (const x of ids ?? []) if (!config.measurements.some((m) => m.id === x)) throw new Error(`no measurement "${x}" in measure.json`);
  for (const x of agents ?? []) if (!config.measurements.some((m) => m.agent === x)) throw new Error(`no measurement of agent "${x}" in measure.json`);
  for (const m of config.measurements)
    if ((!ids || ids.has(m.id)) && (!agents || agents.has(m.agent))) include.push({ id: m.id, agent: m.agent, needs: (m.needs ?? []).join(" "), timeout: m.timeout ?? 60 });
} else {
  const config = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "groups.json"), "utf8"));
  const tag = tagOf("carton-ci");
  const groups = list(process.env.CARTON_CI_GROUPS || field(tag, "groups"));
  const oses = list(process.env.CARTON_CI_OS || field(tag, "os"));
  for (const g of groups ?? []) if (!config.groups.some((x) => x.name === g)) throw new Error(`no group "${g}" in groups.json`);
  for (const os of oses ?? []) if (!Object.hasOwn(config.runners, os)) throw new Error(`no system "${os}" (known: ${Object.keys(config.runners).join(", ")})`);
  for (const g of config.groups)
    for (const os of g.os)
      if ((!groups || groups.has(g.name)) && (!oses || oses.has(os)))
        include.push({ group: g.name, os, runner: config.runners[os], needs: (Array.isArray(g.needs) ? g.needs : (g.needs?.[os] ?? [])).join(" "), timeout: g.timeout ?? 30 });
}
if (!include.length) throw new Error("nothing to run for these inputs");

const json = JSON.stringify({ include });
console.log(include.map((m) => `${m.group ?? m.id} (${m.os ?? m.agent})${m.needs ? " needs " + m.needs : ""}`).join("\n"));
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${json}\n`);
