// Patches Cardboard's library worker (media import, conversion and proxies) for Windows.
// Usage: node patch-worker.js <path-to-dist/library-worker.js>
const fs = require("fs");
const path = require("path");

const file = process.argv[2];
// Keep the pristine bundle outside the asar source tree so it is not repacked.
const orig = path.join(path.dirname(file), "..", "..", "library-worker.orig.js");
if (!fs.existsSync(orig)) fs.copyFileSync(file, orig);
let src = fs.readFileSync(orig, "utf8");

const replace = (from, to, count = 1) => {
  const n = src.split(from).length - 1;
  if (n !== count) throw new Error(`expected ${count} match(es), found ${n}: ${from}`);
  src = src.split(from).join(to);
};

// Helpers prepended to the bundle (it has no banner line to put them after). Prepended last.
// The rename retry (see rename-retry.js) goes first.
const preamble = require("./rename-retry") + require("./media-helpers");

// CB_BASELINE=1 builds the baseline the benchmarks compare against (scripts/bench): Cardboard's own media
// pipeline as it runs on a Mac, with only what Windows needs to run it. Decoding stays on the CPU, filmstrips
// decode every frame, and proxies are made one at a time on the hardware encoder at Cardboard's set bitrate,
// as VideoToolbox makes them. The fixes (4, 5) stay in. The steps marked "speed" are left out.
const speed = process.env.CB_BASELINE !== "1";

// 1. Use NVENC for media conversion and proxies when the GPU has it. A failed hardware encode
// already falls back to libx264/libx265 (the ToolError catch around each hardware attempt).
replace(`Mp=(e,t)=>{if(process.platform!=="darwin")return Promise.resolve(!1);`, `Mp=(e,t)=>{if(__cbWin)return __cbHwProbe(e,t);if(process.platform!=="darwin")return Promise.resolve(!1);`);
replace(`"h264_videotoolbox"`, `__cbHwEnc.h264`, 3);
replace(`"hevc_videotoolbox"`, `__cbHwEnc.hevc`, 2);
replace(`"-allow_sw","1"`, `...__cbHwOpts`, 3);
// Speed: proxies in NVENC's constant-quality mode, capped at Cardboard's rate (see __cbProxyRate).
if (speed) replace(`["-c:v",rP,"-b:v",n,`, `["-c:v",rP,...__cbProxyRate(n),`);

// 2. Speed: proxies decode on the GPU too (NVDEC, and scale_cuda unless the source is rotated). Software decoding
// of 4K HEVC made a proxy take about as long as the clip runs. If the GPU run fails, the NVENC run with
// CPU decoding follows, then the existing libx264 fallback. scale_cuda scales with lanczos: its default
// was softer than the CPU path's scaler (VMAF 85.5 against 92.4 for the same 4K clip).
if (speed) {
  replace(`try{await x6(e,t,o,n,i,!0,a)}catch(s){`, `try{await __cbCudaFirst(e,g=>x6(e,t,o,n,i,g?"cuda":!0,a),()=>(0,No.rm)(o,{force:!0}))}catch(s){`);
  replace('"-nostats","-i",t,"-map","0:V:0","-map",`${Tr(n)}?`,"-vf",AJ(i)', '"-nostats",...__cbProxyIn(a,n),"-i",t,"-map","0:V:0","-map",`${Tr(n)}?`,"-vf",__cbProxyOnGpu(a,n)?AJ(i).replace("scale=","scale_cuda=")+":format=yuv420p:interp_algo=lanczos":AJ(i)');
  replace(`...RJ(a,i,n.bitrate),"-pix_fmt","yuv420p","-c:a"`, `...RJ(a,i,n.bitrate),...__cbProxyOnGpu(a,n)?[]:["-pix_fmt","yuv420p"],"-c:a"`);
}

// 3. Speed: timeline filmstrips decode only keyframes when that is enough (see __cbStrip). $P gets ffprobe to check.
if (speed) {
  replace(`$P=async(e,t,r,n,i)=>{`, `$P=async(e,t,r,n,i,__cbProbeBin)=>{`);
  replace(`let l=await $P(s,i,n,a,c);`, `let l=await $P(s,i,n,a,c,e.binaries().ffprobe);`);
  replace('await dt(e,["-v","error","-y","-i",t,"-map","0:v:0","-vf",`fps=1/${a},${NP(wI)}`,"-q:v",DP,(0,lc.join)(s,"%06d.jpg")]);', 'await __cbStrip(e,__cbProbeBin,t,s,o.length,(x,f="")=>dt(e,["-v","error","-y",...x,"-i",t,"-map","0:v:0","-vf",`fps=1/${a}${f},${NP(wI)}`,"-q:v",DP,(0,lc.join)(s,"%06d.jpg")]));');
}

// 4. A video has its thumbnails once its filmstrip exists, not just its poster. The poster is written
// first, so quitting Cardboard mid-filmstrip left clips that reopening the project never finished. When
// the cache then holds more thumbnails than the project lists, the project takes the cache's.
replace(`let s=await kY(e.cache,n);return s.length>0?{thumbnailIds:s,`, `let s=await kY(e.cache,n);return s.length>0&&(a.kind!=="video"||s.some(x=>x.includes(":timeline:")))?{thumbnailIds:s,`);
replace(`t.thumbnailIds&&!e.thumbnailIds?.length&&(r.thumbnailIds=t.thumbnailIds,`, `t.thumbnailIds&&t.thumbnailIds.length>(e.thumbnailIds?.length??0)&&(r.thumbnailIds=t.thumbnailIds,`);

// 5. Quitting after a failed background save (see __cbSettled). Main waits for every import to be done
// before it quits, and the worker said so only when all of the import's background work succeeded. Now a
// clip's failure is reported as that clip's, and the import is done either way.
replace(`n.background&&o.push(HP(e,m,CY(e,t,J,n)))`, `n.background&&o.push(HP(e,m,__cbSettled(CY(e,t,J,n),J,n)))`);
replace(`return m.then(()=>n(c.id,{phase:"done"})),{items:u,failures:p}`, `return m.finally(()=>n(c.id,{phase:"done"})).catch(()=>{}),{items:u,failures:p}`);

// 6. Open Project (a folder or a .cbproj) stages the project in `.opening-<id>` inside the library, moves it into place,
// and removes the staging folder. On Windows a file anything holds open can't be removed, and a failed removal fails
// the whole Open Project (CI: EBUSY on the staged carton.db, which Carton held; Carton now closes it when prepare
// ends). Defender or the search indexer scanning a file the import just wrote can hold one briefly too. The removal
// retries as the rename does (rename-retry.js; the move is a rename, already covered), adding ENOTEMPTY, what a
// folder whose last file is still going gives.
replace(
  `await(0,Ft.lstat)((0,Et.join)(a,Y_)).catch(()=>null)&&await(0,Ft.rm)(a,{recursive:!0,force:!0})`,
  `await(0,Ft.lstat)((0,Et.join)(a,Y_)).catch(()=>null)&&await(__cbWin&&globalThis.__cbRetryBusy||(f=>f()))(()=>(0,Ft.rm)(a,{recursive:!0,force:!0}),["EPERM","EBUSY","EACCES","ENOTEMPTY"])`,
);

// 7. Premiere Pro projects (new in Cardboard 1.5.0: Open Project takes a .prproj; `cb project import-premiere` in the
// CLI, patch-cli-media.js 7). XT lists the places each media file may be: the absolute paths Premiere saved, then
// paths relative to the .prproj. Its third argument is the path style, "posix" unless given, and a posix list skips
// absolute Windows paths (C:\…, \\?\C:\…), which a Mac can't open. The import never passed it, so on Windows the
// paths Premiere saved there were dropped: only media found relative to the .prproj came in, the rest was "not
// found". On Windows the call asks for "win32", which keeps them; relative paths are still tried after them.
replace(`let C=XT(x,o),w;`, `let C=XT(x,o,__cbWin?"win32":"posix"),w;`);

// After the replacements, since the preamble itself names the VideoToolbox encoders.
src = preamble + src;
fs.writeFileSync(file, src);
console.log(`patched ${path.basename(file)} (${src.length} bytes${speed ? "" : ", baseline"})`);
