// A few calls at a time, for a batch (POST /blobs/heads, and its client's fallback to one head per key).

/**
 * `fn` for each item, at most `n` at once. After a failure no further item starts; the ones already started are
 * waited for, then the first error is thrown, so nothing runs on after the caller has its answer.
 */
export async function eachLimit<T>(items: readonly T[], n: number, fn: (item: T, i: number) => Promise<void>): Promise<void> {
  let next = 0, failed = false, first: unknown;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (!failed && next < items.length) {
        const i = next++;
        try {
          await fn(items[i]!, i);
        } catch (e) {
          if (!failed) (failed = true), (first = e);
        }
      }
    }),
  );
  if (failed) throw first;
}
