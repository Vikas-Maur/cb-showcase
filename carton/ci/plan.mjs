// The workflow's test matrix: every (group, OS) of groups.json, filtered so one agent's change re-runs only the
// groups it touches. The filter comes from the dispatch inputs, or on a push from a tag in the head commit's message,
// `[carton-ci groups=core,stores os=windows]` (a workflow that isn't on the default branch can't be dispatched).
//   CARTON_CI_GROUPS=all|core,stores  CARTON_CI_OS=all|linux,windows,macos  CARTON_CI_MESSAGE=<commit message>
//   node ci/plan.mjs
import fs from "node:fs";
import path from "node:path";

const config = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "groups.json"), "utf8"));
const list = (v) => (!v || v.trim() === "all" ? null : new Set(v.split(/[\s,]+/).filter(Boolean)));
const tag = /\[carton-ci\b([^\]]*)\]/.exec(process.env.CARTON_CI_MESSAGE ?? "")?.[1] ?? "";
const fromTag = (k) => new RegExp(`\\b${k}=([\\w,-]+)`).exec(tag)?.[1];
const groups = list(process.env.CARTON_CI_GROUPS || fromTag("groups"));
const oses = list(process.env.CARTON_CI_OS || fromTag("os"));
for (const g of groups ?? []) if (!config.groups.some((x) => x.name === g)) throw new Error(`no group "${g}" in groups.json`);
for (const os of oses ?? []) if (!config.runners[os]) throw new Error(`no system "${os}" (known: ${Object.keys(config.runners).join(", ")})`);

const include = [];
for (const g of config.groups)
  for (const os of g.os)
    if ((!groups || groups.has(g.name)) && (!oses || oses.has(os)))
      include.push({ group: g.name, os, runner: config.runners[os], needs: (Array.isArray(g.needs) ? g.needs : (g.needs?.[os] ?? [])).join(" "), timeout: g.timeout ?? 30 });
if (!include.length) throw new Error("nothing to run for these inputs");

const json = JSON.stringify({ include });
console.log(include.map((m) => `${m.group} (${m.os})${m.needs ? " needs " + m.needs : ""}`).join("\n"));
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${json}\n`);
