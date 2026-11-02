// Carton in Cardboard's bundles: version history, cuts, fold in, credits and live collaboration. What each hook does,
// in Cardboard's own terms, is in carton/docs/INTEGRATION-1.4.0.md; the numbers below (H1…H13) are its hook numbers.
// It runs after the Windows patches, on the files they wrote. Each Windows patch script starts again from its pristine
// copy, so a rebuild runs both in order; this script refuses a file that already has Carton in it.
// With Carton off at run time (CARDBOARD_CARTON is not "1"), every hook runs Cardboard's own code; only the .cbproj
// exclusions (H11: .carton/ and Carton's own view files) apply either way. build-windows.js --no-carton leaves this
// script out.
// Usage: node patch-carton.js --cli <cli/cardboard.mjs> <cli/chunks/chunk-LL26E55H.mjs>
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
    slice: "Cr",
    updateScoped: ["n=>qx(n,pd(n,t,r))", "n=>(__carton.on&&__carton.scope(r),qx(n,pd(n,t,r)))"],
    readBundle: ['try{t=await jm(Pe(e,re),"utf8")}catch{return null}', 'try{t=await(__carton.on?__carton.readFile(Pe(e,re)):jm(Pe(e,re),"utf8"))}catch{return null}'],
    // the bundle loader's parse of project.json (`ti` in the worker): the reader, named
    recover: ["let r=qe(t);if(!r)return null;let n=await Promise.all(r.media.map(", "qe"],
    install: ["d=await Qo(l),await Bx(l,c)}", "d=await Qo(l),__carton.on?d=await __carton.install(l,c,this.seenOnDisk.get(t.id)?.stamp,t.stateUpdatedAt,a)===!1?null:await Qo(c):await Bx(l,c)}"],
    // the envelope writeNow writes ({format, version, project, media}): the name it stringifies
    envelope: ["u=JSON.stringify(a);this.lastWritten", "a"],
    read: ["return this.seenOnDisk.set(t,{stamp:a,document:c.project}),", "c.project"],
    attach: ["n.onWritten((h,y)=>f.afterWrite(h,y));", "n,f,t"],
    revFiles: [
      ["let[m]=await this.listRevisions(r),p=m===void 0?null:await this.readRevision(r,m);", "let[m]=await this.__cartonListRevisions(r),p=m===void 0?null:await this.__cartonReadRevision(r,m);"],
      ["let d=await this.listRevisions(r);for(let m of d.slice(20))", "let d=await this.__cartonListRevisions(r);for(let m of d.slice(20))"],
    ],
    // the mirror's print (cb source print, MCP's print_timeline, timeline.tsx): Carton's exact header with Carton on
    print: ["async print(t,r=[]){return this.printTimeline(t,Cr(t),t.stateUpdatedAt??0,r)}", "async print(t,r=[]){let __p=__carton.on?await __carton.printed(this,t):null;return __p?this.printTimeline(__p.project,Cr(__p.project),__p.rev,r):this.printTimeline(t,Cr(t),t.stateUpdatedAt??0,r)}"],
    undoWrite: ["return await this.writeTimeline(o,c.doc,c.added),a.rev}", "return await this.writeTimeline(o,c.doc,c.added,{source:\"undo\",rev:a.rev}),a.rev}"],
    headerRev: ["g=Nh(r)?rt(r):r", "g=Nh(r)?(__carton.on?__carton.headerRev(rt(r),r):rt(r)):r"],
    base: ["B=await this.revisionAtOrBefore(o,g.rev)??j,", "B=(__carton.on&&typeof g.rev==\"string\"?await __carton.cartonBase(g.rev,o):await this.revisionAtOrBefore(o,g.rev))??(__carton.on?await __carton.missingRev(g.rev,j,o):j),"],
    merge: ["Z=rn(B,j,J.doc,{prefer:n.prefer})", "Z=__carton.on?await __carton.merge3(B,j,J.doc,{prefer:n.prefer},rn):rn(B,j,J.doc,{prefer:n.prefer})"],
    applyWrite: [
      "let h=await this.writeTimeline(i,Z.doc,[...w,...J.added]);return p({applied:!0,ops:se,conflicts:A,diagnostics:_,rev:h?.stateUpdatedAt??i.stateUpdatedAt})",
      "let h=await this.writeTimeline(i,Z.doc,[...w,...J.added],{source:\"timeline\",rev:g.rev,actor:n.cartonActor});return p({applied:!0,ops:se,conflicts:A,diagnostics:_,rev:h?.stateUpdatedAt??i.stateUpdatedAt,...__carton.on&&await __carton.status(t)})",
    ],
    writeTimeline: [
      ["writeTimeline(t,r,n){let o={...Aa(t,r)", "writeTimeline(t,r,n,__cm){let o={...Aa(t,r)"],
      ["return this.options.bundles.updateScoped(Lm(o),{ownedFields:[..._a],", "return this.options.bundles.updateScoped(Lm(o),{carton:__cm,ownedFields:[..._a],"],
    ],
    mirror: ["await Uh(this.mirrorPath(t),r,\"utf8\"))}", "await(__carton.on?__carton.writeFile(this.mirrorPath(t),r):Uh(this.mirrorPath(t),r,\"utf8\")))}"],
    mirrorSync: ["async sync(t,r,n=[]){await this.recordRevision(t,r);let o=await this.print(t,n);await this.writeMirror(r,o),await this.scaffold(r)}", "async sync(t,r,n=[]){await this.recordRevision(t,r);if(!(__carton.on&&await __carton.mirrorOwned(r))){let o=await this.print(t,n);await this.writeMirror(r,o)}await this.scaffold(r)}"],
    archive: ["if(a&&(nS.has(i.name)||i.name===re)||", "if(__carton.skipInArchive(o,i.name,n)||a&&(nS.has(i.name)||i.name===re)||"],
    agents: [['Nh=e=>typeof e=="string",jh="# This is a Cardboard project', 'Nh=e=>typeof e=="string",jh=__carton.agentsMd("# This is a Cardboard project'], ['",n2=async e=>{let t=await On(', '"),n2=async e=>{let t=await On(']],
    // The timeline codec's names in this copy (the store bridge's parse), each proved where Cardboard calls it
    // (proveCodec, below).
    codec: {
      names: { parse: "rt", isPath: "$h", resolvePath: "Dn", luts: "Lh", templates: "a2", toDoc: "Ta", stored: "wa", reframe: "dh", mediaInfo: "Xn", keepIds: "km", synth: "hs", merge: "rn", withSlice: "Aa", orphans: "mn", dropOrphans: "Lm", owned: "_a", scoped: "pd", keepDone: "qx", codeToMedia: "Jo" },
      proofs: [
        "g=Nh(r)?rt(r):r",
        "pathOf:y=>$h(y)?Dn(y,o):null",
        "F=D?await Lh(D,g,k):null",
        "let $=await a2(g,o)",
        "q=Ta(g,{resolveMedia:I,readTemplate:y=>$.get(y)??null,storedItem:wa(Cr(i)),newId:this.options.newId})",
        "z=await dh(B,j,R,y=>{let x=S.get(y);return(x&&Xn(x))??void 0},n.prefer),J=hs(km(z,j),i,this.options.newId),Z=rn(B,j,J.doc,{prefer:n.prefer})",
        "writeTimeline(t,r,n){let o={...Aa(t,r),",
        "i=mn(o);return this.options.bundles.updateScoped(Lm(o),{ownedFields:[..._a],",
        "n=>qx(n,pd(n,t,r))",
        "this.applyMutation(t,c=>Jo(r(c)),n)",
      ],
    },
  },
  worker: {
    who: "app",
    // resources/app.asar/dist → resources/carton
    dir: `require("node:path").join(__dirname, "..", "..", "carton")`,
    slice: "Zs",
    updateScoped: ["n=>YZ(n,dw(n,t,r))", "n=>(__carton.on&&__carton.scope(r),YZ(n,dw(n,t,r)))"],
    readBundle: ['try{t=await(0,Bt.readFile)((0,rt.join)(e,Mt),"utf8")}catch{return null}', 'try{t=await(__carton.on?__carton.readFile((0,rt.join)(e,Mt)):(0,Bt.readFile)((0,rt.join)(e,Mt),"utf8"))}catch{return null}'],
    recover: ["let r=ti(t);if(!r)return null;let n=await Promise.all(r.media.map(", "ti"],
    install: ["l=await G1(c),await(0,Bt.rename)(c,s)}", "l=await G1(c),__carton.on?l=await __carton.install(c,s,this.seenOnDisk.get(t.id)?.stamp,t.stateUpdatedAt,o)===!1?null:await G1(s):await(0,Bt.rename)(c,s)}"],
    envelope: ["d=JSON.stringify(o);this.lastWritten", "o"],
    read: ["return this.seenOnDisk.set(t,{stamp:o,document:s.project}),", "s.project"],
    attach: ["n.onWritten((y,x)=>m.afterWrite(y,x));", "n,m,t"],
    revFiles: [
      ["let[u]=await this.listRevisions(r),p=u===void 0?null:await this.readRevision(r,u);", "let[u]=await this.__cartonListRevisions(r),p=u===void 0?null:await this.__cartonReadRevision(r,u);"],
      ["let l=await this.listRevisions(r);for(let u of l.slice(20))", "let l=await this.__cartonListRevisions(r);for(let u of l.slice(20))"],
    ],
    print: ["async print(t,r=[]){return this.printTimeline(t,Zs(t),t.stateUpdatedAt??0,r)}", "async print(t,r=[]){let __p=__carton.on?await __carton.printed(this,t):null;return __p?this.printTimeline(__p.project,Zs(__p.project),__p.rev,r):this.printTimeline(t,Zs(t),t.stateUpdatedAt??0,r)}"],
    undoWrite: ["return await this.writeTimeline(i,s.doc,s.added),o.rev}", "return await this.writeTimeline(i,s.doc,s.added,{source:\"undo\",rev:o.rev}),o.rev}"],
    headerRev: ["h=OC(r)?li(r):r", "h=OC(r)?(__carton.on?__carton.headerRev(li(r),r):li(r)):r"],
    base: ["be=await this.revisionAtOrBefore(i,h.rev)??de,", "be=(__carton.on&&typeof h.rev==\"string\"?await __carton.cartonBase(h.rev,i):await this.revisionAtOrBefore(i,h.rev))??(__carton.on?await __carton.missingRev(h.rev,de,i):de),"],
    merge: ["ee=$f(be,de,qe.doc,{prefer:n.prefer})", "ee=__carton.on?await __carton.merge3(be,de,qe.doc,{prefer:n.prefer},$f):$f(be,de,qe.doc,{prefer:n.prefer})"],
    applyWrite: [
      "let y=await this.writeTimeline(a,ee.doc,[...b,...qe.added]);return p({applied:!0,ops:J,conflicts:P,diagnostics:re,rev:y?.stateUpdatedAt??a.stateUpdatedAt})",
      "let y=await this.writeTimeline(a,ee.doc,[...b,...qe.added],{source:\"timeline\",rev:h.rev,actor:n.cartonActor});return p({applied:!0,ops:J,conflicts:P,diagnostics:re,rev:y?.stateUpdatedAt??a.stateUpdatedAt,...__carton.on&&await __carton.status(t)})",
    ],
    writeTimeline: [
      ["writeTimeline(t,r,n){let i={...Ay(t,r)", "writeTimeline(t,r,n,__cm){let i={...Ay(t,r)"],
      ["return this.options.bundles.updateScoped(vI(i),{ownedFields:[...My],", "return this.options.bundles.updateScoped(vI(i),{carton:__cm,ownedFields:[...My],"],
    ],
    mirror: ["await(0,Gr.writeFile)(this.mirrorPath(t),r,\"utf8\"))}", "await(__carton.on?__carton.writeFile(this.mirrorPath(t),r):(0,Gr.writeFile)(this.mirrorPath(t),r,\"utf8\")))}"],
    mirrorSync: ["async sync(t,r,n=[]){await this.recordRevision(t,r);let i=await this.print(t,n);await this.writeMirror(r,i),await this.scaffold(r)}", "async sync(t,r,n=[]){await this.recordRevision(t,r);if(!(__carton.on&&await __carton.mirrorOwned(r))){let i=await this.print(t,n);await this.writeMirror(r,i)}await this.scaffold(r)}"],
    archive: ["if(o&&(rH.has(a.name)||a.name===Mt)||", "if(__carton.skipInArchive(i,a.name,n)||o&&(rH.has(a.name)||a.name===Mt)||"],
    agents: [['OC=e=>typeof e=="string",$C="# This is a Cardboard project', 'OC=e=>typeof e=="string",$C=__carton.agentsMd("# This is a Cardboard project'], ['",HQ=async e=>{', '"),HQ=async e=>{']],
    codec: {
      names: { parse: "li", isPath: "LC", resolvePath: "kd", luts: "RC", templates: "YQ", toDoc: "Iy", stored: "xy", reframe: "iC", mediaInfo: "cw", keepIds: "xI", synth: "S4", merge: "$f", withSlice: "Ay", orphans: "rd", dropOrphans: "vI", owned: "My", scoped: "dw", keepDone: "YZ", codeToMedia: "K1" },
      proofs: [
        "h=OC(r)?li(r):r",
        "pathOf:x=>LC(x)?kd(x,i):null",
        "Q=F?await RC(F,h,K):null",
        "let fe=await YQ(h,i)",
        "Ee=Iy(h,{resolveMedia:S,readTemplate:x=>fe.get(x)??null,storedItem:xy(Zs(a)),newId:this.options.newId})",
        "we=await iC(be,de,B,x=>{let _=I.get(x);return(_&&cw(_))??void 0},n.prefer),qe=S4(xI(we,de),a,this.options.newId),ee=$f(be,de,qe.doc,{prefer:n.prefer})",
        "writeTimeline(t,r,n){let i={...Ay(t,r),",
        "a=rd(i);return this.options.bundles.updateScoped(vI(i),{ownedFields:[...My],",
        "n=>YZ(n,dw(n,t,r))",
        "this.applyMutation(t,s=>K1(r(s)),n)",
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
  replace(s.read[0], `return __carton.on&&await __carton.sawDisk(this,t,${s.read[1]}),` + s.read[0].slice("return ".length));
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
  if (!chunkFile) throw new Error("usage: node patch-carton.js --cli <cardboard.mjs> <chunk-LL26E55H.mjs>");
  const shim = `const require = __createRequire(import.meta.url);\n`;
  patch(chunkFile, (replace) => {
    replace(shim, shim + require("./carton/store-bridge")(STORE.cli));
    patchStore(replace, "cli");
  });
  patch(cbFile, (replace) => {
    replace(shim, shim + require("./carton/cli-bridge"));
    // @carton/cli-mcp's commands (cut, fold, credits, restore, compare, conflicts, resolve, publish, the git words),
    // registered once every Cardboard command is: Carton's history and undo take over Cardboard's when on.
    replace("var FN=ak(Ie);", "__cartonCli.commands(Ie,{options:De,open:()=>H(De()),resolve:I,out:He});var FN=ak(Ie);");
    // cb undo --turn <id> is Carton's; with Carton off it says so instead of undoing something else.
    replace(
      ".action(async(a,s)=>{let o=await H(r()),i=await I(o,a),c=await o.timeline.undo(i.id,s);",
      ".option(\"--turn <id>\",\"undo every change one agent turn made (Carton)\").action(async(a,s,__o)=>{if(__o?.turn!==void 0)await __cartonCli.undoTurn();let o=await H(r()),i=await I(o,a),c=await o.timeline.undo(i.id,s);",
    );
    // MCP: Carton serves timeline_history and undo_timeline (with cuts, stats and turns) in place of Cardboard's own,
    // and adds its tools before list_media.
    replace('p("timeline_history",', '__cartonCli.own("timeline_history")&&p("timeline_history",');
    replace('p("undo_timeline",', '__cartonCli.own("undo_timeline")&&p("undo_timeline",');
    replace('p("list_media",', '__cartonCli.mcp(p,{z:f,project:fe,resolve:x=>I(s,x),lib:s,result:Y}),p("list_media",');
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
    replace('var IA=["projects","media","cache","transcripts","voiceovers","mattes","inspect","timeline","luts","downloads"];', 'var IA=["projects","media","cache","transcripts","voiceovers","mattes","inspect","timeline","luts","downloads","carton"];');
    replace('kte=e=>{let t="",r=()=>{', 'kte=e=>{e.carton=__carton.on?__carton.worker(e,c=>rc({kind:"change",change:c})):{};let t="",r=()=>{');
    // H8: where the worker's Materializer runs for the bundle (sync/views.js), timeline.tsx is its own: a change of it
    // goes to the Materializer (a foreign save is applied there, with its freeze and credit), not to Cardboard's apply.
    replace("c=async g=>{let T=t.idForBundlePath(g);if(!T)return;", "c=async g=>{let T=t.idForBundlePath(g);if(!T)return;if(__carton.on&&__carton.timelineOwned(g))return void __carton.timelineEvent(g);");
    // A timeline.tsx the watcher applies was saved outside the app: an agent without Cardboard's hooks or an editor.
    replace("await t.read(T);let I=await r.apply(T,k);", "await t.read(T);let I=await r.apply(T,k,{cartonActor:\"external:timeline.tsx\"});");
    // The watcher reads project.json 150 ms after a change and tells the pages the project was removed if it's
    // missing; an apply from the file reads timeline.tsx. Both wait out an install's gap (the bridge's readFile).
    replace('k=await(0,_d.readFile)((0,Vn.join)(g,Mt),"utf8")}catch{k=null}', 'k=await(__carton.on?__carton.readFile((0,Vn.join)(g,Mt)):(0,_d.readFile)((0,Vn.join)(g,Mt),"utf8"))}catch{k=null}');
    replace('let $=await(0,Ar.readFile)(m.mirrorPath(N),"utf8");return m.apply(y,$,{..._,writeBack:!0})', 'let $=await(__carton.on?__carton.readFile(m.mirrorPath(N)):(0,Ar.readFile)(m.mirrorPath(N),"utf8"));return m.apply(y,$,{..._,writeBack:!0})');
    // The bundle has no banner line; the bridge goes first.
    prepend(require("./carton/store-bridge")(STORE.worker));
  });
  patch(mainFile, (replace) => {
    replace("var cxe=Object.create;", require("./carton/main-bridge") + "var cxe=Object.create;");
    // H1: the GUI save's Carton fields (base, after, actor, intents) reach the worker in the scope.
    replace(
      '_e.handle("project:patch",async({document:t,scope:r})=>{',
      '__cartonMain.library(St),_e.handle("carton:call",({method:t,args:r})=>__cartonMain.call(t,r??[])),_e.handle("project:patch",async({document:t,scope:r,carton:__cm})=>{',
    );
    replace('St.call("projects.updateScoped",t,r)', '__cartonMain.time(St.call("projects.updateScoped",t,__cartonMain.on&&__cm?{...r,carton:{...__cm,actor:"person"}}:r))');
    // H5: a project change while Carton is on takes the pages' Carton path (adopt without an undo entry).
    replace('e.tabs.broadcast("project:changed",{id:i,stateUpdatedAt:o.stateUpdatedAt,...s})', 'e.tabs.broadcast("project:changed",{id:i,stateUpdatedAt:o.stateUpdatedAt,...s,...__cartonMain.on&&{carton:!0}})');
    // H8: the worker's Carton events go to every tab.
    replace('onChange:async i=>{if(i.kind==="removed"){n(i.id);return}', 'onChange:async i=>{if(i.kind==="carton"){e.tabs.broadcast("carton:event",i);return}if(i.kind==="removed"){n(i.id);return}');
    // H9: who is acting, for every agent main starts (agentEnv: the agents deps.spawn starts, Codex in 1.4.0).
    // The title bar's History and Share icons (the tab strip, tabsFile below): their commands go to the active tab's
    // page as carton:command (not menu:action, which Cardboard logs and maps to native commands), and the page's report
    // of the panel open (carton:panel) joins the tab's editor state, which the strip draws from. Carton off: neither.
    // For a shared project the report also carries a small live summary (sync state, who is here: UI audit P2-11),
    // and the strip gets {panel, live} instead of the panel's name alone.
    replace("command(t){let r=this.activeContents();if(r){", "command(t){let r=this.activeContents();if(r){if(__cartonMain.on&&/^carton-/.test(t?.action??\"\")){_e.emit(r,\"carton:command\",{action:t.action});return}");
    replace("setEditorState(t,r){let n=this.tabIdOf(t);n&&this.model.setEditorState(n,r)}", "__cartonPanel(t,r){let n=this.tabIdOf(t);n&&this.model.__cartonPanel(n,r)}setEditorState(t,r){let n=this.tabIdOf(t);n&&this.model.setEditorState(n,r)}");
    replace("setEditorState(t,r){let n=this.tabById(t);!n||n.editor?.aspectRatio===r.aspectRatio&&n.editor.directorCollapsed===r.directorCollapsed&&RGt(n.editor.credits,r.credits)||(n.editor=r,this.changed())}", "__cartonPanel(t,r){let n=this.tabById(t);if(!n)return;n.__cartonPanel=r;n.editor&&n.editor.cartonPanel!==r&&(n.editor={...n.editor,cartonPanel:r},this.changed())}setEditorState(t,r){let n=this.tabById(t);!n||n.editor?.aspectRatio===r.aspectRatio&&n.editor.directorCollapsed===r.directorCollapsed&&RGt(n.editor.credits,r.credits)||(n.editor=n.__cartonPanel===void 0?r:{...r,cartonPanel:n.__cartonPanel},this.changed())}");
    replace('_e.handle("window:set-editor-state",(t,r)=>he.setEditorState(r.sender,t)),', '_e.handle("window:set-editor-state",(t,r)=>he.setEditorState(r.sender,t)),_e.handle("carton:panel",(t,r)=>{__cartonMain.on&&he.__cartonPanel(r.sender,t?.live?{panel:t?.panel??null,live:t.live}:t?.panel??null)}),');
    replace("this.deps.spawn(o.path,c.args(p),{cwd:i.bundlePath,env:b})", "this.deps.spawn(o.path,c.args(p),{cwd:i.bundlePath,env:__cartonMain.agentEnv(b,a.provider,s)})");
    replace("env:CVt(e,t,c),", "env:__cartonMain.directorEnv(CVt(e,t,c),t,()=>e.turnId(t.project.id,t.chatId)),");
    // H9: the Bash hook of Cardboard's Agent SDK transport (oH) names who runs each cb call; Stop and SubagentStop
    // return late conflicts. oH runs two agents in 1.4.0: the Director (RVt) and the person's own Claude Code (v_e,
    // provider "claude"; deps.spawn never starts it). Laptop #8: main-bridge's hookActor names the Director's turn
    // (director/<chat>/<turn>) and the person's Claude Code claude-code/<session>, never the Director.
    replace('PreToolUse:[{matcher:"Bash",hooks:[async v=>{', 'PreToolUse:[{matcher:"Bash",hooks:[__cartonMain.directorHook(e,async v=>{');
    // H8: and its Read/Write/Edit calls reach the worker's Materializer (the shared timeline.tsx's freeze, credit).
    replace("permissionDecisionReason:k.reason}}}],timeout:Tzt}]}", "permissionDecisionReason:k.reason}}})],timeout:Tzt},...__cartonMain.fileHooks(e)],...__cartonMain.stopHooks(e)}");
    // H9: each in-app agent's turn (the Director's, the person's own Claude Code's, Codex's) ends here (closeTurn: the
    // stream's result, an interrupt, an error): its hold on timeline.tsx ends, and its last version is named from the
    // turn's prompt (as the chat's checkpoints are); the label stays in the project's history. The transport, and so its
    // hooks, outlives the turn (n.process): review P2 (lap2), each start and end is a new turn generation in main-bridge,
    // so a hook still waiting at the end (an interrupted turn's Stop) sends nothing after it, and the turn's name request
    // carries its end (a late one never takes the next turn's version).
    replace('n.turn={state:"running",id:s.id,text:s.text}', 'n.turn={state:"running",id:s.id,text:s.text},__cartonMain.turnStarted(n,t,i.project?.bundlePath,s,i.launch?.provider)');
    replace('closeTurn(t,r){t.turn.state==="running"&&', 'closeTurn(t,r){__cartonMain.turnEnded(t,r);t.turn.state==="running"&&');
    // H9: a Claude Code started as a process (its args) gets the same hooks through --settings. 1.4.0 runs its Claude
    // Code through the Agent SDK transport instead (the hooks above), so this reaches it only if a build spawns it.
    replace('"--append-system-prompt",ju(e),', '"--append-system-prompt",ju(e),...__cartonMain.hostSettings(),');
    // H8 (item 4): every agent's appended system prompt (ju: the Director, host Claude Code, Codex, the others) gains
    // Carton's view flow with Carton on; with Carton off the list is Cardboard's.
    replace('Never write `project.json` directly.",', 'Never write `project.json` directly.",...__cartonMain.viewPrompt(e),');
  });

  // H4, H6, H7: the editor store (installErrorTelemetry-*.js). The bridge goes first; it waits for the store's handles.
  patch(storeFile, (replace, prepend) => {
    // `refuse` is Cardboard's own guard of its edits (me(): true and its "read-only" note over the timeline when a write
    // is blocked, as in a preview): the bridge's refuse() uses it for the stage's text editor (baseline P3-9).
    // `subscribe` (the store's, zustand's (state, prev)) and `clock` (its playback clock, qx, exported as aI: the
    // playhead while playing) let a preview tell the person's moves of the playhead from its own (final re-check N5).
    replace("ne.setState=tN({getState:ne.getState,isWriteBlocked:Tm,onAcceptedDocumentWrite:rN,onRejectedWrite:xv,setState:_m});", "ne.setState=tN({getState:ne.getState,isWriteBlocked:Tm,onAcceptedDocumentWrite:rN,onRejectedWrite:xv,setState:_m});window.__carton.store({state:ne.getState,raw:_m,adopt:Rde,armed:Mde,inflight:()=>Yy.size>0,flush:()=>cN().work,invoke:On,on:CI,deserialize:av,projects:De,refuse:me,subscribe:ne.subscribe,clock:qx.get});");
    // H4: the save names the version the editor shows; initializeEditor starts from the project's.
    replace('updateScoped:(t,e)=>Zp(t.id,cK(e),On("project:patch",{document:t,scope:e}))', 'updateScoped:(t,e)=>Zp(t.id,cK(e),On("project:patch",{document:t,scope:e,carton:window.__carton.saveMeta(t,e)}))');
    // H6: the editor's session starts here (Ctrl+Z never goes back past it), with nothing to undo or redo yet.
    replace('_m({projectId:n,projectName:r,activeLeftTab:"media",', '_m({cartonBase:a?.stateUpdatedAt??null,cartonPreview:null,cartonSince:Date.now(),cartonCanUndo:!1,cartonCanRedo:!1,projectId:n,projectName:r,activeLeftTab:"media",');
    // H4: a preview of an earlier version is read-only, says so, and is never saved.
    replace('Tm=t=>ah()||t.timelineLockState!=="unlocked"', 'Tm=t=>!!t.cartonPreview||ah()||t.timelineLockState!=="unlocked"');
    replace("ure=t=>ah()?aN:", "ure=t=>t.cartonPreview?window.__carton.previewMessage:ah()?aN:");
    replace("(n===iN||n===sN||n===aN)&&", "(n===iN||n===sN||n===aN||n===window.__carton.previewMessage)&&");
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
    prepend(require("./carton/renderer-bridge"));
  });
  // H5: the main bundle (index-*.js) adopts a Carton change through the bridge.
  patch(indexFile, (replace) => {
    replace("sV=async(e,t)=>{const{id:a,timeline:n,artefacts:s}=t;", "sV=async(e,t)=>{if(t.carton&&window.__carton?.on){const __r=await window.__carton.receive(e,t);if(__r)return __r}const{id:a,timeline:n,artefacts:s}=t;");
  });
  // Carton in the editor (EditorRoute-*.js, editor-panel.js, scripts/carton/ui.js): the History or Share panel, a
  // full-height column beside the agent's chat sidebar; and a layer over the stage (the preview's column) with the
  // conflict cards' floating stack and the preview banner. With Carton off the editor's row and stage are Cardboard's.
  patch(editorFile, (replace, prepend) => {
    replace('return c.jsx("div",{className:"flex flex-1 flex-col overflow-hidden bg-muted/60",children:c.jsxs("div",{ref:ge,', 'return c.jsx(window.__carton?.on?__cbCartonStageHost:"div",{className:"flex flex-1 flex-col overflow-hidden bg-muted/60",children:c.jsxs("div",{ref:ge,');
    // H6: the undo and redo buttons say what Carton has left to undo and redo (the bridge's cartonCanUndo/Redo), not
    // the editor's own snapshot stacks, which Carton's undo never pops. During a read-only preview neither applies
    // (Ctrl+Z already does nothing there), so both look unavailable (UI audit P3-12).
    replace("y=U(_=>_.historyPast.length>0),g=U(_=>_.historyFuture.length>0)", "y=U(_=>window.__carton?.on?!!_.cartonCanUndo&&!_.cartonPreview:_.historyPast.length>0),g=U(_=>window.__carton?.on?!!_.cartonCanRedo&&!_.cartonPreview:_.historyFuture.length>0)");
    replace('b&&c.jsx(X_,{variant:"project"})]}),c.jsx("div",{className:"contents","data-analytics-region":"editor-chat",', 'b&&c.jsx(X_,{variant:"project"})]}),...window.__carton?.on?[c.jsx(__cbCartonSide,{},"carton-side")]:[],c.jsx("div",{className:"contents","data-analytics-region":"editor-chat",');
    // Baseline P3-9 (final re-check N3): in a read-only preview the stage's text editor opened, from Enter on a selected
    // title and from a double-click on a title or caption, and dropped what was typed (opening it is no write, so
    // Cardboard's guard of its edits never saw it). Both ask the bridge first, which refuses only in a Carton preview,
    // with Cardboard's own "Previewing an earlier version. Return to current to edit." Crop mode, the double-click's
    // other branch, is refused by Cardboard's guard already.
    replace('me=o.useCallback(()=>{B&&B.type==="text"&&!ue&&(', 'me=o.useCallback(()=>{B&&B.type==="text"&&!ue&&!window.__carton?.refuse?.()&&(');
    replace('const Pe=Ds(Ce,Y.clientX,Y.clientY);if(Pe&&(Pe.type==="text"||Pe.type==="caption")){', 'const Pe=Ds(Ce,Y.clientX,Y.clientY);if(Pe&&(Pe.type==="text"||Pe.type==="caption")){if(window.__carton?.refuse?.())return;');
    // Regress prod3 (baseline P3-9 family): in a read-only preview a selected title or caption still showed the stage's
    // text toolbar (font, size, bold, alignment…), which Cardboard's guard then refused. It isn't shown there: nothing
    // in a preview looks editable. The preview's opening and its Return both replace the timeline (the bridge's adopt),
    // so the stage renders again then and reads the store's state as it is.
    replace("vn=B&&pe&&!p&&ct&&!ue&&!M&&!x?{item:B", "vn=B&&pe&&!p&&ct&&!ue&&!M&&!x&&!U.getState().cartonPreview?{item:B");
    prepend(require("./carton/editor-panel"));
  });
  // The title bar's History and Share icons (tabs-*.js, the tab strip), before "Report an issue": only on a tab whose
  // editor reports Carton's panel state (strip-buttons.js). A build without the strip's file leaves it as it is.
  if (tabsFile) patch(tabsFile, (replace, prepend) => {
    replace("t.credits&&n.jsx(Ot,{credits:t.credits}),n.jsx(Ut,{}),", "t.credits&&n.jsx(Ot,{credits:t.credits}),t.cartonPanel!==void 0&&n.jsx(__cbCartonStrip,{panel:t.cartonPanel}),n.jsx(Ut,{}),");
    prepend(require("./carton/strip-buttons"));
  });
} else {
  throw new Error("usage: node patch-carton.js --cli <cardboard.mjs> <chunk-LL26E55H.mjs> | --app <main.js> <library-worker.js> <index-*.js> <EditorRoute-*.js> <installErrorTelemetry-*.js>");
}
