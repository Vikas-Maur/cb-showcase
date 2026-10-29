// Patches the CLI's own copy of Cardboard's media code. `cb media add`, `cb media proxy` and the
// Director's imports run it in the CLI process rather than in the app, so it needs the same changes as
// patch-worker.js; this bundle names the same functions differently.
// Usage: node patch-cli-media.js <path-to-resources/cli/chunks/chunk-LL26E55H.mjs> <pristine-backup-path>
const fs = require("fs");
const path = require("path");

const [file, orig] = process.argv.slice(2);
if (!fs.existsSync(orig)) fs.copyFileSync(file, orig);
let src = fs.readFileSync(orig, "utf8");

const replace = (from, to, count = 1) => {
  const n = src.split(from).length - 1;
  if (n !== count) throw new Error(`expected ${count} match(es), found ${n}: ${from}`);
  src = src.split(from).join(to);
};

// The numbered steps match patch-worker.js.
// 1. NVENC.
replace(`ii=(e,t)=>{if(process.platform!=="darwin")return Promise.resolve(!1);`, `ii=(e,t)=>{if(__cbWin)return __cbHwProbe(e,t);if(process.platform!=="darwin")return Promise.resolve(!1);`);
replace(`"h264_videotoolbox"`, `__cbHwEnc.h264`, 3);
replace(`"hevc_videotoolbox"`, `__cbHwEnc.hevc`, 2);
replace(`"-allow_sw","1"`, `...__cbHwOpts`, 3);
replace(`["-c:v",pp,"-b:v",r,`, `["-c:v",pp,...__cbProxyRate(r),`);

// 2. Proxies decode on the GPU.
replace(`try{await Ps(e,t,a,n,o,!0,i)}catch(c){`, `try{await __cbCudaFirst(e,g=>Ps(e,t,a,n,o,g?"cuda":!0,i),()=>up(a,{force:!0}))}catch(c){`);
replace('"-nostats","-i",t,"-map","0:v:0","-map",`${ve(n)}?`,"-vf",RS(o)', '"-nostats",...__cbProxyIn(i,n),"-i",t,"-map","0:v:0","-map",`${ve(n)}?`,"-vf",__cbProxyOnGpu(i,n)?RS(o).replace("scale=","scale_cuda=")+":format=yuv420p:interp_algo=lanczos":RS(o)');
replace(`...MS(i,o),"-pix_fmt","yuv420p","-c:a"`, `...MS(i,o),...__cbProxyOnGpu(i,n)?[]:["-pix_fmt","yuv420p"],"-c:a"`);

// 3. Keyframe-only filmstrips.
replace(`Mp=async(e,t,r,n,o)=>{`, `Mp=async(e,t,r,n,o,__cbProbeBin)=>{`);
replace(`let d=await Mp(c,o,n,i,l);`, `let d=await Mp(c,o,n,i,l,e.binaries().ffprobe);`);
replace('await X(e,["-v","error","-y","-i",t,"-map","0:v:0","-vf",`fps=1/${i},${Ip(vd)}`,"-q:v",Ep,fn(c,"%06d.jpg")]);', 'await __cbStrip(e,__cbProbeBin,t,c,a.length,(x,f="")=>X(e,["-v","error","-y",...x,"-i",t,"-map","0:v:0","-vf",`fps=1/${i}${f},${Ip(vd)}`,"-q:v",Ep,fn(c,"%06d.jpg")]));');

// 4. A video has its thumbnails once its filmstrip exists.
replace(`let c=await vP(e.cache,n);return c.length>0?{thumbnailIds:c,`, `let c=await vP(e.cache,n);return c.length>0&&(i.kind!=="video"||c.some(x=>x.includes(":timeline:")))?{thumbnailIds:c,`);
replace(`t.thumbnailIds&&!e.thumbnailIds?.length&&(r.thumbnailIds=t.thumbnailIds,`, `t.thumbnailIds&&t.thumbnailIds.length>(e.thumbnailIds?.length??0)&&(r.thumbnailIds=t.thumbnailIds,`);

// 5. A clip's failed background work is reported as that clip's and doesn't reject (see __cbSettled).
// Recipe installs don't wait for it, so a rejection was unhandled and ended the CLI.
replace(`n.background&&a.push($p(e,f,EP(e,t,F,n)))`, `n.background&&a.push($p(e,f,__cbSettled(EP(e,t,F,n),F,n)))`);

// The helpers go after the module's require shim, which they use. Last, since they name the
// VideoToolbox encoders.
const shim = `const require = __createRequire(import.meta.url);\n`;
replace(shim, shim + require("./media-helpers"));

fs.writeFileSync(file, src);
console.log(`patched ${path.basename(file)} (${src.length} bytes)`);
