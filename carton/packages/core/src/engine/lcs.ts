// Longest common subsequence as matched index pairs: common prefix/suffix, then Myers O(ND).
export function lcs<T>(a: readonly T[], b: readonly T[]): [number, number][] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const out: [number, number][] = [];
  for (let i = 0; i < pre; i++) out.push([i, i]);
  for (const [x, y] of myers(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf))) out.push([x + pre, y + pre]);
  for (let k = suf; k > 0; k--) out.push([a.length - k, b.length - k]);
  return out;
}

function myers<T>(a: readonly T[], b: readonly T[]): [number, number][] {
  const n = a.length,
    m = b.length;
  if (!n || !m) return [];
  const max = n + m,
    off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) x++, y++;
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, d);
    }
  }
  return [];
}

function backtrack<T>(trace: Int32Array[], a: readonly T[], b: readonly T[], D: number): [number, number][] {
  const out: [number, number][] = [];
  let x = a.length,
    y = b.length;
  for (let d = D; d > 0; d--) {
    const w = trace[d]!,
      V = (k: number) => w[k + d + 1]!;
    const k = x - y;
    const pk = k === -d || (k !== d && V(k - 1) < V(k + 1)) ? k + 1 : k - 1;
    const px = V(pk),
      py = px - pk;
    while (x > px && y > py) out.push([--x, --y]);
    x = px;
    y = py;
  }
  while (x > 0 && y > 0) out.push([--x, --y]);
  return out.reverse();
}
