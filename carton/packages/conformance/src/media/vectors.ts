// Media id test vectors, computed independently of the TypeScript code with Python's hashlib:
//
//   import hashlib, struct
//   def data(n, seed):                       # xorshift32 words, little-endian, cut to n bytes
//       x = seed & 0xffffffff; out = bytearray()
//       while len(out) < n:
//           x ^= (x << 13) & 0xffffffff; x ^= x >> 17; x ^= (x << 5) & 0xffffffff
//           out += struct.pack('<I', x)
//       return bytes(out[:n])
//   L = 1 << 20
//   d = data(n, seed)
//   leaves = b''.join(hashlib.sha256(d[i:i+L]).digest() for i in range(0, n, L))
//   media_hash = hashlib.sha256(struct.pack('>Q', n) + leaves).hexdigest()
//
// `sha256` is the plain SHA-256 of the whole input (first 16 hex), to catch a broken generator separately.

export const MEDIA_ID_VECTORS: readonly { size: number; seed: number; mediaHash: string; sha256Prefix: string }[] = [
  { size: 0, seed: 1, mediaHash: "af5570f5a1810b7af78caf4bc70a660f0df51e42baf91d4de5b2328de0e83dfc", sha256Prefix: "e3b0c44298fc1c14" },
  { size: 1, seed: 1, mediaHash: "b4ffbd4d34443beb914c9bf4c4d23c0293902025875a9a904bf8b75565252fa3", sha256Prefix: "bb7208bc9b5d7c04" },
  { size: 1048575, seed: 2, mediaHash: "90e870abc4e183b3d4078a471c2ccdb8cd55fa42953e28686924ec5102c59c1d", sha256Prefix: "b26196faab4468df" },
  { size: 1048576, seed: 3, mediaHash: "5f3ab0bae169a48c8fe7363d9d6722803b04607f412fc137bf9bb20cb97455e9", sha256Prefix: "1d96fc1163947db4" },
  { size: 1048577, seed: 4, mediaHash: "56259e552a99b1bd733e9657bff5812f552e5268a8b8af2d765a4f23d9febc1c", sha256Prefix: "79ca6c12a68081ae" },
  { size: 3158073, seed: 5, mediaHash: "4408ad9f367157d7751412c3742538936f1a3780098b12b7a572cf8daafba1ab", sha256Prefix: "9f6df50c64ef7ed9" },
];

/** The vectors' byte stream (same as the Python generator above). Little-endian words, as on every target CPU. */
export function xorshiftBytes(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  const view = new DataView(out.buffer);
  let x = seed >>> 0;
  let i = 0;
  for (; i + 4 <= n; i += 4) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    view.setUint32(i, x, true);
  }
  if (i < n) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    for (let k = 0; i < n; i++, k++) out[i] = (x >>> (8 * k)) & 0xff;
  }
  return out;
}

/** FIPS 180-4 SHA-256 examples, and the empty input. */
export const SHA256_VECTORS: readonly { input: string; hex: string }[] = [
  { input: "", hex: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
  { input: "abc", hex: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" },
  { input: "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq", hex: "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1" },
  // Non-ASCII text: sha256HexSync must hash UTF-8 (Python: hashlib.sha256(s.encode()).hexdigest()).
  { input: "Carton · カートン · 🎬", hex: "789a43d31548801aeacba5ef6a4441a3d1476f397f31b2bb2a1e272883938041" },
];
