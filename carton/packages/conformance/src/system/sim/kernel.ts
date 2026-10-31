// Deterministic discrete-event kernel (port of system-v11 `sim.mjs`): a virtual clock, a binary-heap event queue with
// FIFO tie-break, a seeded RNG, threads with a busy-until reservation (a stall delays everything queued behind it),
// processes that can be killed, and local sockets (IPC) with request timeouts. No real sleeps: time only moves when an
// event runs. `run()` flushes the microtask queue after every event, so scenario code can `await sim.sleep(ms)`.

export function sfc32(seed: number): () => number {
  let a = 0x9e3779b9, b = 0x243f6a88, c = 0xb7e15162, d = seed >>> 0;
  const next = () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9); b = (c + (c << 3)) | 0; c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0; t = (t + d) | 0; c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 16; i++) next();
  return next;
}

interface Ev {
  t: number;
  k: number;
  f: () => void;
}
const lt = (x: Ev, y: Ev) => x.t < y.t || (x.t === y.t && x.k < y.k);
class Heap {
  private a: Ev[] = [];
  push(e: Ev): void {
    const a = this.a;
    let i = a.length;
    a.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (lt(a[p]!, e)) break;
      a[i] = a[p]!;
      i = p;
    }
    a[i] = e;
  }
  pop(): Ev {
    const a = this.a, top = a[0]!, last = a.pop()!;
    if (a.length) {
      let i = 0;
      const n = a.length;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i, mv = last;
        if (l < n && lt(a[l]!, mv)) (m = l), (mv = a[l]!);
        if (r < n && lt(a[r]!, mv)) (m = r), (mv = a[r]!);
        if (m === i) break;
        a[i] = a[m]!;
        i = m;
      }
      a[i] = last;
    }
    return top;
  }
  peek(): Ev | undefined {
    return this.a[0];
  }
  get size(): number {
    return this.a.length;
  }
}

const immediate = () => new Promise<void>((r) => setImmediate(r));

export class Sim {
  readonly seed: number;
  now = 0;
  private heap = new Heap();
  private k = 0;
  readonly rand: () => number;
  events = 0;
  constructor(seed = 1) {
    this.seed = seed;
    this.rand = sfc32(seed * 2654435761 + 7);
  }
  at(t: number, f: () => void): void {
    if (!(t >= this.now)) t = this.now;
    this.heap.push({ t, k: this.k++, f });
  }
  after(dt: number, f: () => void): void {
    this.at(this.now + dt, f);
  }
  sleep(dt: number): Promise<void> {
    return new Promise((r) => this.after(dt, r));
  }
  /** uniform in [a, b) */
  uni(a: number, b: number): number {
    return a + (b - a) * this.rand();
  }
  exp(mean: number): number {
    return -Math.log(1 - this.rand()) * mean;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.rand() * arr.length)]!;
  }
  hex(n: number): string {
    let s = "";
    for (let i = 0; i < n; i++) s += Math.floor(this.rand() * 16).toString(16);
    return s;
  }
  /** Callback-only models (no awaits): the fastest mode. */
  runSync(until = Infinity): void {
    while (this.heap.size && this.heap.peek()!.t <= until) {
      const e = this.heap.pop();
      this.now = e.t;
      this.events++;
      e.f();
    }
    if (until !== Infinity && this.now < until) this.now = until;
  }
  async run(until = Infinity): Promise<void> {
    await immediate();
    while (this.heap.size && this.heap.peek()!.t <= until) {
      const e = this.heap.pop();
      this.now = e.t;
      this.events++;
      e.f();
      await immediate();
    }
    if (until !== Infinity && this.now < until) this.now = until;
  }
  /** Run until pred() is true (checked after every event) or the clock passes `limit`. */
  async runUntil(pred: () => boolean, limit = Infinity): Promise<boolean> {
    await immediate();
    while (!pred() && this.heap.size && this.heap.peek()!.t <= limit) {
      const e = this.heap.pop();
      this.now = e.t;
      this.events++;
      e.f();
      await immediate();
    }
    return pred();
  }
  /** Timers on the virtual clock, for code written against setTimeout (the sync client). */
  timers(): { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void } {
    return {
      setTimeout: (fn, ms) => {
        const h = { cancelled: false };
        this.after(ms, () => {
          if (!h.cancelled) fn();
        });
        return h;
      },
      clearTimeout: (h) => {
        if (h) (h as { cancelled: boolean }).cancelled = true;
      },
    };
  }
}

/**
 * A thread runs posted tasks in FIFO order; each task reserves `cost` ms of the thread. stall(ms) reserves an idle
 * block, so anything posted afterwards (a ping, a network message) waits behind it. A dead process's tasks never run.
 */
export class Thread {
  busyUntil = 0;
  readonly sim: Sim;
  readonly proc: Proc;
  readonly name: string;
  constructor(sim: Sim, proc: Proc, name: string) {
    this.sim = sim;
    this.proc = proc;
    this.name = name;
  }
  post(fn: () => void, cost = 0): number {
    const start = Math.max(this.sim.now, this.busyUntil);
    this.busyUntil = start + cost;
    this.sim.at(start, () => {
      if (this.proc.alive) fn();
    });
    return start;
  }
  /** Run fn at the thread's next free slot, holding it for `cost`; resolves with fn's result at the end. */
  run<T>(cost: number, fn: () => T): Promise<T> {
    return new Promise((resolve, reject) => {
      const start = Math.max(this.sim.now, this.busyUntil);
      this.busyUntil = start + cost;
      this.sim.at(start, () => {
        if (!this.proc.alive) return;
        let v: T;
        try {
          v = fn();
        } catch (e) {
          return void this.sim.at(start + cost, () => reject(e));
        }
        this.sim.at(start + cost, () => {
          if (this.proc.alive) resolve(v);
        });
      });
    });
  }
  stall(ms: number): void {
    this.busyUntil = Math.max(this.sim.now, this.busyUntil) + ms;
  }
}

let PID = 1000;
export interface WorldLike {
  sim: Sim;
  ipc: Ipc;
}
export class Proc {
  readonly sim: Sim;
  readonly pid = PID++;
  alive = true;
  readonly engine: Thread;
  readonly main: Thread;
  readonly sockets: string[] = [];
  readonly onExit: (() => void)[] = [];
  /** Replica id of this process (96 random bits in production; hex here) and its change counter. */
  rid = "";
  n = 0;
  readonly name: string;
  readonly world: WorldLike;
  readonly kind: string;
  constructor(world: WorldLike, kind: string, name?: string) {
    this.world = world;
    this.kind = kind;
    this.sim = world.sim;
    this.name = name ?? `${kind}#${this.pid}`;
    this.engine = new Thread(this.sim, this, "engine");
    this.main = new Thread(this.sim, this, "main");
  }
  nextId(): string {
    return `${this.rid}.${++this.n}`;
  }
  kill(): void {
    if (!this.alive) return;
    this.alive = false;
    for (const s of this.sockets) this.world.ipc.close(s);
    for (const f of this.onExit) f();
  }
}

type Handler = (msg: any) => unknown;
/** Local sockets (Unix socket / named pipe). Handlers run on a chosen thread of the listening process. */
export class Ipc {
  private servers = new Map<string, { proc: Proc; thread: Thread | ((m: any) => Thread); handler: Handler; open: Set<(e: Error) => void> }>();
  readonly sim: Sim;
  readonly lat: number;
  constructor(sim: Sim, lat = 0.1) {
    this.sim = sim;
    this.lat = lat;
  }
  listen(proc: Proc, path: string, thread: Thread | ((m: any) => Thread), handler: Handler): void {
    this.servers.set(path, { proc, thread, handler, open: new Set() });
    proc.sockets.push(path);
  }
  close(path: string): void {
    const s = this.servers.get(path);
    this.servers.delete(path);
    if (s) for (const f of s.open) this.sim.after(this.lat, () => f(new Error("ECONNRESET")));
  }
  /** Resolves with the handler's reply; rejects with ECONNREFUSED, ECONNRESET (the listener died) or ETIMEDOUT. */
  request<T = any>(path: string, msg: unknown, { timeout = Infinity }: { timeout?: number } = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      let done = false;
      let s: { proc: Proc; thread: Thread | ((m: any) => Thread); handler: Handler; open: Set<(e: Error) => void> } | undefined;
      const fail = (e: Error) => finish(reject as (v: unknown) => void, e);
      const finish = (f: (v: any) => void, v: unknown) => {
        if (!done) {
          done = true;
          s?.open.delete(fail);
          f(v);
        }
      };
      if (timeout !== Infinity) this.sim.after(timeout, () => fail(new Error("ETIMEDOUT")));
      this.sim.after(this.lat, () => {
        s = this.servers.get(path);
        if (!s || !s.proc.alive) return fail(new Error("ECONNREFUSED"));
        const srv = s;
        srv.open.add(fail);
        const th = typeof srv.thread === "function" ? srv.thread(msg) : srv.thread;
        th.post(() => {
          Promise.resolve()
            .then(() => srv.handler(msg))
            .then(
              (v) => this.sim.after(this.lat, () => (srv.proc.alive ? finish(resolve, v) : fail(new Error("ECONNRESET")))),
              (e: Error) => this.sim.after(this.lat, () => fail(e)),
            );
        });
      });
    });
  }
}
