// The Published cut's watch page (§0.1 "Published cut: what the share link shows"): plays the published version, and
// says so when the cut it came from has newer edits since. Joins with the link's viewer invite: viewers can read and
// can never push (the sequencer checks the role). Holds no project store: two read-only followers (follow.ts).

import { createElement as h, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Doc } from "@carton/core";
import { injectCardboardSkin } from "@carton/react/skin/cardboard";
import { cardboardAdapter } from "@carton/cardboard";
import { webSocketTransport } from "@carton/server-node/transport";
import { parseWatchHash, type ProjectDescriptor } from "./descriptor.ts";
import { Follower } from "./follow.ts";
import { ImageCache } from "./images.ts";
import { startMedia } from "./media-client.ts";
import { Player } from "./player.ts";
import { readBlob, readDescriptor } from "./project.ts";
import { Session, type KeyStore } from "./session.ts";
import { appCss } from "./styles.ts";
import { formatTime } from "./timeline.ts";
import { Btn } from "./ui.ts";
import { docLength } from "./edit.ts";

const keys: KeyStore = { get: (k) => localStorage.getItem(k), set: (k, v) => localStorage.setItem(k, v) };
injectCardboardSkin(document);
const style = document.createElement("style");
style.textContent = appCss;
document.head.append(style);
const root = createRoot(document.getElementById("root")!);

interface State {
  doc: Doc | null;
  newer: number;
  error: string | null;
}

function WatchPage(p: { descriptor: ProjectDescriptor; state: State; images: ImageCache; mediaUrl: (hash: string) => string }) {
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [, setV] = useState(0);
  useEffect(() => p.images.subscribe(() => setV((n) => n + 1)), [p.images]);
  const { doc, newer, error } = p.state;
  const length = doc ? docLength(doc) : 0;
  return h(
    "div",
    { className: "cb-watch-page", "data-carton-skin": "cardboard" },
    h("header", { className: "cb-topbar" }, h("span", { className: "cb-tab" }, h("span", { className: "cb-tab-thumb", "aria-hidden": true }), String(doc?.name ?? p.descriptor.name)), h("span", { className: "cb-dim" }, "Published cut · watch only")),
    h(
      "main",
      { className: "cb-watch-main" },
      newer > 0 ? h("div", { className: "cb-newer", role: "status", "data-testid": "newer-edits" }, `Newer edits exist: ${newer} version${newer === 1 ? "" : "s"} since this was published.`) : h("div", { className: "cb-dim", "data-testid": "up-to-date" }, "This is the newest version of the cut."),
      error ? h("p", { className: "cb-error", role: "alert" }, error) : null,
      doc
        ? h(
            "div",
            { className: "cb-viewer", style: { height: "60vh" } },
            h(Player, { doc, media: p.descriptor.media, time, playing, onTime: setTime, onPause: () => setPlaying(false), mediaUrl: p.mediaUrl, poster: (k: string) => p.images.get(k) }),
            h("div", { className: "cb-transport" }, h(Btn, { "data-testid": "play", onClick: () => (playing ? setPlaying(false) : (time >= length - 0.05 && setTime(0), setPlaying(true))) }, playing ? "❚❚ Pause" : "▶ Play"), h("span", { className: "cb-time" }, `${formatTime(time)} / ${formatTime(length)}`)),
          )
        : h("p", { className: "cb-dim" }, "Loading the published version…"),
    ),
  );
}

async function main(): Promise<void> {
  const link = parseWatchHash(location.hash);
  if (!link) {
    root.render(h("p", { className: "cb-dim", style: { padding: 24 } }, "This watch link is incomplete."));
    return;
  }
  const baseUrl = location.origin;
  const session = (await Session.resume({ baseUrl, projectId: link.projectId, keys, slot: `watch.${link.cut}` })) ?? (await Session.join({ baseUrl, projectId: link.projectId, invite: link.invite, account: "viewer", keys, slot: `watch.${link.cut}` }));
  const descriptor = await readDescriptor(session);
  const images = new ImageCache((key) => readBlob(session, key));
  const media = startMedia({ baseUrl, projectId: link.projectId, token: () => session.token() });
  // media URLs only once the Service Worker controls the page (review R2-2): posters until then
  let mediaReady = false;
  const mediaUrl = (hash: string) => (mediaReady ? media.url(hash) : "");
  session.onToken(() => media.refreshToken());
  const state: State = { doc: null, newer: 0, error: null };
  const render = () => root.render(h(WatchPage, { descriptor, state: { ...state }, images, mediaUrl }));
  media.ready.then(() => ((mediaReady = true), render()), () => {});
  const common = { transport: webSocketTransport(), url: session.wsUrl, token: () => session.token(), schema: cardboardAdapter.schema, schemaVersion: cardboardAdapter.schemaVersion, onError: (why: string) => ((state.error = why), render()) };
  // the Published cut alone (the link's token reads nothing else); its welcome counts the source's newer versions
  new Follower({
    ...common,
    branchId: link.cut,
    have: -1,
    refreshMs: 5_000,
    onUpdate: (s) => {
      state.doc = s.doc;
      if (s.source) state.newer = Math.max(0, s.source.head - s.source.at);
      render();
    },
  }).start();
  Object.assign(window, { __watch: state });
  render();
}

main().catch((e) => root.render(h("p", { className: "cb-error", style: { padding: 24 } }, (e as Error).message)));
