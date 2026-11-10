// Patches the CLI's own copy of Cardboard's media code. `cb media add`, `cb media proxy` and the
// Director's imports run it in the CLI process rather than in the app, so it needs the same changes as
// patch-worker.js; this bundle names the same functions differently.
// Usage: node patch-cli-media.js <path-to-resources/cli/chunks/chunk-AEX5IIG7.mjs> <pristine-backup-path>
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

// The numbered steps match patch-worker.js, and CB_BASELINE=1 leaves out the same "speed" steps.
const speed = process.env.CB_BASELINE !== "1";

// 1. NVENC.
replace(`Ui=(e,t)=>{if(process.platform!=="darwin")return Promise.resolve(!1);`, `Ui=(e,t)=>{if(__cbWin)return __cbHwProbe(e,t);if(process.platform!=="darwin")return Promise.resolve(!1);`);
replace(`"h264_videotoolbox"`, `__cbHwEnc.h264`, 3);
replace(`"hevc_videotoolbox"`, `__cbHwEnc.hevc`, 2);
replace(`"-allow_sw","1"`, `...__cbHwOpts`, 3);
// Speed: constant quality.
if (speed) replace(`["-c:v",Ef,"-b:v",n,`, `["-c:v",Ef,...__cbProxyRate(n),`);

// 2. Speed: proxies decode on the GPU.
if (speed) {
  replace(`try{await hc(e,t,a,n,o,!0,i)}catch(c){`, `try{await __cbCudaFirst(e,g=>hc(e,t,a,n,o,g?"cuda":!0,i),()=>If(a,{force:!0}))}catch(c){`);
  replace('"-nostats","-i",t,"-map","0:V:0","-map",`${xe(n)}?`,"-vf",_I(o)', '"-nostats",...__cbProxyIn(i,n),"-i",t,"-map","0:V:0","-map",`${xe(n)}?`,"-vf",__cbProxyOnGpu(i,n)?_I(o).replace("scale=","scale_cuda=")+":format=yuv420p:interp_algo=lanczos":_I(o)');
  replace(`...LI(i,o,n.bitrate),"-pix_fmt","yuv420p","-c:a"`, `...LI(i,o,n.bitrate),...__cbProxyOnGpu(i,n)?[]:["-pix_fmt","yuv420p"],"-c:a"`);
}

// 3. Speed: keyframe-only filmstrips.
if (speed) {
  replace(`qf=async(e,t,r,n,o)=>{`, `qf=async(e,t,r,n,o,__cbProbeBin)=>{`);
  replace(`let d=await qf(c,o,n,i,l);`, `let d=await qf(c,o,n,i,l,e.binaries().ffprobe);`);
  replace('await ee(e,["-v","error","-y","-i",t,"-map","0:v:0","-vf",`fps=1/${i},${zf(Ru)}`,"-q:v",Vf,Wn(c,"%06d.jpg")]);', 'await __cbStrip(e,__cbProbeBin,t,c,a.length,(x,f="")=>ee(e,["-v","error","-y",...x,"-i",t,"-map","0:v:0","-vf",`fps=1/${i}${f},${zf(Ru)}`,"-q:v",Vf,Wn(c,"%06d.jpg")]));');
}

// 4. A video has its thumbnails once its filmstrip exists.
replace(`let c=await XT(e.cache,n);return c.length>0?{thumbnailIds:c,`, `let c=await XT(e.cache,n);return c.length>0&&(i.kind!=="video"||c.some(x=>x.includes(":timeline:")))?{thumbnailIds:c,`);
replace(`t.thumbnailIds&&!e.thumbnailIds?.length&&(r.thumbnailIds=t.thumbnailIds,`, `t.thumbnailIds&&t.thumbnailIds.length>(e.thumbnailIds?.length??0)&&(r.thumbnailIds=t.thumbnailIds,`);

// 5. A clip's failed background work is reported as that clip's and doesn't reject (see __cbSettled).
// Recipe installs don't wait for it, so a rejection was unhandled and ended the CLI.
replace(`n.background&&a.push(rh(e,f,tE(e,t,F,n)))`, `n.background&&a.push(rh(e,f,__cbSettled(tE(e,t,F,n),F,n)))`);

// 6. Open Project's staging folder is removed with the rename's retry (see patch-worker.js 6). The CLI's entry
// (patch-cli.js) defines __cbRetryBusy; a run without it removes as before.
replace(
  `await oo(Ue(i,ig)).catch(()=>null)&&await sR(i,{recursive:!0,force:!0})`,
  `await oo(Ue(i,ig)).catch(()=>null)&&await(__cbWin&&globalThis.__cbRetryBusy||(f=>f()))(()=>sR(i,{recursive:!0,force:!0}),["EPERM","EBUSY","EACCES","ENOTEMPTY"])`,
);

// The helpers go after the module's require shim, which they use. Last, since they name the
// VideoToolbox encoders.
const shim = `const require = __createRequire(import.meta.url);\n`;
replace(shim, shim + require("./media-helpers"));

fs.writeFileSync(file, src);
console.log(`patched ${path.basename(file)} (${src.length} bytes${speed ? "" : ", baseline"})`);
