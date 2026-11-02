// The URL a built file is served at: its path under the output folder, with `/` separators whatever the OS. esbuild's
// metafile names outputs relative to the working directory; on Windows the folder is `C:\…\dist` and the separators
// are backslashes, so splitting on "/" would collapse every chunk's URL to "/" (review round 2, R2-4).

import * as nodePath from "node:path";

export function assetUrl(outDir: string, file: string, path: typeof nodePath.posix = nodePath): string {
  return "/" + path.relative(path.resolve(outDir), path.resolve(file)).split(path.sep).join("/");
}
