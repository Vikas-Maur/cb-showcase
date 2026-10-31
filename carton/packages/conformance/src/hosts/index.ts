// SequencerHost, SequencerStorage, Transport and AuthProvider conformance (PLAN §3.1, §6.3). Owner: hosts-plugins.
import type { AuthProvider, SequencerHost, SequencerStorage, Transport } from "@carton/core/plugins";

const todo = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

export interface HostFixture {
  host: SequencerHost;
  transport: Transport;
  auth: AuthProvider;
  /** A token for a fresh device credential with the given role. */
  token(role?: "owner" | "editor" | "viewer"): Promise<string>;
  /** Restart the host on the same storage (hibernation / process restart). */
  restart?(): Promise<void>;
  close(): Promise<void>;
}

export function sequencerHostSuite(name: string, make: () => Promise<HostFixture>): void {
  todo("sequencerHostSuite");
}
export function sequencerStorageSuite(name: string, make: () => Promise<SequencerStorage>): void {
  todo("sequencerStorageSuite");
}
export function transportSuite(name: string, make: () => Promise<HostFixture>): void {
  todo("transportSuite");
}
export function authProviderSuite(name: string, make: () => Promise<AuthProvider>): void {
  todo("authProviderSuite");
}
