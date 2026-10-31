// The current cut's head as the editor shows it: confirmed rows plus this replica's pending edits (§5.1). Live sync
// can bring many rows in a burst (a teammate's drag, a catch-up page): every event only marks the head stale, and it
// is read once per frame at most, so a burst costs one read and one render (no re-render storm).

import type { Carton, Doc } from "@carton/core";

export class LiveDoc {
  readonly #carton: Carton;
  #doc: Doc;
  #cut: string;
  #listeners = new Set<() => void>();
  #stale = false;
  #reading: Promise<void> | null = null;
  #off: () => void;
  #schedule: (f: () => void) => void;
  /** How many head reads ran (diagnostics: the e2e asserts bursts are coalesced). */
  reads = 0;

  private constructor(carton: Carton, doc: Doc, schedule: (f: () => void) => void) {
    this.#carton = carton;
    this.#doc = doc;
    this.#cut = carton.cut;
    this.#schedule = schedule;
    this.#off = carton.on((e) => {
      if (e.type === "change" || e.type === "absorbed") {
        if (e.branchId === this.#carton.cut) this.invalidate();
      }
      // a write queued through another path (undo, fold, a card's pick) shows only as a sync-state change: Carton has
      // no "pending" event for its own shared-cut writes, and the optimistic head already holds it
      else if (e.type === "sync") this.invalidate();
    });
  }
  static async open(carton: Carton, schedule: (f: () => void) => void = defaultSchedule): Promise<LiveDoc> {
    return new LiveDoc(carton, (await carton.head()).doc, schedule);
  }

  get doc(): Doc {
    return this.#doc;
  }
  get cut(): string {
    return this.#cut;
  }
  subscribe(l: () => void): () => void {
    this.#listeners.add(l);
    return () => this.#listeners.delete(l);
  }
  /** The head moved (an event, our own commit, a cut switch): read it again on the next frame. */
  invalidate(): void {
    if (this.#stale) return;
    this.#stale = true;
    this.#schedule(() => void this.#read());
  }
  /** Read now (after our own commit, so the edit shows without waiting for a frame). */
  async refresh(): Promise<void> {
    this.#stale = true;
    await this.#read();
  }
  async #read(): Promise<void> {
    if (this.#reading) {
      // a read is in flight: one more after it picks up whatever arrived meanwhile
      await this.#reading;
      if (!this.#stale) return;
    }
    this.#stale = false;
    this.#reading = (async () => {
      this.reads++;
      const cut = this.#carton.cut;
      const { doc } = await this.#carton.head(cut);
      this.#doc = doc;
      this.#cut = cut;
      for (const l of this.#listeners) l();
    })().finally(() => (this.#reading = null));
    await this.#reading;
  }
  dispose(): void {
    this.#off();
    this.#listeners.clear();
  }
}

// A hidden tab gets no animation frames: it still follows the head, at a timer's pace
const defaultSchedule = (f: () => void) => (typeof requestAnimationFrame === "function" && !(globalThis as { document?: Document }).document?.hidden ? requestAnimationFrame(() => f()) : setTimeout(f, 50));
