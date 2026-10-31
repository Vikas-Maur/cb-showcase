// The engine thread (§6.2, R5-06): the library worker runs the engine, the lease holder and its control socket on a
// worker_thread of their own. Pings are answered there, so a main loop busy with a multi-MB project.json is never
// mistaken for a dead holder; a stalled engine thread is (and fencing then stops it).
// The main thread talks to it over the thread's message port: `call("serve", request)` runs a write exactly as a
// `cb` call on the socket would.
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export interface EngineThreadOptions {
  dbPath: string;
  /** The engine factory module (as for the helper): `createHolderEngine({dbPath, config, log})`. */
  factory: string;
  config?: Record<string, unknown>;
  reacquireMs?: number;
  onEvent?: (event: Record<string, unknown>) => void;
}

const entry = (): string => {
  const self = fileURLToPath(import.meta.url);
  return join(dirname(self), `engine-thread-main${self.endsWith(".ts") ? ".ts" : ".js"}`);
};

export class EngineThread {
  private w: Worker;
  private next = 1;
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  nonce: string | null = null;

  private constructor(w: Worker, onEvent?: (e: Record<string, unknown>) => void) {
    this.w = w;
    w.on("message", (m: any) => {
      if (m.event) { if (m.event.type === "lease") this.nonce = m.event.nonce; onEvent?.(m.event); return; }
      const p = this.waiting.get(m.id);
      if (!p) return;
      this.waiting.delete(m.id);
      if (m.error) p.reject(Object.assign(new Error(m.error.message), { code: m.error.code })); else p.resolve(m.result);
    });
    w.on("error", (e) => { for (const p of this.waiting.values()) p.reject(e); this.waiting.clear(); });
  }

  /** Start the thread; resolves once it holds the lease (asking a live helper to hand over first). */
  static async start(o: EngineThreadOptions): Promise<EngineThread> {
    const w = new Worker(entry(), { workerData: { dbPath: o.dbPath, factory: o.factory, config: o.config ?? {}, reacquireMs: o.reacquireMs ?? 2000 } });
    const t = new EngineThread(w, o.onEvent);
    await t.call("ready", {});
    return t;
  }

  call<T = any>(method: string, params: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = this.next++;
      this.waiting.set(id, { resolve, reject });
      this.w.postMessage({ id, method, params });
    });
  }

  async stop(): Promise<void> {
    try { await this.call("stop", {}); } finally { await this.w.terminate(); }
  }
}
