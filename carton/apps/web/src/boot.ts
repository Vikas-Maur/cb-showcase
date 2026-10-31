// Opening a project in the editor (the chunk main.ts loads behind the join screen): the store, Carton, the push lock,
// the live head, presence, media, the view model for @carton/react, and the editor itself.

import { createElement as h } from "react";
import type { Root } from "react-dom/client";
import { parseNode, type Actor, type Carton, type CutRecord, type Doc } from "@carton/core";
import { fromCarton, CartonProvider } from "@carton/react";
import { openIdbStore } from "@carton/store-idb";
import { webSocketTransport } from "@carton/server-node/transport";
import { App } from "./app.ts";
import { describeCardWith } from "./cards.ts";
import { watchHash } from "./descriptor.ts";
import { ImageCache } from "./images.ts";
import { LiveDoc } from "./live-doc.ts";
import { startMedia } from "./media-client.ts";
import { PresenceSender } from "./presence.ts";
import { holdPushLock, openProject, readBlob } from "./project.ts";
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
  const me: Actor = { kind: "human", id: session.account, name, group: session.account };
  const store = await openIdbStore(session.projectId, { name: `carton:${session.projectId}:${session.account}` });
  const { carton, descriptor } = await openProject({ session, me, store, transport: webSocketTransport(), autoConnect: false });
  const waiting = cell(false);
  await holdPushLock(`${session.projectId}:${session.account}`, carton, waiting.set);
  const live = await LiveDoc.open(carton);
  const presence = new PresenceSender((s) => carton.sync?.presence(s));
  const images = new ImageCache((key) => readBlob(session, key));
  const media = await startMedia({ baseUrl, projectId: session.projectId, token: () => session.token() });
  session.onToken(() => media.refreshToken());
  const previewDoc = cell<Doc | null>(null);

  // Publishing gives a watch link: the Published cut is handed to the host as its own shared cut, and a viewer
  // invite (owners only) lets anyone with the link watch it (§0.1 "Published cut: what the share link shows").
  const links = new Map<string, string>();
  const watchLink = async (rec: CutRecord): Promise<string | undefined> => {
    if (!rec.forkOf || session.role !== "owner") return undefined;
    const { branchId, seq } = parseNode(rec.forkOf);
    const saved = keys.get(`carton.watch.${rec.id}`);
    if (saved) return saved;
    const invite = await session.invite("viewer", 30 * 24 * 3600_000);
    const url = `${baseUrl}/watch.html${watchHash({ projectId: session.projectId, cut: rec.id, source: rec.source ?? branchId, at: seq, invite })}`;
    keys.set(`carton.watch.${rec.id}`, url);
    return url;
  };
  const publishing: Carton["publish"] = async (opts) => {
    const rec = await carton.publish(opts);
    await carton.share(rec.id);
    const url = await watchLink(rec);
    if (url) links.set(rec.id, url);
    return rec;
  };
  // fromCarton sees this handle with publish going through the host; everything else is the handle itself
  const handle = new Proxy(carton, {
    get(t, k) {
      if (k === "publish") return publishing;
      const v = Reflect.get(t, k, t);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  for (const c of await carton.cuts()) if (c.kind === "published") void watchLink(c).then((u) => u && links.set(c.id, u));

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
  const setOffline = async (off: boolean) => {
    offline = off;
    if (off) {
      presence.stop();
      await carton.sync!.disconnect();
    } else await carton.sync!.connect().catch(() => false);
  };
  // real offline: the browser says the network went away; back online reconnects (unless the person chose offline)
  addEventListener("offline", () => void carton.sync!.disconnect());
  addEventListener("online", () => void (!offline && carton.sync!.connect().catch(() => false)));
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
      h(App, { carton, ui, live, session, me, name, media: descriptor.media, presence, images, mediaUrl: media.url, previewDoc, waiting, setOffline, isOffline: () => offline }),
    ),
  );
  presence.active("Joined");
}

