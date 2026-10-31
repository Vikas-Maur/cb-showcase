// Hasher and ProxyEncoder conformance (PLAN §3.1, §11): standard SHA-256 vectors, sync/async agreement, and the
// encoder probe/encode contract. Owner: media.
import type { Hasher, ProxyEncoder } from "@carton/core/plugins";

const todo = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

export function hasherSuite(name: string, hasher: Hasher): void {
  todo("hasherSuite");
}
export function proxyEncoderSuite(name: string, encoder: ProxyEncoder, opts: { sample: string }): void {
  todo("proxyEncoderSuite");
}
