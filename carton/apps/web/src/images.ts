// T1 images (posters, filmstrips, §11) as object URLs: each key is fetched once through the project's signed URLs,
// and the views that show them re-render once per arrival, not per clip.

export class ImageCache {
  #urls = new Map<string, string>();
  #loading = new Set<string>();
  #listeners = new Set<() => void>();
  #load: (key: string) => Promise<Uint8Array | null>;
  version = 0;

  constructor(load: (key: string) => Promise<Uint8Array | null>) {
    this.#load = load;
  }
  /** The URL when loaded; the first ask starts the load. */
  get(key: string): string | undefined {
    const u = this.#urls.get(key);
    if (u || this.#loading.has(key)) return u;
    this.#loading.add(key);
    void this.#load(key)
      .then((bytes) => {
        if (!bytes) return;
        this.#urls.set(key, URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/jpeg" })));
        this.version++;
        for (const l of this.#listeners) l();
      })
      .catch(() => {})
      .finally(() => this.#loading.delete(key));
    return undefined;
  }
  /** Images that weren't there before may be now (this page just put them up): views ask again. */
  bump(): void {
    this.version++;
    for (const l of this.#listeners) l();
  }
  subscribe(l: () => void): () => void {
    this.#listeners.add(l);
    return () => this.#listeners.delete(l);
  }
}
