// Latency histograms for race.ts and summarize.ts, mergeable across trials: 1 µs buckets up to 2 ms, then 100 µs
// buckets up to 100 ms (on NTFS the missing-path window reaches milliseconds), then one overflow bucket. Quantiles are
// reported in µs, as each bucket's lower edge.
export const FINE_US = 2_000;
const COARSE_US = 100;
export const TOP_US = 100_000;
export const BUCKETS = FINE_US + (TOP_US - FINE_US) / COARSE_US + 1;
export type Hist = number[];

export const hist = (): Hist => new Array(BUCKETS).fill(0);
const index = (us: number): number => (us < FINE_US ? Math.floor(us) : us < TOP_US ? FINE_US + Math.floor((us - FINE_US) / COARSE_US) : BUCKETS - 1);
const label = (i: number): number | string => (i === BUCKETS - 1 ? `>${TOP_US}` : i < FINE_US ? i : FINE_US + (i - FINE_US) * COARSE_US);

export function hadd(h: Hist, ns: number): void {
  h[index(ns / 1000)]!++;
}

/** Adds `from` into `into`. Results written before the 100 ms range (2,001 buckets) can't be placed: re-run them. */
export function hmerge(into: Hist, from: Hist): void {
  if (from.length !== BUCKETS) throw new Error(`a histogram of ${from.length} buckets (want ${BUCKETS}): results from an older race.ts, re-run them`);
  from.forEach((v, i) => (into[i]! += v));
}

export function hq(h: Hist, q: number): number | string | null {
  const n = h.reduce((a, b) => a + b, 0);
  if (!n) return null;
  const want = Math.ceil(q * n);
  let c = 0;
  for (let i = 0; i < BUCKETS; i++) {
    c += h[i]!;
    if (c >= want) return label(i);
  }
  return null;
}

export function hmax(h: Hist): number | string | null {
  for (let i = BUCKETS - 1; i >= 0; i--) if (h[i]) return label(i);
  return null;
}
