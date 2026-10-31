// Emits dist/ (JS + .d.ts) for every package, dependencies first. In the workspace the packages run from their .ts
// sources; dist/ is only for publishing (each package's publishConfig.exports points at it). A package's
// tsconfig.build.json maps the other @carton packages to their built .d.ts, so each build sees only its own sources.
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const only = process.argv.slice(2);
const pkgs = new Map();
for (const dir of readdirSync(join(root, "packages"))) {
  const pkg = JSON.parse(readFileSync(join(root, "packages", dir, "package.json"), "utf8"));
  pkgs.set(pkg.name, { dir, deps: Object.keys(pkg.dependencies ?? {}).filter((d) => d.startsWith("@carton/")) });
}
const order = [];
const seen = new Set();
const visit = (name, stack = []) => {
  if (seen.has(name)) return;
  if (stack.includes(name)) throw new Error(`dependency cycle: ${[...stack, name].join(" -> ")}`);
  for (const d of pkgs.get(name).deps) visit(d, [...stack, name]);
  seen.add(name);
  order.push(name);
};
for (const name of pkgs.keys()) visit(name);
const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
for (const name of order) {
  const { dir } = pkgs.get(name);
  if (only.length && !only.includes(dir)) continue;
  rmSync(join(root, "packages", dir, "dist"), { recursive: true, force: true });
  process.stdout.write(`build ${name}\n`);
  execFileSync(process.execPath, [tsc, "-p", join(root, "packages", dir, "tsconfig.build.json")], { stdio: "inherit" });
}
