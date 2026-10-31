// A tiny topic emitter for CartonUi adapters. Live sync can confirm dozens of changes in one burst; marking a topic
// dirty many times in one task wakes its listeners once, on the next microtask, so a burst costs one render of the
// components that show it, not one per change.

export class TopicHub<T extends string> {
  #subs = new Map<T, Set<() => void>>();
  #dirty = new Set<T>();
  #scheduled = false;
  /** Listener calls made so far, per topic. The benchmarks read it to prove bursts are coalesced. */
  readonly calls = new Map<T, number>();

  subscribe(topic: T, fn: () => void): () => void {
    let set = this.#subs.get(topic);
    if (!set) this.#subs.set(topic, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  /** Mark a topic changed. Its listeners run once on the next microtask, however often it is marked before then. */
  notify(topic: T): void {
    this.#dirty.add(topic);
    if (this.#scheduled) return;
    this.#scheduled = true;
    queueMicrotask(this.#flush);
  }

  /** Run a topic's listeners now (tests, and state a host must see before it returns). */
  notifyNow(topic: T): void {
    this.#dirty.delete(topic);
    this.#run(topic);
  }

  listeners(topic: T): number {
    return this.#subs.get(topic)?.size ?? 0;
  }

  #flush = () => {
    this.#scheduled = false;
    const topics = [...this.#dirty];
    this.#dirty.clear();
    for (const t of topics) this.#run(t);
  };

  #run(topic: T) {
    const set = this.#subs.get(topic);
    if (!set?.size) return;
    this.calls.set(topic, (this.calls.get(topic) ?? 0) + 1);
    // Copy first: a listener may unsubscribe (a row unmounting) while we iterate.
    for (const fn of [...set]) fn();
  }
}
