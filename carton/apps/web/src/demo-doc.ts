// The demo project: a short "Weekend reel" in Cardboard 1.4.0's own document shape (PLAN §4.2: tracks, timelineItems,
// media), made from generated sample clips only. The seed script builds it once and shares it; everyone else joins.

import { POS, type Doc, type Rec } from "@carton/core";

export const ITEMS = "timelineItems";
export const TRACKS = "tracks";
export const MEDIA = "media";
export const TRACK_CAPTIONS = "t-captions";
export const TRACK_VIDEO = "t-video";

/** A sample clip as uploaded: its media record id, content hash and the T1 extras the timeline shows. */
export interface SampleMedia {
  id: string;
  name: string;
  hash: string;
  size: number;
  /** Seconds. */
  duration: number;
  /** Blob keys in the project's media scope (T1, §11). */
  poster?: string;
  filmstrip?: string;
}

const CAPTIONS = ["Saturday, 7 am", "The long way round", "Coffee first", "See you next weekend"];
/** How much of each sample clip the first cut uses, in seconds. */
const USE = 4;

/** The Weekend reel: the clips back to back on Video 1, a caption over each on Captions. */
export function demoDoc(media: readonly SampleMedia[], name = "Weekend reel"): Doc {
  const tracks: Rec[] = [
    { id: TRACK_CAPTIONS, name: "Captions", type: "caption", [POS]: "a0" },
    { id: TRACK_VIDEO, name: "Video 1", type: "video", [POS]: "a1" },
  ];
  const items: Rec[] = [];
  let t = 0;
  media.forEach((m, i) => {
    const len = Math.min(USE, m.duration);
    items.push({ id: `clip-${i + 1}`, type: "video", trackId: TRACK_VIDEO, name: m.name, mediaItemId: m.id, startTime: t, endTime: t + len, trimStart: 0, trimEnd: len, playbackSpeed: 1, volume: 100, opacity: 1 });
    items.push({ id: `cap-${i + 1}`, type: "caption", trackId: TRACK_CAPTIONS, captionText: CAPTIONS[i % CAPTIONS.length]!, startTime: t + 0.5, endTime: t + len - 0.5, trimStart: 0, trimEnd: len - 1, playbackSpeed: 1 });
    t += len;
  });
  const mediaRecs: Rec[] = media.map((m) => ({ id: m.id, contentHash: m.hash, data: { fileName: `${m.name}.mp4`, type: "video" } }));
  return { name, aspectRatio: "16:9", [TRACKS]: tracks, [ITEMS]: items, [MEDIA]: mediaRecs };
}
