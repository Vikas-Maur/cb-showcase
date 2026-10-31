// HostAdapter and IdentitySource conformance (PLAN §3.1, §4.3, §10): round trip, determinism, projection idempotence,
// one-clip GUI saves (B10), and actor parsing. Owner: cardboard-adapter.
import type { HostAdapter, IdentitySource } from "@carton/core/plugins";

const todo = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

export function hostAdapterSuite<H>(name: string, adapter: HostAdapter<H>, fixtures: { hosts: H[] }): void {
  todo("hostAdapterSuite");
}
export function identitySourceSuite(name: string, source: IdentitySource, cases: { env: Record<string, string>; expect: unknown }[]): void {
  todo("identitySourceSuite");
}
