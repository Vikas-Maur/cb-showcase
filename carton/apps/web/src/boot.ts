// Opening a project in the editor (the chunk main.ts loads behind the join screen): the store, Carton, the push lock,
// the live head, presence, media, the view model for @carton/react, and the editor itself.

import { createElement as h } from "react";
import type { Root } from "react-dom/client";
import type { Actor, Carton, CutRecord, Doc, SyncError } from "@carton/core";
import { fromCarton, CartonProvider } from "@carton/react";
import { openIdbStore } from "@carton/store-idb";
import { webSocketTransport } from "@carton/server-node/transport";
import { App } from "./app.ts";
import { describeCardWith } from "./cards.ts";
import { parseDescriptor, watchHash } from "./descriptor.ts";
import { ensureWatchFile } from "./watch-file.ts";
import { ImageCache } from "./images.ts";
import { LiveDoc } from "./live-doc.ts";
import { startMedia } from "./media-client.ts";
import { PresenceSender } from "./presence.ts";
import { holdPushLock, openProject, putBlob, readBlob, readDescriptor } from "./project.ts";
import type { KeyStore, Session } from "./session.ts";

/** A small observable value for the views (no framework store needed). */
function cell<T>(v: T) {
  const ls = new Set<() => void>();
  return {
    get: () => v,
    set: (x: T) => {
      v = x;
      for (const l of ls) l();
    },
    subscribe: (l: () => void) => (ls.add(l), () => void ls.delete(l)),
  };
}

export async function boot({ session, name, root, keys, baseUrl, message }: { session: Session; name: string; root: Root; keys: KeyStore; baseUrl: string; message: (title: string, text: string) => void }): Promise<void> {
  message("Opening…", "Loading the project and catching up with your teammates.");
  // the account is unique per install (main.ts accountFor); `name` is only what people see
  const me: Actor = { kind: "human", id: session.account, name, group: session.account };
  const store = await openIdbStore(session.projectId, { name: `carton:${session.projectId}:${session.account}` });
  // the descriptor is kept in this browser, so a project opened before reopens offline (its state is in the store)
  const cached = keys.get(`carton.descriptor.${session.projectId}`);
  const known = cached ? parseDescriptor(cached) : await readDescriptor(session);
  if (!cached) keys.set(`carton.descriptor.${session.projectId}`, JSON.stringify(known));
  const { carton, descriptor } = await openProject({ session, me, store, transport: webSocketTransport(), autoConnect: false, descriptor: known });
  const waiting = cell(false);
  // why the current cut's sync is failing (a host refusing this client, H-SV): shown in place of the sync words
  const syncProblem = cell<SyncError | null>(carton.sync?.error() ?? null);
  carton.on((e) => {
    if (e.type === "sync-error" || e.type === "sync") syncProblem.set(carton.sync?.error() ?? null);
  });
  const lock = await holdPushLock(`${session.projectId}:${session.account}`, carton, waiting.set, () => location.reload());
  const live = await LiveDoc.open(carton);
  const presence = new PresenceSender((s) => carton.sync?.presence(s));
  const images = new ImageCache((key) => readBlob(session, key));
  const media = startMedia({ baseUrl, projectId: session.projectId, token: () => session.token() });
  // media URLs only once the Service Worker controls this page: a <video> asking before then goes to the network,
  // gets nothing, and stays broken after the worker takes over (review R2-2). Editing doesn't wait for it.
  const mediaReady = cell(false);
  media.ready.then(() => mediaReady.set(true), () => {});
  session.onToken(() => media.refreshToken());
  const previewDoc = cell<Doc | null>(null);

  // Publishing gives a watch link: the Published cut is handed to the host as its own shared cut, and a viewer
  // invite (owners only) lets anyone with the link watch it (§0.1 "Published cut: what the share link shows").
  const links = new Map<string, string>();
  const watchFile = (rec: CutRecord) =>
    ensureWatchFile(rec, descriptor, { read: (k) => readBlob(session, k), put: (k, b, t) => putBlob(session, k, b, t), checkout: (c) => carton.checkout(c), keys });
  const watchLink = async (rec: CutRecord): Promise<string | undefined> => {
    if (!rec.forkOf || session.role !== "owner") return undefined;
    // the cut must be on the host before anyone can watch it (a publish whose hand-off didn't finish)
    if (rec.sequencer.kind === "local") await carton.share(rec.id);
    await watchFile(rec);
    const saved = keys.get(`carton.watch.${rec.id}`);
    if (saved) return saved;
    // asked scoped to the Published cut; today's hosts drop the scope, so the link reads the project like any viewer
    // (requests REQ-4, REQ-5 in the web-demo notes)
    const invite = await session.invite("viewer", 30 * 24 * 3600_000, [rec.id]);
    const url = `${baseUrl}/watch.html${watchHash({ projectId: session.projectId, cut: rec.id, invite })}`;
    keys.set(`carton.watch.${rec.id}`, url);
    return url;
  };
  const publishing: Carton["publish"] = async (opts) => {
    const rec = await carton.publish(opts);
    await carton.share(rec.id);
    const url = await watchLink((await carton.cuts()).find((c) => c.id === rec.id) ?? rec);
    if (url) links.set(rec.id, url);
    return rec;
  };
  // fromCarton sees this handle with publish going through the host, and every write refused while another tab of
  // this person holds the push lock (its edits would sit in a queue nobody pushes); everything else is the handle
  const WRITES = new Set<PropertyKey>(["commit", "undo", "fold", "foldSome", "restore", "revert", "publish", "fork", "renameCut", "name", "share"]);
  const otherTab = () => Promise.reject(new Error("This project is open in another tab. Edit it there, or close that tab: this one takes over."));
  const handle = new Proxy(carton, {
    get(t, k) {
      if (waiting.get() && WRITES.has(k)) return otherTab;
      if (k === "publish") return publishing;
      const v = Reflect.get(t, k, t);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  for (const c of await carton.cuts()) if (c.kind === "published") void watchLink(c).then((u) => u && links.set(c.id, u), () => {}); // retried on the next open

  const ui = fromCarton(handle, {
    me,
    group: me.group,
    clipName: (id) => {
      const r = ((live.doc.timelineItems ?? []) as { id: string; name?: string; captionText?: string }[]).find((x) => x.id === id);
      return r ? String(r.name ?? (r.captionText ? `Caption "${r.captionText}"` : id)) : id;
    },
    shareUrl: (cut) => links.get(cut.id),
    describeCard: describeCardWith(() => live.doc),
    onPreview: (pv) => previewDoc.set(pv ? (pv.doc as Doc) : null),
  });
  ui.subscribe("cuts", () => live.invalidate());

  let offline = false;
  // only the tab holding the push lock ever connects (§6.2); the others stay read-only until it closes
  const setOffline = async (off: boolean) => {
    offline = off;
    if (off) {
      presence.stop();
      await carton.sync!.disconnect();
    } else if (lock.holding()) await carton.sync!.connect().catch(() => false);
  };
  // real offline: the browser says the network went away; back online reconnects (unless the person chose offline)
  addEventListener("offline", () => void carton.sync!.disconnect());
  addEventListener("online", () => void (!offline && lock.holding() && carton.sync!.connect().catch(() => false)));
  addEventListener("pagehide", () => presence.stop());
  // presence isn't stored: say we're here when we (re)connect, and once to each teammate who appears
  const heard = new Map<string, number>();
  let lastSync = carton.sync!.status;
  carton.on((e) => {
    if (e.type === "sync") {
      if (e.status === "up-to-date" && lastSync !== "up-to-date") presence.announce();
      lastSync = e.status;
    } else if (e.type === "presence" && e.state) {
      const k = `${e.actor.kind}/${e.actor.id}`;
      const was = heard.get(k);
      heard.set(k, Date.now());
      if (was === undefined || Date.now() - was > 30_000) presence.announce();
    }
  });

  // test and demo hooks (the e2e reads state through these; nothing secret: the page already holds it)
  Object.assign(window, { __carton: { carton, ui, live, presence, me, session: { projectId: session.projectId, account: session.account, role: session.role }, links } });

  await ui.ready;
  root.render(
    h(
      CartonProvider,
      { ui },
      h(App, { carton, ui, live, session, me, name, media: descriptor.media, presence, images, mediaUrl: media.url, mediaReady, syncProblem, previewDoc, waiting, setOffline, isOffline: () => offline }),
    ),
  );
  presence.active("Joined");
}

