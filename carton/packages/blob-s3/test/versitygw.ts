// Starts and stops a throwaway VersityGW (github.com/versity/versitygw, Apache 2.0) for integration tests:
// a real S3 gateway with a POSIX backend that checks SigV4 strictly, so it verifies our signing independently.
//
// Flags used: global `--port 127.0.0.1:<free port> --region us-east-1 --health /health --quiet`, then the
// `posix <fresh dir>` backend. The root credentials go in through ROOT_ACCESS_KEY / ROOT_SECRET_KEY rather
// than --access/--secret so they do not show up in `ps`.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { accessSync, constants as fsConstants, rmSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { signRequest } from "../src/sigv4.ts";

export const VERSITYGW_BIN =
  process.env.VERSITYGW_BIN ??
  "/home/ubuntu/gfv-scratch/carton/hosts-plugins/dl-versitygw/x/versitygw_v1.10.0_Linux_arm64/versitygw";
/** Each run gets a fresh data dir under here (never /tmp: it is a small tmpfs on the dev box). */
export const SCRATCH_DIR = process.env.CARTON_S3_SCRATCH ?? "/home/ubuntu/gfv-scratch/carton/hosts-plugins/s3-helper";

export interface Gateway {
  endpoint: string;
  region: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
  dataDir: string;
  /** Recent gateway output, for failure messages. */
  output(): string;
  stop(): Promise<void>;
}

/** Why the integration tests cannot run here, or null when the binary is present and executable. */
export function versitygwMissingReason(): string | null {
  try {
    accessSync(VERSITYGW_BIN, fsConstants.X_OK);
    return null;
  } catch {
    return `VersityGW binary not found or not executable at ${VERSITYGW_BIN} (set VERSITYGW_BIN to run the S3 integration tests)`;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

// Last resort if a test run dies without its `after` hook: never leave a gateway behind. "exit" covers a normal
// end; a signal (Ctrl-C, the test runner killing a timed-out file) skips "exit", so those kill the gateways and
// then re-raise the signal, whose default action ends the process as it would have without us.
const running = new Map<ChildProcess, string>(); // gateway -> its data dir
let cleanupInstalled = false;

function killAll(): void {
  for (const [child, dataDir] of running) {
    child.kill("SIGKILL");
    rmSync(dataDir, { recursive: true, force: true });
  }
  running.clear();
}

function installCleanup(): void {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  process.once("exit", killAll);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      killAll();
      process.kill(process.pid, signal);
    });
  }
}

function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, ms);
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

async function launch(timeoutMs: number): Promise<Gateway> {
  const port = await freePort();
  await mkdir(join(SCRATCH_DIR, "runs"), { recursive: true });
  const dataDir = await mkdtemp(join(SCRATCH_DIR, "runs", "vgw-"));
  const root = join(dataDir, "posix");
  await mkdir(root);
  const credentials = { accessKeyId: "CARTONTEST" + randomBytes(5).toString("hex").toUpperCase(), secretAccessKey: randomBytes(24).toString("base64") };
  const region = "us-east-1";

  installCleanup();
  const child = spawn(
    VERSITYGW_BIN,
    ["--port", `127.0.0.1:${port}`, "--region", region, "--health", "/health", "--quiet", "posix", root],
    {
      env: { ...process.env, ROOT_ACCESS_KEY: credentials.accessKeyId, ROOT_SECRET_KEY: credentials.secretAccessKey },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  running.set(child, dataDir);
  let output = "";
  const collect = (chunk: Buffer): void => {
    output = (output + chunk.toString("utf8")).slice(-8000);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  let stopped: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopped ??= (async () => {
      if (!(await waitForExit(child, 0))) {
        child.kill("SIGTERM");
        if (!(await waitForExit(child, 3000))) {
          child.kill("SIGKILL");
          await waitForExit(child, 3000);
        }
      }
      running.delete(child);
      await rm(dataDir, { recursive: true, force: true });
    })();
    return stopped;
  };

  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      await stop();
      throw new Error(`versitygw exited during startup (code ${child.exitCode}, signal ${child.signalCode}):\n${output}`);
    }
    try {
      const res = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(1000) });
      await res.arrayBuffer();
      if (res.ok) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`versitygw did not become ready within ${timeoutMs} ms:\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { endpoint, region, credentials, dataDir, output: () => output, stop };
}

/** Starts a gateway on a free port with a fresh, empty data dir. Retries if the port was taken meanwhile. */
export async function startVersityGw(options: { timeoutMs?: number } = {}): Promise<Gateway> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await launch(options.timeoutMs ?? 15000);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/** Creates a bucket with a signed `PUT /<bucket>` (bucket management is not part of S3Client). */
export async function createBucket(gateway: Gateway, bucket: string): Promise<void> {
  const url = `${gateway.endpoint}/${bucket}`;
  const headers = await signRequest({
    method: "PUT",
    url,
    credentials: gateway.credentials,
    region: gateway.region,
    service: "s3",
  });
  const res = await fetch(url, { method: "PUT", headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`creating bucket ${bucket} failed: ${res.status} ${text}`);
}
