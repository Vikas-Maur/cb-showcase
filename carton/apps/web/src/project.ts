// Opening the shared project in a browser (PLAN §3: @carton/core + store-idb; §12 sync over WebSocket):
// - the project descriptor from the host's media scope (signed GET), whose root Carton checks against its hash;
// - `Carton.open` on IndexedDB, joining the shared cut the first time (`init.join`), reopening it after that;
// - one pusher per person per browser (§6.2): the tab holding the store-idb push lock connects; another tab of the
//   same person waits in the lock queue and takes over when the first closes.
// The bot and the tests call `openProject` with their own Store and no lock.

import { Carton, type Actor } from "@carton/core";
import type { Store, Transport } from "@carton/core/plugins";
import { cardboardAdapter } from "@carton/cardboard";
import { DESCRIPTOR_KEY, parseDescriptor, type ProjectDescriptor } from "./descriptor.ts";
import type { Session } from "./session.ts";

/** A blob from the project's media scope, through a short-lived signed URL (§14). Null when there is none. */
export async function readBlob(session: Session, key: string, fetchFn: typeof fetch = fetch.bind(globalThis)): Promise<Uint8Array | null> {
  const { url } = await session.api<{ url: string }>("/blobs/sign", { key, method: "GET", expiresIn: 120 });
  const r = await fetchFn(url);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`reading ${key}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

/** Write a small blob into the project's media scope through a signed PUT (editors only). */
export async function putBlob(session: Session, key: string, bytes: Uint8Array, contentType: string, fetchFn: typeof fetch = fetch.bind(globalThis)): Promise<void> {
  const { url } = await session.api<{ url: string }>("/blobs/sign", { key, method: "PUT", expiresIn: 120 });
  const r = await fetchFn(url, { method: "PUT", headers: { "content-type": contentType }, body: bytes as BodyInit });
  if (!r.ok) throw new Error(`writing ${key}: ${r.status} ${await r.text()}`);
}

export async function readDescriptor(session: Session, fetchFn?: typeof fetch): Promise<ProjectDescriptor> {
  const bytes = await readBlob(session, DESCRIPTOR_KEY, fetchFn);
  if (!bytes) throw new Error("This project has nothing shared yet.");
  return parseDescriptor(new TextDecoder().decode(bytes));
}

export interface OpenedProject {
  carton: Carton;
  descriptor: ProjectDescriptor;
  session: Session;
  me: Actor;
}

export async function openProject(o: { session: Session; me: Actor; store: Store; transport: Transport; descriptor?: ProjectDescriptor; autoConnect?: boolean }): Promise<OpenedProject> {
  const descriptor = o.descriptor ?? (await readDescriptor(o.session));
  const { projectId, cut, doc0, rootHash } = descriptor;
  const carton = await Carton.open({
    adapter: cardboardAdapter,
    store: o.store,
    actor: o.me,
    name: o.me.name ?? o.me.id,
    init: { join: { projectId, cut, doc0, rootHash } },
    sync: { transport: o.transport, url: o.session.wsUrl, token: () => o.session.token(), autoConnect: o.autoConnect ?? true },
  });
  return { carton, descriptor, session: o.session, me: o.me };
}

/**
 * Hold this person's push lock for the page's life and connect once it is ours. `onWaiting` is told while another
 * tab holds it. Returns a release (the page unloading releases it too).
 */
export async function holdPushLock(lockId: string, carton: Carton, onWaiting: (waiting: boolean) => void): Promise<() => void> {
  const { withPushLock } = await import("@carton/store-idb");
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let mine = false;
  // first try without waiting, so the page can say "open in another tab" at once
  const tryNow = withPushLock(lockId, async () => {
    mine = true;
    await carton.sync!.connect().catch(() => false);
    await released;
  }, { ifAvailable: true });
  await Promise.resolve();
  void tryNow.then(() => {
    if (mine) return;
    onWaiting(true);
    void withPushLock(lockId, async () => {
      onWaiting(false);
      await carton.sync!.connect().catch(() => false);
      await released;
    });
  });
  return release;
}
