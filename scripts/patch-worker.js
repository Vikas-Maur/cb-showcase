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

// 1. Use NVENC for media conversion and proxies when the GPU has it. A failed hardware encode
// already falls back to libx264/libx265 (the ToolError catch around each hardware attempt).
replace(`J1=(e,t)=>{if(process.platform!=="darwin")return Promise.resolve(!1);`, `J1=(e,t)=>{if(__cbWin)return __cbHwProbe(e,t);if(process.platform!=="darwin")return Promise.resolve(!1);`);
replace(`"h264_videotoolbox"`, `__cbHwEnc.h264`, 3);
replace(`"hevc_videotoolbox"`, `__cbHwEnc.hevc`, 2);
replace(`"-allow_sw","1"`, `...__cbHwOpts`, 3);
// Proxies in NVENC's constant-quality mode, capped at Cardboard's rate (see __cbProxyRate).
replace(`["-c:v",WI,"-b:v",r,`, `["-c:v",WI,...__cbProxyRate(r),`);

// 2. Proxies decode on the GPU too (NVDEC, and scale_cuda unless the source is rotated). Software decoding
// of 4K HEVC made a proxy take about as long as the clip runs. If the GPU run fails, the NVENC run with
// CPU decoding follows, then the existing libx264 fallback. scale_cuda scales with lanczos: its default
// was softer than the CPU path's scaler (VMAF 85.5 against 92.4 for the same 4K clip).
replace(`try{await M4(e,t,o,n,i,!0,a)}catch(s){`, `try{await __cbCudaFirst(e,g=>M4(e,t,o,n,i,g?"cuda":!0,a),()=>(0,go.rm)(o,{force:!0}))}catch(s){`);
replace('"-nostats","-i",t,"-map","0:v:0","-map",`${Ir(n)}?`,"-vf",xH(i)', '"-nostats",...__cbProxyIn(a,n),"-i",t,"-map","0:v:0","-map",`${Ir(n)}?`,"-vf",__cbProxyOnGpu(a,n)?xH(i).replace("scale=","scale_cuda=")+":format=yuv420p:interp_algo=lanczos":xH(i)');
replace(`...vH(a,i),"-pix_fmt","yuv420p","-c:a"`, `...vH(a,i),...__cbProxyOnGpu(a,n)?[]:["-pix_fmt","yuv420p"],"-c:a"`);

// 3. Timeline filmstrips decode only keyframes when that is enough (see __cbStrip). hS gets ffprobe to check.
replace(`hS=async(e,t,r,n,i)=>{`, `hS=async(e,t,r,n,i,__cbProbeBin)=>{`);
replace(`let l=await hS(s,i,n,a,c);`, `let l=await hS(s,i,n,a,c,e.binaries().ffprobe);`);
replace('await yt(e,["-v","error","-y","-i",t,"-map","0:v:0","-vf",`fps=1/${a},${pS(bw)}`,"-q:v",uS,(0,zs.join)(s,"%06d.jpg")]);', 'await __cbStrip(e,__cbProbeBin,t,s,o.length,(x,f="")=>yt(e,["-v","error","-y",...x,"-i",t,"-map","0:v:0","-vf",`fps=1/${a}${f},${pS(bw)}`,"-q:v",uS,(0,zs.join)(s,"%06d.jpg")]));');

// 4. A video has its thumbnails once its filmstrip exists, not just its poster. The poster is written
// first, so quitting Cardboard mid-filmstrip left clips that reopening the project never finished. When
// the cache then holds more thumbnails than the project lists, the project takes the cache's.
replace(`let s=await eJ(e.cache,n);return s.length>0?{thumbnailIds:s,`, `let s=await eJ(e.cache,n);return s.length>0&&(a.kind!=="video"||s.some(x=>x.includes(":timeline:")))?{thumbnailIds:s,`);
replace(`t.thumbnailIds&&!e.thumbnailIds?.length&&(r.thumbnailIds=t.thumbnailIds,`, `t.thumbnailIds&&t.thumbnailIds.length>(e.thumbnailIds?.length??0)&&(r.thumbnailIds=t.thumbnailIds,`);

// 5. Quitting after a failed background save (see __cbSettled). Main waits for every import to be done
// before it quits, and the worker said so only when all of the import's background work succeeded. Now a
// clip's failure is reported as that clip's, and the import is done either way.
replace(`n.background&&o.push(CS(e,m,oJ(e,t,Q,n)))`, `n.background&&o.push(CS(e,m,__cbSettled(oJ(e,t,Q,n),Q,n)))`);
replace(`return m.then(()=>n(c.id,{phase:"done"})),{items:u,failures:p}`, `return m.finally(()=>n(c.id,{phase:"done"})).catch(()=>{}),{items:u,failures:p}`);

// After the replacements, since the preamble itself names the VideoToolbox encoders.
src = preamble + src;
fs.writeFileSync(file, src);
console.log(`patched ${path.basename(file)} (${src.length} bytes)`);
