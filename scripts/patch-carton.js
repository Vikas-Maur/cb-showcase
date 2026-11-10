// Carton in Cardboard's bundles: version history, cuts, fold in, credits and live collaboration. What each hook does,
// in Cardboard's own terms, is in carton/docs/INTEGRATION-1.5.0.md; the numbers below (H1…H13) are its hook numbers.
// It runs after the Windows patches, on the files they wrote. Each Windows patch script starts again from its pristine
// copy, so a rebuild runs both in order; this script refuses a file that already has Carton in it.
// With Carton off at run time (CARDBOARD_CARTON=0; it is on by default), every hook runs Cardboard's own code; only the .cbproj
// exclusions (H11: .carton/ and Carton's own view files) apply either way. build-windows.js --no-carton leaves this
// script out.
// Usage: node patch-carton.js --cli <cli/cardboard.mjs> <cli/chunks/chunk-AEX5IIG7.mjs>
//        node patch-carton.js --app <dist/main.js> <dist/library-worker.js> <index-*.js> <EditorRoute-*.js> <installErrorTelemetry-*.js> [tabs-*.js]
const fs = require("fs");
const path = require("path");

// CARTON_LIST_ANCHORS=1 also prints every anchor (bundle, count, offset, bytes, text): the INTEGRATION doc's appendix.
const list = process.env.CARTON_LIST_ANCHORS === "1";
const patch = (file, edits) => {
  let src = fs.readFileSync(file, "utf8");
  if (src.includes("__carton")) throw new Error(`${path.basename(file)} already has Carton's patches; run its Windows patch script first`);
  const replace = (from, to, count = 1) => {
    const n = src.split(from).length - 1;
    if (n !== count) throw new Error(`${path.basename(file)}: expected ${count} match(es), found ${n}: ${from}`);
    if (list) console.log(`${path.basename(file)}\t${n}\t@${src.indexOf(from)}\t${Buffer.byteLength(from)}B\t${JSON.stringify(from)}`);
    src = src.split(from).join(to);
  };
  edits(replace, (text) => (src = text + src));
  fs.writeFileSync(file, src);
  console.log(`patched ${path.basename(file)} for Carton (${src.length} bytes)`);
};

// The project store and timeline mirror, in the CLI's copy and the worker's. The same code, named differently.
const STORE = {
  cli: {
    who: "cli",
    // resources/cli/chunks → resources/carton
    dir: `require("node:url").fileURLToPath(new URL("../../carton/", import.meta.url))`,
    slice: "en",
    updateScoped: ["n=>rI(n,xu(n,t,r))", "n=>(__carton.on&&__carton.scope(r),rI(n,xu(n,t,r)))"],
    readBundle: ['try{t=await Wp(Me(e,ae),"utf8")}catch{return null}', 'try{t=await(__carton.on?__carton.readFile(Me(e,ae)):Wp(Me(e,ae),"utf8"))}catch{return null}'],
    // the bundle loader's parse of project.json (`ui` in the worker): the reader, named
    recover: ["let r=nt(t);if(!r)return null;let n=await Promise.all(r.media.map(", "nt"],
    install: ["d=await Ni(l),await YP(l,c)}", "d=await Ni(l),__carton.on?d=await __carton.install(l,c,this.seenOnDisk.get(t.id)?.stamp,t.stateUpdatedAt,a)===!1?null:await Ni(c):await YP(l,c)}"],
    // the envelope writeNow writes ({format, version, project, media}): the name it stringifies
    envelope: ["m=JSON.stringify(a);this.lastWritten", "a"],
    read: ["return this.seenOnDisk.set(t,{stamp:a,document:c.project}),", "c.project"],
    attach: ["n.onWritten((g,y)=>f.afterWrite(g,y));", "n,f,t"],
    revFiles: [
      ["let[u]=await this.listRevisions(r),p=u===void 0?null:await this.readRevision(r,u);", "let[u]=await this.__cartonListRevisions(r),p=u===void 0?null:await this.__cartonReadRevision(r,u);"],
      ["let d=await this.listRevisions(r);for(let u of d.slice(20))", "let d=await this.__cartonListRevisions(r);for(let u of d.slice(20))"],
    ],
    // the mirror's print (cb source print, MCP's print_timeline, timeline.tsx): Carton's exact header with Carton on
    print: ["async print(t,r=[]){return this.printTimeline(t,en(t),t.stateUpdatedAt??0,r)}", "async print(t,r=[]){let __p=__carton.on?await __carton.printed(this,t):null;return __p?this.printTimeline(__p.project,en(__p.project),__p.rev,r):this.printTimeline(t,en(t),t.stateUpdatedAt??0,r)}"],
    undoWrite: ["return await this.writeTimeline(o,c.doc,c.added),a.rev}", "return await this.writeTimeline(o,c.doc,c.added,{source:\"undo\",rev:a.rev}),a.rev}"],
    headerRev: ["h=J0(r)?bt(r):r", "h=J0(r)?(__carton.on?__carton.headerRev(bt(r),r):bt(r)):r"],
    base: ["B=await this.revisionAtOrBefore(o,h.rev)??_,", "B=(__carton.on&&typeof h.rev==\"string\"?await __carton.cartonBase(h.rev,o):await this.revisionAtOrBefore(o,h.rev))??(__carton.on?await __carton.missingRev(h.rev,_,o):_),"],
    merge: ["X=On(B,_,Y.doc,{prefer:n.prefer})", "X=__carton.on?await __carton.merge3(B,_,Y.doc,{prefer:n.prefer},On):On(B,_,Y.doc,{prefer:n.prefer})"],
    applyWrite: [
      "let g=await this.writeTimeline(i,X.doc,[...w,...Y.added]);return p({applied:!0,ops:Q,conflicts:M,diagnostics:k,rev:g?.stateUpdatedAt??i.stateUpdatedAt})",
      "let g=await this.writeTimeline(i,X.doc,[...w,...Y.added],{source:\"timeline\",rev:h.rev,actor:n.cartonActor});return p({applied:!0,ops:Q,conflicts:M,diagnostics:k,rev:g?.stateUpdatedAt??i.stateUpdatedAt,...__carton.on&&await __carton.status(t)})",
    ],
    writeTimeline: [
      ["writeTimeline(t,r,n){let o={...Fn(t,r)", "writeTimeline(t,r,n,__cm){let o={...Fn(t,r)"],
      ["return this.options.bundles.updateScoped(Vp(o),{ownedFields:[...Ss],", "return this.options.bundles.updateScoped(Vp(o),{carton:__cm,ownedFields:[...Ss],"],
    ],
    mirror: ["await rb(this.mirrorPath(t),r,\"utf8\"))}", "await(__carton.on?__carton.writeFile(this.mirrorPath(t),r):rb(this.mirrorPath(t),r,\"utf8\")))}"],
    mirrorSync: ["async sync(t,r,n=[]){await this.recordRevision(t,r);let o=await this.print(t,n);await this.writeMirror(r,o),await this.scaffold(r)}", "async sync(t,r,n=[]){await this.recordRevision(t,r);if(!(__carton.on&&await __carton.mirrorOwned(r))){let o=await this.print(t,n);await this.writeMirror(r,o)}await this.scaffold(r)}"],
    archive: ["if(a&&(pI.has(i.name)||i.name===ae)||", "if(__carton.skipInArchive(o,i.name,n)||a&&(pI.has(i.name)||i.name===ae)||"],
    agents: [['J0=e=>typeof e=="string",Q0="# This is a Cardboard project', 'J0=e=>typeof e=="string",Q0=__carton.agentsMd("# This is a Cardboard project'], ['",EA=async e=>{let t=await ho(', '"),EA=async e=>{let t=await ho(']],
    // The timeline codec's names in this copy (the store bridge's parse), each proved where Cardboard calls it
    // (proveCodec, below).
    codec: {
      names: { parse: "bt", isPath: "eb", resolvePath: "fo", luts: "K0", templates: "AA", toDoc: "bs", stored: "ms", reframe: "T0", mediaInfo: "Oo", keepIds: "Up", synth: "cc", merge: "On", withSlice: "Fn", orphans: "qn", dropOrphans: "Vp", owned: "Ss", scoped: "xu", keepDone: "rI", codeToMedia: "Oi" },
      proofs: [
        "h=J0(r)?bt(r):r",
        "pathOf:y=>eb(y)?fo(y,o):null",
        "F=L?await K0(L,h,O):null",
        "let P=await AA(h,o)",
        "j=bs(h,{resolveMedia:R,readTemplate:y=>P.get(y)??null,storedItem:ms(en(i)),newId:this.options.newId})",
        "V=await T0(B,_,T,y=>{let S=x.get(y);return(S&&Oo(S))??void 0},n.prefer),Y=cc(Up(V,_),i,this.options.newId),X=On(B,_,Y.doc,{prefer:n.prefer})",
        "writeTimeline(t,r,n){let o={...Fn(t,r),",
        "i=qn(o);return this.options.bundles.updateScoped(Vp(o),{ownedFields:[...Ss],",
        "n=>rI(n,xu(n,t,r))",
        "this.applyMutation(t,c=>Oi(r(c)),n)",
      ],
    },
  },
  worker: {
    who: "app",
    // resources/app.asar/dist → resources/carton
    dir: `require("node:path").join(__dirname, "..", "..", "carton")`,
    slice: "yc",
    updateScoped: ["n=>fJ(n,gI(n,t,r))", "n=>(__carton.on&&__carton.scope(r),fJ(n,gI(n,t,r)))"],
    readBundle: ['try{t=await(0,Wt.readFile)((0,at.join)(e,Lt),"utf8")}catch{return null}', 'try{t=await(__carton.on?__carton.readFile((0,at.join)(e,Lt)):(0,Wt.readFile)((0,at.join)(e,Lt),"utf8"))}catch{return null}'],
    recover: ["let r=ui(t);if(!r)return null;let n=await Promise.all(r.media.map(", "ui"],
    install: ["l=await Cp(c),await(0,Wt.rename)(c,s)}", "l=await Cp(c),__carton.on?l=await __carton.install(c,s,this.seenOnDisk.get(t.id)?.stamp,t.stateUpdatedAt,o)===!1?null:await Cp(s):await(0,Wt.rename)(c,s)}"],
    envelope: ["d=JSON.stringify(o);this.lastWritten", "o"],
    read: ["return this.seenOnDisk.set(t,{stamp:o,document:s.project}),", "s.project"],
    attach: ["n.onWritten((y,v)=>m.afterWrite(y,v));", "n,m,t"],
    revFiles: [
      ["let[u]=await this.listRevisions(r),p=u===void 0?null:await this.readRevision(r,u);", "let[u]=await this.__cartonListRevisions(r),p=u===void 0?null:await this.__cartonReadRevision(r,u);"],
      ["let l=await this.listRevisions(r);for(let u of l.slice(20))", "let l=await this.__cartonListRevisions(r);for(let u of l.slice(20))"],
    ],
    print: ["async print(t,r=[]){return this.printTimeline(t,yc(t),t.stateUpdatedAt??0,r)}", "async print(t,r=[]){let __p=__carton.on?await __carton.printed(this,t):null;return __p?this.printTimeline(__p.project,yc(__p.project),__p.rev,r):this.printTimeline(t,yc(t),t.stateUpdatedAt??0,r)}"],
    undoWrite: ["return await this.writeTimeline(i,s.doc,s.added),o.rev}", "return await this.writeTimeline(i,s.doc,s.added,{source:\"undo\",rev:o.rev}),o.rev}"],
    headerRev: ["h=XE(r)?Si(r):r", "h=XE(r)?(__carton.on?__carton.headerRev(Si(r),r):Si(r)):r"],
    base: ["fe=await this.revisionAtOrBefore(i,h.rev)??re,", "fe=(__carton.on&&typeof h.rev==\"string\"?await __carton.cartonBase(h.rev,i):await this.revisionAtOrBefore(i,h.rev))??(__carton.on?await __carton.missingRev(h.rev,re,i):re),"],
    merge: ["G=ld(fe,re,Ee.doc,{prefer:n.prefer})", "G=__carton.on?await __carton.merge3(fe,re,Ee.doc,{prefer:n.prefer},ld):ld(fe,re,Ee.doc,{prefer:n.prefer})"],
    applyWrite: [
      "let y=await this.writeTimeline(a,G.doc,[...b,...Ee.added]);return p({applied:!0,ops:W,conflicts:I,diagnostics:V,rev:y?.stateUpdatedAt??a.stateUpdatedAt})",
      "let y=await this.writeTimeline(a,G.doc,[...b,...Ee.added],{source:\"timeline\",rev:h.rev,actor:n.cartonActor});return p({applied:!0,ops:W,conflicts:I,diagnostics:V,rev:y?.stateUpdatedAt??a.stateUpdatedAt,...__carton.on&&await __carton.status(t)})",
    ],
    writeTimeline: [
      ["writeTimeline(t,r,n){let i={...ud(t,r)", "writeTimeline(t,r,n,__cm){let i={...ud(t,r)"],
      ["return this.options.bundles.updateScoped(CS(i),{ownedFields:[...x4],", "return this.options.bundles.updateScoped(CS(i),{carton:__cm,ownedFields:[...x4],"],
    ],
    mirror: ["await(0,rn.writeFile)(this.mirrorPath(t),r,\"utf8\"))}", "await(__carton.on?__carton.writeFile(this.mirrorPath(t),r):(0,rn.writeFile)(this.mirrorPath(t),r,\"utf8\")))}"],
    mirrorSync: ["async sync(t,r,n=[]){await this.recordRevision(t,r);let i=await this.print(t,n);await this.writeMirror(r,i),await this.scaffold(r)}", "async sync(t,r,n=[]){await this.recordRevision(t,r);if(!(__carton.on&&await __carton.mirrorOwned(r))){let i=await this.print(t,n);await this.writeMirror(r,i)}await this.scaffold(r)}"],
    archive: ["if(o&&(pJ.has(a.name)||a.name===Lt)||", "if(__carton.skipInArchive(i,a.name,n)||o&&(pJ.has(a.name)||a.name===Lt)||"],
    agents: [['XE=e=>typeof e=="string",JE="# This is a Cardboard project', 'XE=e=>typeof e=="string",JE=__carton.agentsMd("# This is a Cardboard project'], ['",hre=async e=>{', '"),hre=async e=>{']],
    codec: {
      names: { parse: "Si", isPath: "YE", resolvePath: "Yd", luts: "WE", templates: "yre", toDoc: "h4", stored: "d4", reframe: "TE", mediaInfo: "hI", keepIds: "_S", synth: "h6", merge: "ld", withSlice: "ud", orphans: "Rd", dropOrphans: "CS", owned: "x4", scoped: "gI", keepDone: "fJ", codeToMedia: "_p" },
      proofs: [
        "h=XE(r)?Si(r):r",
        "pathOf:v=>YE(v)?Yd(v,i):null",
        "J=L?await WE(L,h,K):null",
        "let E=await yre(h,i)",
        "ae=h4(h,{resolveMedia:w,readTemplate:v=>E.get(v)??null,storedItem:d4(yc(a)),newId:this.options.newId})",
        "he=await TE(fe,re,O,v=>{let _=x.get(v);return(_&&hI(_))??void 0},n.prefer),Ee=h6(_S(he,re),a,this.options.newId),G=ld(fe,re,Ee.doc,{prefer:n.prefer})",
        "writeTimeline(t,r,n){let i={...ud(t,r),",
        "a=Rd(i);return this.options.bundles.updateScoped(CS(i),{ownedFields:[...x4],",
        "n=>fJ(n,gI(n,t,r))",
        "this.applyMutation(t,s=>_p(r(s)),n)",
      ],
    },
  },
};

// A method renamed to __carton<Name> and replaced by one that asks Carton first: `async name(args){` becomes
// `name(args){return <with Carton> : this.__carton<Name>(args)}async __carton<Name>(args){`.
const around = (replace, name, args, withCarton) => {
  const own = `__carton${name[0].toUpperCase()}${name.slice(1)}`;
  replace(`async ${name}(${args}){`, `${name}(${args}){return __carton.on?${withCarton(own)}:this.${own}(${args})}async ${own}(${args}){`);
};

// The timeline codec (store bridge, globalThis.__cartonTimelineCodec) calls the bundle's own parser, converters and
// store merge by their minified names. Each name must be the function Cardboard's own apply, writeTimeline or store
// calls at one of `proofs` (each proof must match exactly once, unchanged), so a bundle where a name means something
// else stops the build here instead of misparsing at run time.
const proveCodec = (replace, s) => {
  const { names, proofs } = s.codec;
  for (const [role, name] of Object.entries({ ...names, slice: s.slice })) {
    const word = new RegExp(`(^|[^\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`);
    if (!proofs.some((p) => word.test(p))) throw new Error(`patch-carton.js: the codec's ${role} (${name}) has no proof`);
  }
  for (const p of proofs) replace(p, p);
};

const patchStore = (replace, k) => {
  const s = STORE[k];
  proveCodec(replace, s);
  // H1: one Carton change per mutation, against the exact document it was applied to; the GUI's and the apply's
  // Carton fields ride in the scope; the rename into project.json becomes displace-then-install; a document on disk
  // Carton never wrote is imported when read; the store tells the bridge where the library is.
  around(replace, "applyMutation", "t,r,n", () => "__carton.applyMutation(this,t,r,n)");
  replace(...s.updateScoped);
  // (the install is given the rev the file is written with, the project's stateUpdatedAt, so it doesn't parse the whole
  // file again to read it: writeNow has the document it just stringified; and that envelope itself, which the worker's
  // Materializer takes with the file's stamp after a GUI save instead of reading project.json again: H8's save path.
  // The proof, replaced by itself, shows the name is what writeNow stringifies)
  replace(s.envelope[0], s.envelope[0]);
  if (!s.install[1].includes(`t.stateUpdatedAt,${s.envelope[1]})`)) throw new Error("patch-carton.js: the install isn't given writeNow's envelope");
  replace(...s.install);
  // The bundle loader behind read() and the library's rescan: a project.json caught mid-install is waited for, not
  // taken for a removed project.
  replace(...s.readBundle);
  // Laptop, build 915eb36: a project.json the reader refuses (no name: Restore of "Started the cut" wrote one) in a
  // bundle whose history Carton holds is read through that history, so the library lists the project again, cb finds
  // it, and Restore in History brings it back. Cardboard's reader still decides: it parses what Carton gives, and what it
  // refuses stays unlisted, as before. Only when its own parse failed: a project it reads costs nothing more.
  // Laptop, final candidate P1-1: media entries without the dates Cardboard's editor writes back at every save (an
  // earlier build's restore or recovery wrote them so) get them as the file is read (the store bridge's `loaded`), so
  // the editor's saves land again; the next save writes them. A project whose entries have them costs one check.
  replace(s.recover[0], `let r=${s.recover[1]}(t)??(__carton.on?${s.recover[1]}(await __carton.recover(e,t)??""):null);if(!r)return null;__carton.on&&(r=__carton.loaded(e,r));let n=await Promise.all(r.media.map(`);
  // (with the file's stamp as the store read it: the facade knows a file it installed itself without reading it again,
  // and checks any other file whose rev it knows against that version: review of fix/demo-sync-bugs, P1)
  const stampVar = /stamp:([\w$]+)/.exec(s.read[0])?.[1];
  if (!stampVar) throw new Error("patch-carton.js: the store's read keeps no stamp to pass the facade");
  replace(s.read[0], `return __carton.on&&await __carton.sawDisk(this,t,${s.read[1]},${stampVar}),` + s.read[0].slice("return ".length));
  replace(s.attach[0], `${s.attach[0]}__carton.on&&__carton.attach(${s.attach[1]});`);
  // H2: the revision readers read Carton's history first. recordRevision keeps reading and pruning its own files.
  for (const [from, to] of s.revFiles) replace(from, to);
  around(replace, "listRevisions", "t", () => "__carton.listRevisions(this,t)");
  around(replace, "readRevision", "t,r", () => "__carton.readRevision(this,t,r)");
  // Laptop #2 (agents' cb edits overwrote each other): a numeric rev's base is the exact version the rev names, not the
  // first at or before it in history order (several writers' revs aren't in save order: a newer version was taken, and
  // the print's older values read as the agent's edits); .revs only for a rev older than Carton's history. And a print
  // carries Carton's exact header, its records that version's as Carton has them, so the apply merges against exactly
  // what was printed and `cb source check` of an unchanged print finds nothing.
  around(replace, "revisionAtOrBefore", "t,r", () => "__carton.revisionAtOrBefore(this,t,r)");
  replace(...s.print);
  // Cardboard 1.5.0's edit API (applyEdits: MCP apply_timeline/check_timeline with `edits`, oldText → newText) applies
  // the edits to the print they were copied from (printedAt: the version a numeric `rev` names, through the
  // revisionAtOrBefore above, else the current print, Carton's above) and hands the result to apply, so its writes take
  // every hook here. With Carton on, a print's header rev is Carton's ref ("<cut>@<seq>~<hash8> b:…"), which 1.5.0's
  // printedAt took for no rev (a string is never < stateUpdatedAt): edits copied from an older print were matched against
  // the current one. A Carton ref is printed as the version it names (cartonBase, as the apply's base is), under that
  // header, so the apply merges against exactly what the agent read; one Carton can't rebuild is the apply's "print it
  // again" error (missingRev). A numeric rev, no rev, or Carton off: 1.5.0's printedAt, unchanged.
  replace("async printedAt(t,r,n){if(n!==void 0&&n<(t.stateUpdatedAt??0)){", "async printedAt(t,r,n){if(__carton.on&&typeof n==\"string\"){let __b=await __carton.cartonBase(n,r);if(__b)return this.printTimeline(t,__b,n);await __carton.missingRev(n,null,r)}if(n!==void 0&&n<(t.stateUpdatedAt??0)){");
  replace("async history(t){", "history(t){return __carton.on?this.__cartonHistory(t).then(r=>__carton.history(this,t,r)):this.__cartonHistory(t)}async __cartonHistory(t){");
  // undo <rev> restores through writeTimeline, whose scope says so.
  replace(...s.undoWrite);
  // H3: the exact base or an error; merge3 in place of the item-level merge; the apply's write carries its header rev.
  // A file whose first rev line is Carton's ("<cut>@<seq>~<hash8> b:…", a view or the Materializer's shared file)
  // carries that ref as its rev: 1.4.0 reads only a line of digits, so its base silently became the current document.
  // The base is then the exact version Carton rebuilds (else the "print it again" error), and the write's scope names
  // that version as the commit's base. A numeric header goes on through 1.4.0's revisionAtOrBefore, as before.
  replace(...s.headerRev);
  replace(...s.base);
  replace(...s.merge);
  replace(...s.applyWrite);
  for (const [from, to] of s.writeTimeline) replace(from, to);
  replace(...s.mirror);
  // H8: after each save Cardboard's mirror prints the whole timeline and rewrites timeline.tsx (sync). Where the file
  // isn't Cardboard's (the worker's Materializer prints it, or, in cb, the worker holding the lease does), that print
  // was made, written to a temp file and deleted unread on every save: the save now skips it (recordRevision's .revs
  // and the bundle's scaffold still run). With Carton off, or where the file is Cardboard's, sync runs as in 1.4.0.
  replace(...s.mirrorSync);
  // H11: no .carton/ and none of Carton's view files in .scratch/views/ in a .cbproj (the store bridge's skipInArchive,
  // given the folder the walk reads, `n` in both copies, so it can tell Carton's files by their content).
  replace(...s.archive);
  // H8 (item 4): AGENTS.md, the text Cardboard writes into each bundle for agents, gains Carton's view flow with Carton
  // on (the store bridge's agentsMd); with Carton off it is Cardboard's text, byte for byte.
  for (const [from, to] of s.agents) replace(from, to);
};

const [mode, ...files] = process.argv.slice(2);
if (mode === "--cli") {
  const [cbFile, chunkFile] = files;
  if (!chunkFile) throw new Error("usage: node patch-carton.js --cli <cardboard.mjs> <chunk-AEX5IIG7.mjs>");
  const shim = `const require = __createRequire(import.meta.url);\n`;
  patch(chunkFile, (replace) => {
    replace(shim, shim + require("./carton/store-bridge")(STORE.cli));
    patchStore(replace, "cli");
  });
  patch(cbFile, (replace) => {
    replace(shim, shim + require("./carton/cli-bridge"));
    // @carton/cli-mcp's commands (cut, fold, credits, restore, compare, conflicts, resolve, publish, the git words),
    // registered once every Cardboard command is: Carton's history and undo take over Cardboard's when on.
    replace("var JN=uk(Ie);", "__cartonCli.commands(Ie,{options:De,open:()=>z(De()),resolve:P,out:He});var JN=uk(Ie);");
    // cb undo --turn <id> is Carton's; with Carton off it says so instead of undoing something else.
    replace(
      ".action(async(a,s)=>{let o=await z(r()),i=await P(o,a),c=await o.timeline.undo(i.id,s);",
      ".option(\"--turn <id>\",\"undo every change one agent turn made (Carton)\").action(async(a,s,__o)=>{if(__o?.turn!==void 0)await __cartonCli.undoTurn();let o=await z(r()),i=await P(o,a),c=await o.timeline.undo(i.id,s);",
    );
    // MCP: Carton serves timeline_history and undo_timeline (with cuts, stats and turns) in place of Cardboard's own,
    // and adds its tools before list_media.
    replace('p("timeline_history",', '__cartonCli.own("timeline_history")&&p("timeline_history",');
    replace('p("undo_timeline",', '__cartonCli.own("undo_timeline")&&p("undo_timeline",');
    // (`lib` as a getter, Carton UX v2 N0: the server's library `s` is set after its tools are registered, so a value
    // taken here was undefined and every Carton tool failed with "reading 'projects'"; Cardboard's own tools read it
    // when called, as this does now)
    replace('p("list_media",', '__cartonCli.mcp(p,{z:f,project:pe,resolve:x=>P(s,x),lib:()=>s,result:X}),p("list_media",');
    // Cardboard 1.5.0's apply_timeline/check_timeline take `edits` with the `rev` of the print they were copied from, a
    // whole number. With Carton on that header is Carton's ref (a string), which the schema refused; it is taken too,
    // and printedAt (patchStore) prints the version it names. With Carton off the schema is Cardboard's.
    replace('rev:f.number().int().optional().describe("With edits:', 'rev:(__cartonCli.on?f.union([f.number().int(),f.string().min(1)]):f.number().int()).optional().describe("With edits:');
    // apply-ryw: the apply's text (cb source apply, MCP's apply_timeline and check_timeline) ends with Carton's note when
    // the app's timeline.tsx doesn't show the write yet ("will show this in a moment", or held for an agent's turn), so
    // an agent that reads the file next knows why, never guessing. Nothing is added when it shows it, or with Carton off.
    replace(
      "for(let u of t.matched)a.push(`matched: ${u.name} (${u.id}) ${u.distanceBefore} -> ${u.distanceAfter}`);return a.join(`\n`)},Nr=",
      "for(let u of t.matched)a.push(`matched: ${u.name} (${u.id}) ${u.distanceBefore} -> ${u.distanceAfter}`);typeof t.carton?.note==\"string\"&&a.push(t.carton.note);return a.join(`\n`)},Nr=",
    );
  });
} else if (mode === "--app") {
  const [mainFile, workerFile, indexFile, editorFile, storeFile, tabsFile] = files;
  if (!storeFile) throw new Error("usage: node patch-carton.js --app <main.js> <library-worker.js> <index-*.js> <EditorRoute-*.js> <installErrorTelemetry-*.js>");
  patch(workerFile, (replace, prepend) => {
    patchStore(replace, "worker");
    // H8: a `carton` namespace in the worker's RPC table, for main's carton:call; its events go to main as changes.
    // (1.5.0's table has its new "audioProcessing" namespace, the audio clean-up; Carton's goes last)
    replace('var SR=["projects","media","cache","transcripts","voiceovers","mattes","audioProcessing","inspect","timeline","luts","downloads"];', 'var SR=["projects","media","cache","transcripts","voiceovers","mattes","audioProcessing","inspect","timeline","luts","downloads","carton"];');
    replace('Lie=e=>{let t="",r=()=>{', 'Lie=e=>{e.carton=__carton.on?__carton.worker(e,c=>Rc({kind:"change",change:c})):{};let t="",r=()=>{');
    // H8: where the worker's Materializer runs for the bundle (sync/views.js), timeline.tsx is its own: a change of it
    // goes to the Materializer (a foreign save is applied there, with its freeze and credit), not to Cardboard's apply.
    replace("c=async g=>{let T=t.idForBundlePath(g);if(!T)return;", "c=async g=>{let T=t.idForBundlePath(g);if(!T)return;if(__carton.on&&__carton.timelineOwned(g))return void __carton.timelineEvent(g);");
    // A timeline.tsx the watcher applies was saved outside the app: an agent without Cardboard's hooks or an editor.
    replace("await t.read(T);let x=await r.apply(T,k);", "await t.read(T);let x=await r.apply(T,k,{cartonActor:\"external:timeline.tsx\"});");
    // The watcher reads project.json 150 ms after a change and tells the pages the project was removed if it's
    // missing; an apply from the file reads timeline.tsx. Both wait out an install's gap (the bridge's readFile).
    replace('k=await(0,cl.readFile)((0,ri.join)(g,Lt),"utf8")}catch{k=null}', 'k=await(__carton.on?__carton.readFile((0,ri.join)(g,Lt)):(0,cl.readFile)((0,ri.join)(g,Lt),"utf8"))}catch{k=null}');
    replace('let $=await(0,Ur.readFile)(m.mirrorPath(D),"utf8");return m.apply(y,$,{..._,writeBack:!0})', 'let $=await(__carton.on?__carton.readFile(m.mirrorPath(D)):(0,Ur.readFile)(m.mirrorPath(D),"utf8"));return m.apply(y,$,{..._,writeBack:!0})');
    // The bundle has no banner line; the bridge goes first.
    prepend(require("./carton/store-bridge")(STORE.worker));
  });
  patch(mainFile, (replace) => {
    replace("var rCe=Object.create;", require("./carton/main-bridge") + "var rCe=Object.create;");
    // H1: the GUI save's Carton fields (base, after, actor, intents) reach the worker in the scope.
    replace(
      '_e.handle("project:patch",async({document:t,scope:r})=>{',
      '__cartonMain.library(wt),_e.handle("carton:call",({method:t,args:r})=>__cartonMain.call(t,r??[])),_e.handle("project:patch",async({document:t,scope:r,carton:__cm})=>{',
    );
    replace('wt.call("projects.updateScoped",t,r)', '__cartonMain.time(wt.call("projects.updateScoped",t,__cartonMain.on&&__cm?{...r,carton:{...__cm,actor:"person"}}:r))');
    // H5: a project change while Carton is on takes the pages' Carton path (adopt without an undo entry).
    replace('e.tabs.broadcast("project:changed",{id:i,stateUpdatedAt:o.stateUpdatedAt,...s})', 'e.tabs.broadcast("project:changed",{id:i,stateUpdatedAt:o.stateUpdatedAt,...s,...__cartonMain.on&&{carton:!0}})');
    // H8: the worker's Carton events go to every tab.
    replace('onChange:async i=>{if(i.kind==="removed"){n(i.id);return}', 'onChange:async i=>{if(i.kind==="carton"){e.tabs.broadcast("carton:event",i);return}if(i.kind==="removed"){n(i.id);return}');
    // H9: who is acting, for every agent main starts (agentEnv: the agents deps.spawn starts, Codex in 1.4.0).
    // The title bar's History and Share icons (the tab strip, tabsFile below): their commands go to the active tab's
    // page as carton:command (not menu:action, which Cardboard logs and maps to native commands), and the page's report
    // of the panel open (carton:panel) joins the tab's editor state, which the strip draws from. Carton off: neither.
    // For a shared project the report also carries a small live summary (sync state, who is here: UI audit P2-11),
    // and the strip gets {panel, live} instead of the panel's name alone. The cut chip (Carton UX redesign PLAN 2.1)
    // adds the cut and what is being viewed to the report, and its own commands (carton-cuts, carton-back); the cut
    // chip and Share hand the keyboard to the page they open something in (main-bridge.js takesKeys), so the cuts
    // menu and the Share dialog take arrows and Esc at once, not after a click. The chip's click also carries where
    // the chip is and whether its menu opens or closes (PLAN 2.2 v2: the editor's page draws the menu under the chip);
    // main-bridge.js command passes only those fields on, checked.
    replace("command(t){let r=this.activeContents();if(r){", "command(t){let r=this.activeContents();if(r){if(__cartonMain.on&&/^carton-/.test(t?.action??\"\")){__cartonMain.takesKeys(t.action)&&r.focus();_e.emit(r,\"carton:command\",__cartonMain.command(t));return}");
    replace("setEditorState(t,r){let n=this.tabIdOf(t);n&&this.model.setEditorState(n,r)}", "__cartonPanel(t,r){let n=this.tabIdOf(t);n&&this.model.__cartonPanel(n,r)}setEditorState(t,r){let n=this.tabIdOf(t);n&&this.model.setEditorState(n,r)}");
    replace("setEditorState(t,r){let n=this.tabById(t);!n||n.editor?.aspectRatio===r.aspectRatio&&n.editor.directorCollapsed===r.directorCollapsed&&nZt(n.editor.credits,r.credits)||(n.editor=r,this.changed())}", "__cartonPanel(t,r){let n=this.tabById(t);if(!n)return;n.__cartonPanel=r;n.editor&&n.editor.cartonPanel!==r&&(n.editor={...n.editor,cartonPanel:r},this.changed())}setEditorState(t,r){let n=this.tabById(t);!n||n.editor?.aspectRatio===r.aspectRatio&&n.editor.directorCollapsed===r.directorCollapsed&&nZt(n.editor.credits,r.credits)||(n.editor=n.__cartonPanel===void 0?r:{...r,cartonPanel:n.__cartonPanel},this.changed())}");
    replace('_e.handle("window:set-editor-state",(t,r)=>fe.setEditorState(r.sender,t)),', '_e.handle("window:set-editor-state",(t,r)=>fe.setEditorState(r.sender,t)),_e.handle("carton:panel",(t,r)=>{__cartonMain.on&&fe.__cartonPanel(r.sender,__cartonMain.panel(t))}),');
    replace("this.deps.spawn(o.path,c.args(p),{cwd:i.bundlePath,env:b})", "this.deps.spawn(o.path,c.args(p),{cwd:i.bundlePath,env:__cartonMain.agentEnv(b,a.provider,s)})");
    replace("env:YGt(e,t,c),", "env:__cartonMain.directorEnv(YGt(e,t,c),t,()=>e.turnId(t.project.id,t.chatId)),");
    // H9: the Bash hook of Cardboard's Agent SDK transport (oH) names who runs each cb call; Stop and SubagentStop
    // return late conflicts. oH runs two agents in 1.4.0: the Director (RVt) and the person's own Claude Code (v_e,
    // provider "claude"; deps.spawn never starts it). Laptop #8: main-bridge's hookActor names the Director's turn
    // (director/<chat>/<turn>) and the person's Claude Code claude-code/<session>, never the Director.
    replace('PreToolUse:[{matcher:"Bash",hooks:[async v=>{', 'PreToolUse:[{matcher:"Bash",hooks:[__cartonMain.directorHook(e,async v=>{');
    // H8: and its Read/Write/Edit calls reach the worker's Materializer (the shared timeline.tsx's freeze, credit).
    // Regress prod4 (director-hold): fileHooks also hooks Claude Code's PowerShell tool, which 1.4.0's transport hooked
    // nowhere (a turn's cb calls and long pings there held nothing); main keeps a running turn's hold alive itself.
    replace("permissionDecisionReason:k.reason}}}],timeout:WBt}]}", "permissionDecisionReason:k.reason}}})],timeout:WBt},...__cartonMain.fileHooks(e)],...__cartonMain.stopHooks(e)}");
    // H9: each in-app agent's turn (the Director's, the person's own Claude Code's, Codex's) ends here (closeTurn: the
    // stream's result, an interrupt, an error): its hold on timeline.tsx ends, and its last version is named from the
    // turn's prompt (as the chat's checkpoints are); the label stays in the project's history. The transport, and so its
    // hooks, outlives the turn (n.process): review P2 (lap2), each start and end is a new turn generation in main-bridge,
    // so a hook still waiting at the end (an interrupted turn's Stop) sends nothing after it, and the turn's name request
    // carries its end (a late one never takes the next turn's version).
    replace('n.turn={state:"running",id:s.id,text:s.text}', 'n.turn={state:"running",id:s.id,text:s.text},__cartonMain.turnStarted(n,t,i.project?.bundlePath,s,i.launch?.provider)');
    replace('closeTurn(t,r){t.turn.state==="running"&&', 'closeTurn(t,r){__cartonMain.turnEnded(t,r);t.turn.state==="running"&&');
    // Item 4 (laptop, 2026-11-05): an agent turn's version is titled in a few words once it ends, the way 1.4.0 names its
    // chats (fJt, its chat namer): the person's signed-in Claude Code, else Codex (Axe), through its own naming call
    // (lSe: haiku with a system prompt, no tools, no hooks, no MCP, no slash commands, no session kept; codex exec
    // read-only; the answer's first line, at most 6 words and 40 characters, else null). Handed to main-bridge's namer()
    // where fJt is defined; fJt itself is unchanged. lSe gets Pxe's own arguments and a longer timeout than its 3 s, as
    // nothing waits for a title and a cold start of the agent's binary on Windows can take that long.
    replace('fJt=async e=>{let t=await Axe();return t?Pxe(t,aSe(e),sSe):null}', 'fJt=(__cartonMain.namer((e,r,o)=>Axe().then(t=>t?lSe({binary:t,prompt:e,instruction:r,env:kq(t),cwd:oe.app.getPath("temp"),spawn:(n,i,s)=>(0,_q.spawn)(n,i,{...s,stdio:["pipe","pipe","pipe"],windowsHide:!0}),timeoutMs:o,warn:n=>console.warn(`[naming] ${n}`)}):null)),async e=>{let t=await Axe();return t?Pxe(t,aSe(e),sSe):null})');
    // H9: a Claude Code started as a process (its args) gets the same hooks through --settings. 1.4.0 runs its Claude
    // Code through the Agent SDK transport instead (the hooks above), so this reaches it only if a build spawns it.
    replace('"--append-system-prompt",Bu(e),', '"--append-system-prompt",Bu(e),...__cartonMain.hostSettings(),');
    // H8 (item 4): every agent's appended system prompt (ju: the Director, host Claude Code, Codex, the others) gains
    // Carton's view flow with Carton on; with Carton off the list is Cardboard's.
    replace('Never write `project.json` directly.",', 'Never write `project.json` directly.",...__cartonMain.viewPrompt(e),');
  });

  // H4, H6, H7: the editor store (installErrorTelemetry-*.js). The bridge goes first; it waits for the store's handles.
  patch(storeFile, (replace, prepend) => {
    // `refuse` is Cardboard's own guard of its edits (me(): true and its "read-only" note over the timeline when a write
    // is blocked, as in a preview): the bridge's refuse() uses it for the stage's text editor (baseline P3-9).
    // `subscribe` (the store's, zustand's (state, prev)) and `clock` (its playback clock, $x, exported as aK: the
    // playhead while playing) let a preview tell the person's moves of the playhead from its own (final re-check N5).
    replace("ne.setState=nN({getState:ne.getState,isWriteBlocked:km,onAcceptedDocumentWrite:iN,onRejectedWrite:_v,setState:Tm});", "ne.setState=nN({getState:ne.getState,isWriteBlocked:km,onAcceptedDocumentWrite:iN,onRejectedWrite:_v,setState:Tm});window.__carton.store({state:ne.getState,raw:Tm,adopt:Mde,armed:Nde,inflight:()=>Xy.size>0,flush:()=>lN().work,invoke:On,on:PI,deserialize:sv,projects:De,refuse:me,subscribe:ne.subscribe,clock:$x.get});");
    // H4: the save names the version the editor shows; initializeEditor starts from the project's.
    // H4 (one action, one save): and a media entry an editor action owns goes with that action's timeline save (send answers its own save
    // with that one), so one action is one version and one undo step (laptop, merge/prod-2 N-1).
    replace('updateScoped:(t,e)=>Qp(t.id,lK(e),On("project:patch",{document:t,scope:e}))', 'updateScoped:(t,e)=>Qp(t.id,lK(e),window.__carton.send(t,e,()=>On("project:patch",{document:t,scope:e,carton:window.__carton.saveMeta(t,e)})))');
    // H4 (one action, one save): deleting a title or code graphic drops the media entry it owns (Kx, after removeTimelineItem(s) armed the
    // timeline save): noted as that action's, so the timeline save carries it. Both of the timeline save's call sites
    // (the 300 ms debounce, de(), and its flush, cN()) board what their action noted.
    replace("(rN.set(o.id,o),r.removeMediaFromProject(i.id,o.id).catch(()=>{}))", "(rN.set(o.id,o),window.__carton.ride(i.id,{removedMediaIds:[o.id]}),r.removeMediaFromProject(i.id,o.id).catch(()=>{}))");
    replace('c=cN(Jt(o,{ownedFields:["tracks","timelineItems"]}),r,"Failed to save timeline to IndexedDB:")', 'c=cN(Jt(o,window.__carton.board(r,{ownedFields:["tracks","timelineItems"]})),r,"Failed to save timeline to IndexedDB:")');
    replace('s=cN(Jt({...r,tracks:n.tracks,timelineItems:i,updatedAt:new Date},{ownedFields:["tracks","timelineItems"]}),t,"Failed to flush timeline to IndexedDB:")', 's=cN(Jt({...r,tracks:n.tracks,timelineItems:i,updatedAt:new Date},window.__carton.board(t,{ownedFields:["tracks","timelineItems"]})),t,"Failed to flush timeline to IndexedDB:")');
    // H6: the editor's session starts here (Ctrl+Z never goes back past it), with nothing to undo or redo yet.
    replace('Tm({projectId:n,projectName:r,activeLeftTab:"media",', 'Tm({cartonBase:a?.stateUpdatedAt??null,cartonPreview:null,cartonSince:Date.now(),cartonCanUndo:!1,cartonCanRedo:!1,projectId:n,projectName:r,activeLeftTab:"media",');
    // H4: a preview of an earlier version is read-only, says so, and is never saved.
    replace('km=t=>sh()||t.timelineLockState!=="unlocked"', 'km=t=>!!t.cartonPreview||sh()||t.timelineLockState!=="unlocked"');
    replace("fre=t=>sh()?oN:", "fre=t=>t.cartonPreview?window.__carton.previewMessage:sh()?oN:");
    replace("(n===sN||n===aN||n===oN)&&", "(n===sN||n===aN||n===oN||n===window.__carton.previewMessage)&&");
    // Carton UX redesign PLAN 1.4: an edit tried while viewing gets Carton's one line ("You're looking at …" with Back to
    // my edit, and a pulse of the stage's frame) in place of Cardboard's note over the timeline. xv is where Cardboard
    // raises that note for every edit its guard refuses (me(), and the store's own rejected writes), so every path it
    // guards keeps its guard: this changes only what is said, and only in a Carton preview (cartonPreview is never set
    // with Carton off). With no Carton part of the page to say it, Cardboard's note says it, in Carton's words above.
    replace("function _v(){const t=ne.getState(),e=fre(t);", "function _v(){const t=ne.getState();if(t.cartonPreview&&window.__carton.blocked())return;const e=fre(t);");
    replace("function de(){const e=ne.getState().projectId;", "function de(){if(ne.getState().cartonPreview)return;const e=ne.getState().projectId;");
    // Laptop, final candidate P1-1: a save that fails in the page (its project couldn't be written out: there, media
    // entries with no dates) was only logged, and every edit was lost unseen. The bridge tells the person (a toast over
    // the stage); Cardboard's own handling (log, rethrow) is unchanged.
    replace('throw console.error("Failed to update scoped project data:",n),n', 'throw window.__carton?.saveFailed?.(n),console.error("Failed to update scoped project data:",n),n');
    // H6: undo and redo of the person's actor group.
    replace("undo:()=>{if(me())return;const n=e();", "undo:()=>{if(window.__carton.undo())return;if(me())return;const n=e();");
    replace("redo:()=>{if(me())return;const n=e();", "redo:()=>{if(window.__carton.redo())return;if(me())return;const n=e();");
    // H7: what ripple, gap and silence deletes and splits moved, for the next save.
    replace('e().pushTimelineHistory("rippleDeleteGap"),t({timelineItems:s.timelineItems})', 'e().pushTimelineHistory("rippleDeleteGap"),window.__carton.intent({kind:"remap",tracks:[n],at:i,delta:r-i}),t({timelineItems:s.timelineItems})');
    replace('e().pushTimelineHistory("rippleDeleteAllGaps"),t({timelineItems:i.timelineItems})', 'e().pushTimelineHistory("rippleDeleteAllGaps"),window.__carton.intent({kind:"remap",tracks:[n],gaps:r}),t({timelineItems:i.timelineItems})');
    replace('return e().pushTimelineHistory("removeSilences"),t(c=>({', 'return e().pushTimelineHistory("removeSilences"),r.results.forEach(c=>window.__carton.intent({kind:"remap",tracks:[c.sourceItem.trackId],at:c.sourceItem.endTime,delta:-c.timeSaved,lineage:{from:c.itemId,to:c.newItemIds}})),t(c=>({');
    replace('i?.skipHistory||e().pushTimelineHistory("splitTimelineItem")', 'window.__carton.intent({kind:"split",id:n,at:r,into:[a.firstClip.id,a.secondClip.id]}),i?.skipHistory||e().pushTimelineHistory("splitTimelineItem")');
    // Carton UX v2 (N0, DESIGN-V2 §2.1): an export that finished is an Exported landmark. Rx is where the editor hands
    // every telemetry event to main (export_completed: the Export dialog's, with its resolution); the bridge only notes
    // it (one worker call, not awaited), and Cardboard's own capture runs as before.
    replace("Ex=(t,e)=>{const n=iee(t,e)??ree(t,e)", 'Ex=(t,e)=>{t==="export_completed"&&window.__carton?.exported?.(e);const n=iee(t,e)??ree(t,e)');
    prepend(require("./carton/renderer-bridge"));
  });
  // H5: the main bundle (index-*.js) adopts a Carton change through the bridge.
  patch(indexFile, (replace) => {
    replace("pO=async(e,t)=>{const{id:a,timeline:n,artefacts:s}=t;", "pO=async(e,t)=>{if(t.carton&&window.__carton?.on){const __r=await window.__carton.receive(e,t);if(__r)return __r}const{id:a,timeline:n,artefacts:s}=t;");
    // Carton UX redesign PLAN 1.6 (DESIGN §9): an agent's scripted export (export.start, which opens Export on the
    // editor's timeline) never exports a version the person is viewing: back to their edit first (the bridge's
    // beforeExport, null when nothing is viewed or Carton is off), then the export as before.
    replace('"export.start":async e=>{const t=Es();if(t.isExporting)', '"export.start":async e=>{const __b=window.__carton?.beforeExport?.();__b&&await __b;const t=Es();if(t.isExporting)');
  });
  // Carton in the editor (EditorRoute-*.js, editor-panel.js, scripts/carton/ui.js): the History or Share panel, a
  // full-height column beside the agent's chat sidebar; and a layer over the stage (the preview's column) with the
  // conflict cards' floating stack and viewing's frame (UX redesign PLAN 1.1, in place of the preview banner). With
  // Carton off the editor's row and stage are Cardboard's.
  patch(editorFile, (replace, prepend) => {
    replace('return c.jsx("div",{className:"flex flex-1 flex-col overflow-hidden bg-muted/60",children:c.jsxs("div",{ref:Ye,', 'return c.jsx(window.__carton?.on?__cbCartonStageHost:"div",{className:"flex flex-1 flex-col overflow-hidden bg-muted/60",children:c.jsxs("div",{ref:Ye,');
    // Carton UX redesign PLAN 1.5: the timeline's wrapper (EditorRoute's "editor-timeline" region, a display:contents
    // div round aZ, the timeline) is editor-panel.js's __cbCartonTimeline, which renders the same div and, with Carton
    // on, data-carton-viewing while viewing (the timeline's frame, its clips muted: ui.js TIMELINE_CSS) and
    // data-carton-cut on a cut other than Main (its name and dot in the timeline's toolbar). With Carton off it renders
    // Cardboard's div as it is. Always this component, whether Carton is on or not yet known, so the timeline is never
    // mounted again when main's answer comes.
    replace('c.jsx("div",{className:"contents","data-analytics-region":"editor-timeline",children:c.jsx(xZ,{})})', 'c.jsx(__cbCartonTimeline,{className:"contents","data-analytics-region":"editor-timeline",children:c.jsx(xZ,{})})');
    // Compare in the editor (UX v2, N1), unchanged text only: what editor-panel.js's second player and Compare's stage
    // and timeline layers rely on, so a Cardboard that renamed or reshaped one fails here, not in the app. The preview
    // engine's hook (sF) with its props and its own clock when not driven by the playback clock (Ce); its answer's canvas;
    // the playback clock (dn), the aspect ratio's size (D2) and the editor store (U) in this bundle's imports; the stage's
    // picture wrapper (Side by side moves it to the right half); the timeline's scroll area, tracks surface and track rows
    // (the marks sit on the surface, at each clip's start × pixelsPerSecond on its track's row).
    for (const anchor of [
      "function sF(e){const{width:t,height:n,timelineItems:a,tracks:r,mediaItems:s,currentTime:i,isPlaying:l,masterVolume:d,enabled:u,",
      "drivenByExternalClock:T=!1,", "Ce=l&&!T,", "return{diagnostics:A,getDecoderDiagnostics:yt,frameScheduler:F,canvasRef:M,isReady:Ne,",
      "aK as dn,", "fX as D2,", "aF as U,", "dv as ja,",
      'children:[c.jsx("div",{className:"absolute inset-0 flex items-center justify-center",style:{transform:`translate(${C.x}px, ${C.y}px) scale(${C.scale})`,',
      'className:"timeline-horizontal-scrollbar relative flex flex-1 flex-col overflow-x-auto overflow-y-hidden","data-timeline-scroll":!0',
      '"data-timeline-canvas-surface":!0', '"data-track-id":r.id,', "pixelsPerSecond:N.pixelsPerSecond",
    ]) replace(anchor, anchor);
    // Carton UX redesign PLAN 1.6 (DESIGN §9): Export (sZ: Ctrl+E, the title bar's Export, the menu) never exports a
    // version the person is viewing. While viewing, the bridge's beforeExport goes back to their edit first (the toast
    // "Back to your edit to export it.") and Export opens once the editor shows it, asked once (__again); if going back
    // fails, Export doesn't open. Nothing viewed, or Carton off: null, and Export opens at once, as before.
    replace("vZ=e=>{U.getState().setIsPlaying(!1),", "vZ=(e,__again)=>{const __b=!__again&&window.__carton?.beforeExport?.();if(__b){__b.then(()=>vZ(e,!0),()=>{});return}U.getState().setIsPlaying(!1),");
    // H6: the undo and redo buttons say what Carton has left to undo and redo (the bridge's cartonCanUndo/Redo), not
    // the editor's own snapshot stacks, which Carton's undo never pops. During a read-only preview neither applies
    // (Ctrl+Z already does nothing there), so both look unavailable (UI audit P3-12).
    replace("y=U(_=>_.historyPast.length>0),g=U(_=>_.historyFuture.length>0)", "y=U(_=>window.__carton?.on?!!_.cartonCanUndo&&!_.cartonPreview:_.historyPast.length>0),g=U(_=>window.__carton?.on?!!_.cartonCanRedo&&!_.cartonPreview:_.historyFuture.length>0)");
    replace('b&&c.jsx(eP,{variant:"project"})]}),c.jsx("div",{className:"contents","data-analytics-region":"editor-chat",', 'b&&c.jsx(eP,{variant:"project"})]}),...window.__carton?.on?[c.jsx(__cbCartonSide,{},"carton-side")]:[],c.jsx("div",{className:"contents","data-analytics-region":"editor-chat",');
    // Baseline P3-9 (final re-check N3): in a read-only preview the stage's text editor opened, from Enter on a selected
    // title and from a double-click on a title or caption, and dropped what was typed (opening it is no write, so
    // Cardboard's guard of its edits never saw it). Both ask the bridge first, which refuses only in a Carton preview,
    // through Cardboard's own refusal (its guard, then xv: the edit-attempt toast, PLAN 1.4). Crop mode, the
    // double-click's other branch, is refused by Cardboard's guard already.
    replace('ue=o.useCallback(()=>{B&&B.type==="text"&&!pe&&(', 'ue=o.useCallback(()=>{B&&B.type==="text"&&!pe&&!window.__carton?.refuse?.()&&(');
    replace('const Pe=Fs(Te,Y.clientX,Y.clientY);if(Pe&&(Pe.type==="text"||Pe.type==="caption")){', 'const Pe=Fs(Te,Y.clientX,Y.clientY);if(Pe&&(Pe.type==="text"||Pe.type==="caption")){if(window.__carton?.refuse?.())return;');
    // Regress prod3 (baseline P3-9 family): in a read-only preview a selected title or caption still showed the stage's
    // text toolbar (font, size, bold, alignment…), which Cardboard's guard then refused. It isn't shown there: nothing
    // in a preview looks editable. The preview's opening and its Return both replace the timeline (the bridge's adopt),
    // so the stage renders again then and reads the store's state as it is.
    replace("vn=B&&fe&&!p&&dt&&!pe&&!M&&!x?{item:B", "vn=B&&fe&&!p&&dt&&!pe&&!M&&!x&&!U.getState().cartonPreview?{item:B");
    // H4 (one action, one save): adding a title (iu) adds its "Text: …" media entry and the timeline item (addTimelineItem armed the timeline
    // save), then saves the entry on its own: noted as that action's, so the title and its entry are one version.
    replace("const g=je.getState().getProjectById(a)??f;return St(async()=>{const{updateProjectScoped:b}", "const g=je.getState().getProjectById(a)??f;window.__carton?.ride?.(a,{ownedMediaIds:[m]});return St(async()=>{const{updateProjectScoped:b}");
    prepend(require("./carton/editor-panel"));
  });
  // The title bar's Carton parts (tabs-*.js, the tab strip; strip-buttons.js), only on a tab whose editor reports
  // Carton's panel state: the cut chip (Carton UX redesign PLAN 2.1) before Cardboard's own "16:9 ⌄" (Bt), so the cut
  // sits beside the project settings where people look for them; the History and Share icons before "Report an
  // issue" (Ut). One anchor for both: the editor controls' row (Wt), aspect ratio, credits, report. A build without the
  // strip's file leaves it as it is.
  if (tabsFile) patch(tabsFile, (replace, prepend) => {
    replace(
      "n.jsx(Bt,{value:t.aspectRatio}),t.credits&&n.jsx(Ot,{credits:t.credits}),n.jsx(Ut,{}),",
      "t.cartonPanel!==void 0&&n.jsx(__cbCartonCutChip,{panel:t.cartonPanel}),n.jsx(Bt,{value:t.aspectRatio}),t.credits&&n.jsx(Ot,{credits:t.credits}),t.cartonPanel!==void 0&&n.jsx(__cbCartonStrip,{panel:t.cartonPanel}),n.jsx(Ut,{}),",
    );
    // The editor controls' row (Wt) may shrink (QA G4): in a narrow window the cut chip, the one part of it that gives
    // way (min-w-0 shrink), shortens before the row pushes the window's own buttons out of the title bar. Its other
    // parts keep their size, so without Carton's chip nothing in the row changes.
    replace('className:"mr-[8px] ml-2 flex shrink-0 items-center gap-[8px] self-center"', 'className:"mr-[8px] ml-2 flex min-w-0 shrink items-center gap-[8px] self-center"');
    // The tabs keep room for one project tab whole (its ✕) and the New project "+" after it, so the chip gives way
    // before they do (laptop: at 960 px while comparing, "+" sat on the project tab's ✕, and its click started a new
    // project). Four parts, inline (the strip's stylesheet has only the classes Cardboard uses):
    // - the tabs area takes at least what its parts need (min-content), so the controls' row, which may shrink, does;
    // - the scrolling list of project tabs counts as one tab and the "+" there (8rem + 32 px: contain: inline-size keeps
    //   its tabs' own widths out of that), and fills the rest as before;
    // - the tabs never shrink below their 8rem together: past that the list scrolls (its edge fade says so) with "+" at
    //   its end, where before the tabs ran on under the "+" (Cardboard 1.4.0 does it with many tabs too).
    replace('n.jsxs("div",{className:"flex min-w-0 flex-1 items-center pr-2 pl-[max(6px,var(--desktop-controls-inset)_+_4px)]",children:[', 'n.jsxs("div",{className:"flex min-w-0 flex-1 items-center pr-2 pl-[max(6px,var(--desktop-controls-inset)_+_4px)]",style:{minWidth:"min-content"},children:[');
    replace('n.jsxs("div",{ref:l,style:Ue(d),onWheel:Ge,', 'n.jsxs("div",{ref:l,style:{...Ue(d),contain:"inline-size",minWidth:k?"calc(8rem + 32px)":void 0},onWheel:Ge,');
    replace('n.jsx(nt,{as:"div",axis:"x",values:b,onReorder:x,className:"flex min-w-0 items-center gap-[2px]",', 'n.jsx(nt,{as:"div",axis:"x",values:b,onReorder:x,className:"flex min-w-0 items-center gap-[2px]",style:{minWidth:y.length?`calc(${y.length} * 8rem + ${(y.length-1)*2}px)`:void 0},');
    // - "+" is the 28 px button its class asks for: the strip's stylesheet puts W's w-full after w-[28px], so it was as
    //   wide as the tab list, its glyph in the middle of that, and a click anywhere there started a new project
    replace('className:w(W,"ml-[2px] w-[28px] shrink-0 justify-center",K),children:n.jsx(We,', 'className:w(W,"ml-[2px] w-[28px] shrink-0 justify-center",K),style:{width:28},children:n.jsx(We,');
    prepend(require("./carton/strip-buttons"));
  });
} else {
  throw new Error("usage: node patch-carton.js --cli <cardboard.mjs> <chunk-AEX5IIG7.mjs> | --app <main.js> <library-worker.js> <index-*.js> <EditorRoute-*.js> <installErrorTelemetry-*.js>");
}
