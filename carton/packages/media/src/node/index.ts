// @carton/media/node: the Node and Electron side of media. Hashing in worker threads, files as sources, the range cache
// on disk, open uploads remembered across restarts, the loopback range server for ffmpeg-based tools, the ffmpeg
// proxy encoders and the reuse of the host's own proxy, and shareMedia, which carries out a share for one clip.

export { nodeHasher, sha256Sync } from "./node-hasher.ts";
export { closeHashWorkers, hashFile, warmHashWorkers, type HashFileOptions } from "./hash-file.ts";
export { fileSource } from "./file-source.ts";
export { FsLeafCache, FsUploadStateStore, writeFileAtomic, type FsLeafCacheOptions } from "./fs-cache.ts";
export { parseRange, startRangeServer, type RangeRequestInfo, type RangeServer, type RangeServerOptions } from "./range-server.ts";
export {
  CHAIN_ORDER,
  defaultEncoderChain,
  describeEncoder,
  ffmpegEncoder,
  type EncoderDescription,
  type FfmpegCodec,
  type FfmpegEncoderOptions,
  type FfmpegProxyEncoder,
} from "./ffmpeg-encoder.ts";
export { hostProxyEncoder, probeProxyFile, type HostProxyDecision, type HostProxyEncoder, type HostProxyOptions } from "./host-proxy.ts";
export { shareMedia, type ShareEvent, type ShareMediaOptions, type ShareMediaResult } from "./share.ts";
