// The preview: the clip under the playhead (its proxy streamed through the Service Worker: play first, verify after,
// §11) with the caption on top, its opacity and volume applied. Playback walks the cut clip by clip. Shared by the
// editor and the watch page. Times are output seconds; a clip shows source time trimStart + (t − start) × speed.

import { createElement as h, useEffect, useRef } from "react";
import type { Doc, Rec } from "@carton/core";
import { ITEMS, TRACKS, type SampleMedia } from "./demo-doc.ts";
import { docLength } from "./edit.ts";

/** The visible clip at `t`: the topmost video track's clip covering it. */
export function videoAt(doc: Doc, t: number): Rec | undefined {
  const tracks = ((doc[TRACKS] ?? []) as Rec[]).filter((tr) => (tr.type ?? "video") === "video");
  for (const tr of tracks) {
    const hit = ((doc[ITEMS] ?? []) as Rec[]).find((r) => r.trackId === tr.id && r.type === "video" && (r.startTime as number) <= t && t < (r.endTime as number));
    if (hit) return hit;
  }
  return undefined;
}
export function captionAt(doc: Doc, t: number): Rec | undefined {
  return ((doc[ITEMS] ?? []) as Rec[]).find((r) => r.type === "caption" && (r.startTime as number) <= t && t < (r.endTime as number));
}
const sourceTime = (clip: Rec, t: number) => (clip.trimStart as number) + (t - (clip.startTime as number)) * ((clip.playbackSpeed as number) || 1);

export interface PlayerProps {
  doc: Doc;
  media: Record<string, SampleMedia>;
  time: number;
  playing: boolean;
  onTime: (t: number) => void;
  onPause: () => void;
  /** Where the browser reads a media hash (the Service Worker's /media/<hash>). */
  mediaUrl: (hash: string) => string;
  /** A poster's object URL, when loaded (T1). */
  poster?: (key: string) => string | undefined;
}

export function Player(p: PlayerProps) {
  const video = useRef<HTMLVideoElement>(null);
  const clip = videoAt(p.doc, p.time);
  const caption = captionAt(p.doc, p.time);
  const m = clip ? p.media[String(clip.mediaItemId)] : undefined;
  const src = m ? p.mediaUrl(m.hash) : "";
  const live = useRef(p);
  live.current = p;

  // paused: show the frame at the playhead
  useEffect(() => {
    const v = video.current;
    if (!v || !clip || p.playing) return;
    const want = sourceTime(clip, p.time);
    if (Math.abs(v.currentTime - want) > 0.04) v.currentTime = want;
  }, [p.time, clip, src, p.playing]);

  // playing: the video drives the playhead; at a clip's end the next one takes over, a gap plays on the clock
  useEffect(() => {
    if (!p.playing) {
      video.current?.pause();
      return;
    }
    let raf = 0;
    let last = performance.now();
    const end = docLength(p.doc);
    const tick = (now: number) => {
      const cur = live.current;
      const c = videoAt(cur.doc, cur.time);
      const v = video.current;
      let t: number;
      if (c && v && v.readyState >= 2 && !v.paused) t = (c.startTime as number) + (v.currentTime - (c.trimStart as number)) / ((c.playbackSpeed as number) || 1);
      else t = cur.time + (now - last) / 1000;
      last = now;
      if (c && t >= (c.endTime as number)) t = c.endTime as number;
      if (t >= end) {
        cur.onTime(end);
        cur.onPause();
        return;
      }
      cur.onTime(t);
      raf = requestAnimationFrame(tick);
    };
    const v = video.current;
    if (v && clip) {
      v.currentTime = sourceTime(clip, p.time);
      void v.play().catch(() => {});
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // a new clip (or a new src) restarts the loop at the playhead
  }, [p.playing, clip?.id, src]);

  useEffect(() => {
    const v = video.current;
    if (!v || !clip) return;
    v.volume = Math.min(1, Math.max(0, ((clip.volume as number) ?? 100) / 100));
  }, [clip?.volume, clip?.id]);

  const posterUrl = m?.poster ? p.poster?.(m.poster) : undefined;
  return h(
    "div",
    { className: "cb-player", "data-testid": "player" },
    clip
      ? h("video", {
          ref: video,
          key: "v",
          src: src || undefined,
          poster: posterUrl,
          preload: "auto",
          playsInline: true,
          className: "cb-player-video",
          style: { opacity: (clip.opacity as number) ?? 1 },
          "data-clip": String(clip.id),
        })
      : h("div", { className: "cb-player-empty" }, "No clip at the playhead"),
    caption ? h("div", { className: "cb-player-caption", "data-testid": "player-caption" }, String(caption.captionText ?? "")) : null,
  );
}
