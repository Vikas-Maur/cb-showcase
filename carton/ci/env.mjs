// Where CI puts things. On a GitHub runner everything goes under $RUNNER_TEMP; run elsewhere, under the OS temp dir.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const OS = { linux: "linux", win32: "windows", darwin: "macos" }[process.platform] ?? process.platform;
export const CARTON = path.resolve(import.meta.dirname, "..");
export const REPO = path.resolve(CARTON, "..");

const root = process.env.RUNNER_TEMP || path.join(os.tmpdir(), "carton-ci");

export const dirs = {
  root,
  // test results and logs: the run's artifact (results only, never builds or Cardboard's code)
  results: process.env.CARTON_CI_RESULTS || path.join(root, "carton-results"),
  // downloaded tools; the workflow caches this folder
  cache: process.env.CARTON_CI_CACHE || path.join(root, "carton-ci-cache"),
};

// The scratch folders the packages' tests read. Their defaults point at the shared dev box's /home/ubuntu/gfv-scratch.
export function testEnv() {
  const env = {
    CARTON_TEST_TMP: path.join(root, "carton-tmp"),
    CARTON_SCRATCH: path.join(root, "carton-scratch"),
    CARTON_TEST_SCRATCH: path.join(root, "carton-test-scratch"),
    CARTON_MEDIA_SCRATCH: path.join(root, "carton-media"),
    CARTON_S3_SCRATCH: path.join(root, "carton-s3"),
    CARTON_TEST_DIR: path.join(root, "carton-patch-tests"),
    CARTON_E2E_TMP: path.join(root, "carton-e2e"),
  };
  for (const k of Object.keys(env)) {
    if (process.env[k]) env[k] = process.env[k];
    fs.mkdirSync(env[k], { recursive: true });
  }
  return env;
}

// Appends KEY=value lines for later steps (no-op outside Actions) and sets them for this process.
export function exportEnv(vars) {
  for (const [k, v] of Object.entries(vars)) {
    process.env[k] = v;
    if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV, `${k}=${v}\n`);
    console.log(`  ${k}=${v}`);
  }
}

export function exportPath(dir) {
  process.env.PATH = dir + path.delimiter + process.env.PATH;
  if (process.env.GITHUB_PATH) fs.appendFileSync(process.env.GITHUB_PATH, dir + "\n");
  console.log(`  PATH += ${dir}`);
}

export function summary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + "\n");
}

export function machine() {
  const cpus = os.cpus();
  return {
    os: OS,
    platform: `${process.platform} ${os.release()}`,
    arch: process.arch,
    cpu: cpus[0]?.model?.trim() ?? "unknown",
    cores: cpus.length,
    memGiB: +(os.totalmem() / 2 ** 30).toFixed(1),
    node: process.version,
    runner: process.env.RUNNER_NAME ?? null,
    image: process.env.ImageOS ? `${process.env.ImageOS} ${process.env.ImageVersion ?? ""}`.trim() : null,
  };
}
