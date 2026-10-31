// H-SV (e2e-qa): every Cardboard client sends its adapter's schema version (CARDBOARD_SCHEMA_VERSION) in `hello`, and a
// host's sequencer refuses a client newer than the version it accepts. When `82d8c70` raised it to 2 both hosts still
// defaulted to 1, and live sync stalled without a word to the person. These check what the hosts do with their
// defaults, not how their source spells them (a text match broke on the fix itself: CI run 41227528651):
// - server-node, started with no `schemaVersion` in a process of its own (hsv-node-host.ts): a real Cardboard client
//   shares a cut through it, its commit is confirmed, and no sync error comes back. Every step has a time limit, and the
//   host's process is ended whatever happens, so a stuck close fails in seconds instead of hanging CI's step;
// - server-cloudflare: the version the room configures its sequencer with (`schemaVersionOf`), unset and with the vars
//   its wrangler.toml ships, accepts Cardboard's clients.
// They run where the workspace has the hosts (the integration branch, CI) and are skipped where a host is still a stub;
// a host that is there but whose entry point moved fails, so the check is updated rather than skipped.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Carton } from "@carton/core";
import type { Transport } from "@carton/core/plugins";
import { createMemoryStore } from "@carton/store-memory";
import { CARDBOARD_SCHEMA_VERSION, cardboardAdapter, fromHost, toHost } from "@carton/cardboard";
import { SCRATCH, clip, find, type Item } from "./world.ts";

const PACKAGES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const has = (rel: string) => fs.existsSync(path.join(PACKAGES, rel));
/** A module by a specifier the type checker doesn't follow: the hosts' real code is only in some workspaces. */
const load = async <T>(spec: string): Promise<Partial<T>> => (await import(spec)) as Partial<T>;
const HOST_SCRIPT = fileURLToPath(new URL("./hsv-node-host.ts", import.meta.url));
/** `p`, or a failure naming `what` after `ms`: a step that never returns fails the test in seconds, not at CI's step limit. */
function within<T>(ms: number, what: string, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, no) => (timer = setTimeout(() => no(new Error(`${what}: no answer in ${ms} ms`)), ms)));
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

interface NodeHostModule {
  webSocketTransport(opts: Record<string, unknown>): Transport;
}
interface ServerModule {
  createHmacAuth(opts: { secret: string }): { issue(claims: Record<string, unknown>): string | Promise<string> };
}
interface RoomModule {
  schemaVersionOf(env: { SCHEMA_VERSION?: string }): number;
}

test("H-SV: server-node started with no schemaVersion takes a Cardboard client: it shares a cut and its commit is confirmed [real host]", { timeout: 60_000 }, async (t) => {
  if (!has("server-node/src/host.ts")) return t.skip("server-node's host isn't in this workspace (a stub)");
  const { webSocketTransport } = await load<NodeHostModule>("@carton/server-node");
  const { createHmacAuth } = await load<ServerModule>("@carton/server");
  assert.ok(webSocketTransport && createHmacAuth, "server-node's webSocketTransport or @carton/server's createHmacAuth moved: update hosts-schema.ts");
  assert.equal(cardboardAdapter.schemaVersion, CARDBOARD_SCHEMA_VERSION, "a Cardboard client sends CARDBOARD_SCHEMA_VERSION");
  const secret = "test-only-secret-test-only-secret-0123";
  fs.mkdirSync(SCRATCH, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(SCRATCH, "hsv-node-"));
  // The host runs in a process of its own (hsv-node-host.ts), which the teardown can always end; the test's process
  // keeps no host handle that could stop node --test from exiting.
  const host = spawn(process.execPath, [HOST_SCRIPT, dataDir], { env: { ...process.env, HSV_SECRET: secret }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const exited = new Promise<void>((ok) => host.once("exit", () => ok()));
  host.stdin!.on("error", () => {}); // ending the pipe of a host that just exited (EPIPE) is not a failure: its exit is checked
  let stderr = "";
  host.stderr!.setEncoding("utf8").on("data", (d: string) => void (stderr = (stderr + d).slice(-4000)));
  const open: { carton?: Carton } = {};
  // One hook, in order (node runs `t.after` hooks in the order they're added, and stops at the first that fails): the
  // client, then the host (its rooms' SQLite files close with it), then the folder. Windows refuses to remove a folder
  // whose database is still open (EPERM: route 36, CI run 41229566460). Each step has a time limit: a close that never
  // returns fails the test in seconds; a host that doesn't exit is killed.
  t.after(async () => {
    const failed: string[] = [];
    await within(5_000, "Carton's close", open.carton?.close() ?? Promise.resolve()).catch((e: Error) => void failed.push(e.message));
    if (host.exitCode === null && host.signalCode === null) {
      host.stdin!.end();
      await within(10_000, "the node host's close", exited).catch((e: Error) => {
        failed.push(`${e.message} (killed); its stderr: ${stderr}`);
        host.kill();
        return within(5_000, "the node host's exit after a kill", exited).catch((e2: Error) => void failed.push(e2.message));
      });
    }
    try {
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (e) {
      failed.push(`removing the host's data folder: ${(e as Error).message}`);
    }
    assert.deepEqual(failed, [], "teardown");
  }, { timeout: 30_000 });
  const started = await within(20_000, "the node host's start", new Promise<{ url?: string; error?: string }>((ok, no) => {
    let out = "";
    host.stdout!.setEncoding("utf8").on("data", (d: string) => {
      out += d;
      const nl = out.indexOf("\n");
      if (nl >= 0) ok(JSON.parse(out.slice(0, nl)) as { url?: string; error?: string });
    });
    host.once("error", no);
    void exited.then(() => no(new Error(`the node host exited (${host.exitCode ?? host.signalCode}) before it started: ${stderr}`)));
  }));
  assert.ok(started.url, `the node host didn't start: ${started.error ?? JSON.stringify(started)}`);
  const auth = createHmacAuth({ secret });
  const token = await auth.issue({ account: "alice", credential: "alice/dev", role: "owner", projectId: "p", ttlMs: 60_000 });
  const alice = { kind: "human" as const, id: "alice" };
  const carton = (open.carton = await Carton.open({
    adapter: cardboardAdapter,
    store: createMemoryStore(),
    actor: alice,
    init: { doc: fromHost({ tracks: [{ id: "V1", type: "video" }], timelineItems: [clip("X", 0, 10)] }, null) },
    sync: { transport: webSocketTransport({ keepaliveMs: 0 }), url: started.url, token, autoConnect: false },
  }));
  const errors: string[] = [];
  carton.on((e) => {
    const x = e as { type: string; error?: { code: string; message: string } | null };
    if (x.type === "sync-error" && x.error) errors.push(`${x.error.code}: ${x.error.message}`);
  });
  await within(10_000, "share", carton.share());
  assert.ok(await within(10_000, "connect", carton.sync!.connect({ nonce: "hsv" })), `connected (${errors.join("; ")})`);
  const shared = async () => (await carton.cuts()).find((c) => c.id === carton.cut)?.sequencer.kind === "server";
  for (const end = Date.now() + 10_000; !(await shared()); await new Promise((r) => setTimeout(r, 20))) {
    assert.ok(Date.now() < end && !errors.length, `the host never took the cut: ${errors.join("; ") || "no answer"} (H-SV: does its default accept schema version ${CARDBOARD_SCHEMA_VERSION}?)`);
  }
  const h = await carton.head();
  const host0 = toHost(h.doc);
  const items = structuredClone(host0.timelineItems as Item[]);
  find(items, "X").name = "through the host";
  const r = await within(10_000, "the commit", carton.commit({ doc: fromHost({ ...host0, timelineItems: items }, h.doc), author: alice }));
  const o = r.status === "pending" ? await carton.sync!.waitFor(r.id, 5000) : r;
  assert.equal(o.status, "confirmed", `${JSON.stringify(o)} ${errors.join("; ")}`);
  assert.deepEqual(errors, []);
});

test("H-SV: server-cloudflare's room accepts Cardboard's schema version unset and with the vars its wrangler.toml ships [real host]", async (t) => {
  if (!has("server-cloudflare/src/room.ts")) return t.skip("server-cloudflare's room isn't in this workspace (a stub)");
  const { schemaVersionOf } = await load<RoomModule>(pathToFileURL(path.join(PACKAGES, "server-cloudflare/src/room.ts")).href);
  assert.ok(schemaVersionOf, "server-cloudflare's schemaVersionOf (what the room gives its sequencer) moved: update hosts-schema.ts");
  assert.ok(schemaVersionOf({}) >= CARDBOARD_SCHEMA_VERSION, `with no SCHEMA_VERSION the room accepts up to ${schemaVersionOf({})}; Cardboard clients send ${CARDBOARD_SCHEMA_VERSION}`);
  // every SCHEMA_VERSION its config pins: [vars] (the default deployment) and each [env.<name>.vars] (round 15 #7: the
  // first match in the file could be another environment's)
  const toml = path.join(PACKAGES, "server-cloudflare/wrangler.toml");
  const pinned = fs.existsSync(toml) ? pinnedSchemaVersions(fs.readFileSync(toml, "utf8")) : [];
  for (const { table, value } of pinned) {
    const v = schemaVersionOf({ SCHEMA_VERSION: value });
    assert.ok(v >= CARDBOARD_SCHEMA_VERSION, `wrangler.toml's [${table}] pins SCHEMA_VERSION ${value}: the room accepts up to ${v}, Cardboard clients send ${CARDBOARD_SCHEMA_VERSION}. Raise it with the bump.`);
  }
  t.diagnostic(`wrangler.toml ${pinned.length ? pinned.map((p) => `[${p.table}] pins SCHEMA_VERSION ${p.value}`).join(", ") : "leaves SCHEMA_VERSION unset"}`);
});

/**
 * The SCHEMA_VERSION values a wrangler.toml pins for the Worker: every key whose full path is `vars.SCHEMA_VERSION` or
 * `env.<name>.vars.SCHEMA_VERSION`, however TOML spells it: under a table header, as a dotted key, inside an inline table,
 * with bare, "basic" or 'literal' key parts (round 16 #3: a quoted key). Enough TOML for a config: one key per line,
 * comments, string or bare values, arrays and multi-line strings skipped.
 */
export function pinnedSchemaVersions(toml: string): { table: string; value: string }[] {
  const out: { table: string; value: string }[] = [];
  const found = (path: string[], value: string) => {
    const t = path.slice(0, -1);
    if (path[path.length - 1] !== "SCHEMA_VERSION") return;
    if ((t.length === 1 && t[0] === "vars") || (t.length === 3 && t[0] === "env" && t[2] === "vars")) out.push({ table: t.join("."), value });
  };
  let table: string[] = [];
  let multi: string | null = null; // inside a multi-line string: its closing delimiter
  for (const line of toml.split(/\r?\n/)) {
    if (multi) {
      if (line.includes(multi)) multi = null;
      continue;
    }
    let i = 0;
    const ws = () => {
      while (line[i] === " " || line[i] === "\t") i++;
    };
    const str = (): string | null => {
      const q = line[i];
      if (q === "'") {
        const j = line.indexOf("'", i + 1);
        if (j < 0) return null;
        const s = line.slice(i + 1, j);
        i = j + 1;
        return s;
      }
      if (q !== '"') return null;
      let s = "";
      for (i++; i < line.length && line[i] !== '"'; i++) {
        if (line[i] !== "\\") s += line[i];
        else if (line[i + 1] === "u" || line[i + 1] === "U") {
          const n = line[i + 1] === "u" ? 4 : 8;
          s += String.fromCodePoint(parseInt(line.slice(i + 2, i + 2 + n), 16));
          i += 1 + n;
        } else s += ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" } as Record<string, string>)[line[i + 1]!] ?? line[++i];
      }
      if (line[i] !== '"') return null;
      i++;
      return s;
    };
    const key = (): string[] | null => {
      const parts: string[] = [];
      for (;;) {
        ws();
        let part: string | null = null;
        if (line[i] === '"' || line[i] === "'") part = str();
        else {
          const m = /^[A-Za-z0-9_-]+/.exec(line.slice(i));
          if (m) [part, i] = [m[0], i + m[0].length];
        }
        if (part === null) return null;
        parts.push(part);
        ws();
        if (line[i] !== ".") return parts;
        i++;
      }
    };
    const value = (path: string[]): boolean => {
      ws();
      if (line[i] === "{") {
        i++;
        for (;;) {
          ws();
          if (line[i] === "}") return (i++, true);
          const k = key();
          if (!k || (ws(), line[i] !== "=")) return false;
          i++;
          if (!value([...path, ...k])) return false;
          ws();
          if (line[i] === ",") i++;
          else if (line[i] !== "}") return false;
        }
      }
      for (const q of ['"""', "'''"]) {
        if (!line.startsWith(q, i)) continue;
        if (line.indexOf(q, i + 3) < 0) multi = q;
        return false; // never a schema version
      }
      if (line[i] === '"' || line[i] === "'") {
        const s = str();
        return s !== null && (found(path, s), true);
      }
      const m = /^[^\s,}#[\]]+/.exec(line.slice(i)); // a number, boolean or date; an array is skipped
      return !!m && ((i += m[0].length), found(path, m[0]), true);
    };
    ws();
    if (line[i] === "[") {
      const array = line[i + 1] === "[";
      i += array ? 2 : 1;
      const k = key();
      if (k && line[i] === "]") table = k;
      continue;
    }
    const k = key();
    if (k && (ws(), line[i] === "=")) {
      i++;
      value([...table, ...k]);
    }
  }
  return out;
}

test("H-SV: wrangler.toml's SCHEMA_VERSION is read from [vars] and each [env.<name>.vars], never another table (round 15 #7)", () => {
  const toml = [
    "name = \"carton\"",
    "# SCHEMA_VERSION = \"0\" (a comment)",
    "[env.preview.vars]",
    "SCHEMA_VERSION = \"2\"",
    "[vars]",
    "SCHEMA_VERSION = \"1\" # the default deployment",
    "[durable_objects]",
    "SCHEMA_VERSION = \"9\"",
    "[env.staging]",
    "vars = { OTHER = \"x\", SCHEMA_VERSION = '3' }",
    "[env.prod.vars]",
    "SCHEMA_VERSION = 4",
  ].join("\n");
  assert.deepEqual(pinnedSchemaVersions(toml), [
    { table: "env.preview.vars", value: "2" },
    { table: "vars", value: "1" },
    { table: "env.staging.vars", value: "3" },
    { table: "env.prod.vars", value: "4" },
  ]);
  assert.deepEqual(pinnedSchemaVersions("[vars]\n# SCHEMA_VERSION = \"1\"\n"), [], "commented out: unset");
});

test("H-SV: wrangler.toml's SCHEMA_VERSION however TOML spells its key: quoted, dotted, inline, under a quoted table (round 16 #3)", () => {
  const pins = (lines: string[]) => pinnedSchemaVersions(lines.join("\n"));
  assert.deepEqual(pins(["[vars]", '"SCHEMA_VERSION" = "1"']), [{ table: "vars", value: "1" }], "a basic-quoted key");
  assert.deepEqual(pins(["[ vars ] # spaced", "'SCHEMA_VERSION' = '1'"]), [{ table: "vars", value: "1" }], "a literal-quoted key");
  assert.deepEqual(pins(['"SCHEMA\\u005FVERSION" = "8"', "[vars]", '"SCHEMA\\u005FVERSION" = "1"']), [{ table: "vars", value: "1" }], "an escaped key, and only under [vars]");
  assert.deepEqual(pins(['name = "carton"', 'vars.SCHEMA_VERSION = "1"', "[env.qa]", "vars . \"SCHEMA_VERSION\" = 2"]), [
    { table: "vars", value: "1" },
    { table: "env.qa.vars", value: "2" },
  ], "dotted keys");
  assert.deepEqual(pins(['[env."my env".vars]', 'SCHEMA_VERSION = "3"', "[env]", "x.vars.SCHEMA_VERSION = '4'"]), [
    { table: "env.my env.vars", value: "3" },
    { table: "env.x.vars", value: "4" },
  ], "a quoted table name, and a dotted key under [env]");
  assert.deepEqual(pins(['env = { dev = { vars = { "SCHEMA_VERSION" = "5", OTHER = "}" } } }']), [{ table: "env.dev.vars", value: "5" }], "nested inline tables");
  assert.deepEqual(pins([
    "[vars]",
    'NOTE = """',
    'SCHEMA_VERSION = "0"',
    '"""',
    'ROUTES = [ { SCHEMA_VERSION = "0" } ]',
    "[vars.nested]",
    'SCHEMA_VERSION = "0"',
    "[durable_objects]",
    'vars.SCHEMA_VERSION = "0"',
    "[env.a.b.vars]",
    'SCHEMA_VERSION = "0"',
  ]), [], "never a multi-line string's text, an array, or another table's key");
});
