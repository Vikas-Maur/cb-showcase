// Carton in Cardboard's bundles: version history, cuts, fold in, credits and live collaboration. What each hook does,
// in Cardboard's own terms, is in carton/docs/INTEGRATION-1.4.0.md; the numbers below (H1…H13) are its hook numbers.
// It runs after the Windows patches, on the files they wrote. Each Windows patch script starts again from its pristine
// copy, so a rebuild runs both in order; this script refuses a file that already has Carton in it.
// With Carton off at run time (CARDBOARD_CARTON is not "1"), every hook runs Cardboard's own code; only the .cbproj
// exclusions (H11) apply either way. build-windows.js --no-carton leaves this script out.
// Usage: node patch-carton.js --cli <cli/cardboard.mjs> <cli/chunks/chunk-LL26E55H.mjs>
//        node patch-carton.js --app <dist/main.js> <dist/library-worker.js> <index-*.js> <EditorRoute-*.js> <installErrorTelemetry-*.js>
const fs = require("fs");
const path = require("path");

const patch = (file, edits) => {
  let src = fs.readFileSync(file, "utf8");
  if (src.includes("__carton")) throw new Error(`${path.basename(file)} already has Carton's patches; run its Windows patch script first`);
  const replace = (from, to, count = 1) => {
    const n = src.split(from).length - 1;
    if (n !== count) throw new Error(`${path.basename(file)}: expected ${count} match(es), found ${n}: ${from}`);
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
    install: ["d=await Qo(l),await Bx(l,c)}", "d=await Qo(l),__carton.on?(await __carton.install(l,c),d=await Qo(c)):await Bx(l,c)}"],
    read: ["return this.seenOnDisk.set(t,{stamp:a,document:c.project}),", "c.project"],
    attach: ["n.onWritten((h,y)=>f.afterWrite(h,y));", "n,f,t"],
    revFiles: [
      ["let[m]=await this.listRevisions(r),p=m===void 0?null:await this.readRevision(r,m);", "let[m]=await this.__cartonListRevisions(r),p=m===void 0?null:await this.__cartonReadRevision(r,m);"],
      ["let d=await this.listRevisions(r);for(let m of d.slice(20))", "let d=await this.__cartonListRevisions(r);for(let m of d.slice(20))"],
    ],
    undoWrite: ["return await this.writeTimeline(o,c.doc,c.added),a.rev}", "return await this.writeTimeline(o,c.doc,c.added,{source:\"undo\",rev:a.rev}),a.rev}"],
    base: ["B=await this.revisionAtOrBefore(o,g.rev)??j,", "B=await this.revisionAtOrBefore(o,g.rev)??(__carton.on?__carton.missingRev(g.rev,j):j),"],
    merge: ["Z=rn(B,j,J.doc,{prefer:n.prefer})", "Z=__carton.on?await __carton.merge3(B,j,J.doc,{prefer:n.prefer},rn):rn(B,j,J.doc,{prefer:n.prefer})"],
    applyWrite: [
      "let h=await this.writeTimeline(i,Z.doc,[...w,...J.added]);return p({applied:!0,ops:se,conflicts:A,diagnostics:_,rev:h?.stateUpdatedAt??i.stateUpdatedAt})",
      "let h=await this.writeTimeline(i,Z.doc,[...w,...J.added],{source:\"timeline\",rev:g.rev,actor:n.cartonActor});return p({applied:!0,ops:se,conflicts:A,diagnostics:_,rev:h?.stateUpdatedAt??i.stateUpdatedAt,...__carton.on&&{carton:__carton.status(t)}})",
    ],
    writeTimeline: [
      ["writeTimeline(t,r,n){let o={...Aa(t,r)", "writeTimeline(t,r,n,__cm){let o={...Aa(t,r)"],
      ["return this.options.bundles.updateScoped(Lm(o),{ownedFields:[..._a],", "return this.options.bundles.updateScoped(Lm(o),{carton:__cm,ownedFields:[..._a],"],
    ],
    mirror: ["await Uh(this.mirrorPath(t),r,\"utf8\"))}", "await(__carton.on?__carton.writeFile(this.mirrorPath(t),r):Uh(this.mirrorPath(t),r,\"utf8\")))}"],
    archive: ["if(a&&(nS.has(i.name)||i.name===re)||", "if(__carton.skipInArchive(o,i.name)||a&&(nS.has(i.name)||i.name===re)||"],
  },
  worker: {
    who: "app",
    // resources/app.asar/dist → resources/carton
    dir: `require("node:path").join(__dirname, "..", "..", "carton")`,
    slice: "Zs",
    updateScoped: ["n=>YZ(n,dw(n,t,r))", "n=>(__carton.on&&__carton.scope(r),YZ(n,dw(n,t,r)))"],
    install: ["l=await G1(c),await(0,Bt.rename)(c,s)}", "l=await G1(c),__carton.on?(await __carton.install(c,s),l=await G1(s)):await(0,Bt.rename)(c,s)}"],
    read: ["return this.seenOnDisk.set(t,{stamp:o,document:s.project}),", "s.project"],
    attach: ["n.onWritten((y,x)=>m.afterWrite(y,x));", "n,m,t"],
    revFiles: [
      ["let[u]=await this.listRevisions(r),p=u===void 0?null:await this.readRevision(r,u);", "let[u]=await this.__cartonListRevisions(r),p=u===void 0?null:await this.__cartonReadRevision(r,u);"],
      ["let l=await this.listRevisions(r);for(let u of l.slice(20))", "let l=await this.__cartonListRevisions(r);for(let u of l.slice(20))"],
    ],
    undoWrite: ["return await this.writeTimeline(i,s.doc,s.added),o.rev}", "return await this.writeTimeline(i,s.doc,s.added,{source:\"undo\",rev:o.rev}),o.rev}"],
    base: ["be=await this.revisionAtOrBefore(i,h.rev)??de,", "be=await this.revisionAtOrBefore(i,h.rev)??(__carton.on?__carton.missingRev(h.rev,de):de),"],
    merge: ["ee=$f(be,de,qe.doc,{prefer:n.prefer})", "ee=__carton.on?await __carton.merge3(be,de,qe.doc,{prefer:n.prefer},$f):$f(be,de,qe.doc,{prefer:n.prefer})"],
    applyWrite: [
      "let y=await this.writeTimeline(a,ee.doc,[...b,...qe.added]);return p({applied:!0,ops:J,conflicts:P,diagnostics:re,rev:y?.stateUpdatedAt??a.stateUpdatedAt})",
      "let y=await this.writeTimeline(a,ee.doc,[...b,...qe.added],{source:\"timeline\",rev:h.rev,actor:n.cartonActor});return p({applied:!0,ops:J,conflicts:P,diagnostics:re,rev:y?.stateUpdatedAt??a.stateUpdatedAt,...__carton.on&&{carton:__carton.status(t)}})",
    ],
    writeTimeline: [
      ["writeTimeline(t,r,n){let i={...Ay(t,r)", "writeTimeline(t,r,n,__cm){let i={...Ay(t,r)"],
      ["return this.options.bundles.updateScoped(vI(i),{ownedFields:[...My],", "return this.options.bundles.updateScoped(vI(i),{carton:__cm,ownedFields:[...My],"],
    ],
    mirror: ["await(0,Gr.writeFile)(this.mirrorPath(t),r,\"utf8\"))}", "await(__carton.on?__carton.writeFile(this.mirrorPath(t),r):(0,Gr.writeFile)(this.mirrorPath(t),r,\"utf8\")))}"],
    archive: ["if(o&&(rH.has(a.name)||a.name===Mt)||", "if(__carton.skipInArchive(i,a.name)||o&&(rH.has(a.name)||a.name===Mt)||"],
  },
};

// A method renamed to __carton<Name> and replaced by one that asks Carton first: `async name(args){` becomes
// `name(args){return <with Carton> : this.__carton<Name>(args)}async __carton<Name>(args){`.
const around = (replace, name, args, withCarton) => {
  const own = `__carton${name[0].toUpperCase()}${name.slice(1)}`;
  replace(`async ${name}(${args}){`, `${name}(${args}){return __carton.on?${withCarton(own)}:this.${own}(${args})}async ${own}(${args}){`);
};

const patchStore = (replace, k) => {
  const s = STORE[k];
  // H1: one Carton change per mutation, against the exact document it was applied to; the GUI's and the apply's
  // Carton fields ride in the scope; the rename into project.json becomes displace-then-install; a document on disk
  // Carton never wrote is imported when read; the store tells the bridge where the library is.
  around(replace, "applyMutation", "t,r,n", () => "__carton.applyMutation(this,t,r,n)");
  replace(...s.updateScoped);
  replace(...s.install);
  replace(s.read[0], `return __carton.on&&await __carton.sawDisk(this,t,${s.read[1]}),` + s.read[0].slice("return ".length));
  replace(s.attach[0], `${s.attach[0]}__carton.on&&__carton.attach(${s.attach[1]});`);
  // H2: the revision readers read Carton's history first. recordRevision keeps reading and pruning its own files.
  for (const [from, to] of s.revFiles) replace(from, to);
  around(replace, "listRevisions", "t", () => "__carton.listRevisions(this,t)");
  around(replace, "readRevision", "t,r", () => "__carton.readRevision(this,t,r)");
  replace("async history(t){", "history(t){return __carton.on?this.__cartonHistory(t).then(r=>__carton.history(this,t,r)):this.__cartonHistory(t)}async __cartonHistory(t){");
  // undo <rev> restores through writeTimeline, whose scope says so.
  replace(...s.undoWrite);
  // H3: the exact base or an error; merge3 in place of the item-level merge; the apply's write carries its header rev.
  replace(...s.base);
  replace(...s.merge);
  replace(...s.applyWrite);
  for (const [from, to] of s.writeTimeline) replace(from, to);
  replace(...s.mirror);
  // H11: no .carton/ and no .scratch/views/ in a .cbproj.
  replace(...s.archive);
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
    // The Carton commands (cut, fold, credits, restore, compare, conflicts, resolve, publish and their git aliases),
    // registered once every Cardboard command is, so `cb --help` lists them after Cardboard's.
    replace("var FN=ak(Ie);", "__cartonCli.commands(Ie,{options:De,open:()=>H(De()),resolve:I,out:He});var FN=ak(Ie);");
    // cb history: WHO and CUT columns when Carton supplies them.
    const table = 'me([["REV","SAVED","TRACKS","ITEMS","DURATION"],...i.map(c=>[String(c.rev),hs(c.at),String(c.tracks),String(c.items),`${c.duration.toFixed(1)}s`])])';
    replace(table, `me(__cartonCli.historyTable(${table.slice(3, -1)},i))`);
    // cb undo --turn <id>.
    replace(
      ".action(async(a,s)=>{let o=await H(r()),i=await I(o,a),c=await o.timeline.undo(i.id,s);e().result({id:i.id,restored:c},()=>c===null?\"Nothing to undo\":`Restored revision ${c}`)})",
      ".option(\"--turn <id>\",\"undo every change one agent turn made (Carton)\").action(async(a,s,__o)=>{let o=await H(r()),i=await I(o,a);if(__o?.turn!==void 0){let c=await __cartonCli.undoTurn(o,i.id,__o.turn);return e().result({id:i.id,...c},()=>__cartonCli.statusLine(c))}let c=await o.timeline.undo(i.id,s);e().result({id:i.id,restored:c},()=>c===null?\"Nothing to undo\":`Restored revision ${c}`)})",
    );
    // MCP: undo_timeline takes a turn too, and Carton's tools go in before list_media.
    replace(
      "{project:fe,rev:f.number().int().optional()},!1,async({project:_,rev:y})=>{let w=await I(s,_),v=await s.timeline.undo(w.id,y);return Y({restored:v},v===null?\"Nothing to undo\":`Restored revision ${v}`)}),p(\"list_media\",",
      "{project:fe,rev:f.number().int().optional(),...__cartonCli.on&&{turn:f.string().optional().describe(\"Undo every change one agent turn made\")}},!1,async({project:_,rev:y,turn:__t})=>{let w=await I(s,_);if(__t!==void 0){let v=await __cartonCli.undoTurn(s,w.id,__t);return Y(v,__cartonCli.statusLine(v))}let v=await s.timeline.undo(w.id,y);return Y({restored:v},v===null?\"Nothing to undo\":`Restored revision ${v}`)}),__cartonCli.mcp(p,{z:f,project:fe,resolve:async(x)=>{let q=await I(s,x);return{id:q.id,bundlePath:s.projects?.bundlePathFor?.(q.id)}},result:Y}),p(\"list_media\",",
    );
  });
} else if (mode === "--app") {
  const [mainFile, workerFile, indexFile, editorFile, storeFile] = files;
  if (!storeFile) throw new Error("usage: node patch-carton.js --app <main.js> <library-worker.js> <index-*.js> <EditorRoute-*.js> <installErrorTelemetry-*.js>");
  patch(workerFile, (replace, prepend) => {
    patchStore(replace, "worker");
    // H8: a `carton` namespace in the worker's RPC table, for main's carton:call; its events go to main as changes.
    replace('var IA=["projects","media","cache","transcripts","voiceovers","mattes","inspect","timeline","luts","downloads"];', 'var IA=["projects","media","cache","transcripts","voiceovers","mattes","inspect","timeline","luts","downloads","carton"];');
    replace('kte=e=>{let t="",r=()=>{', 'kte=e=>{e.carton=__carton.on?__carton.worker(e,c=>rc({kind:"change",change:c})):{};let t="",r=()=>{');
    // A timeline.tsx the watcher applies was saved outside the app: an agent without Cardboard's hooks or an editor.
    replace("await t.read(T);let I=await r.apply(T,k);", "await t.read(T);let I=await r.apply(T,k,{cartonActor:\"external:timeline.tsx\"});");
    // The bundle has no banner line; the bridge goes first.
    prepend(require("./carton/store-bridge")(STORE.worker));
  });
  patch(mainFile, (replace) => {
    replace("var cxe=Object.create;", require("./carton/main-bridge") + "var cxe=Object.create;");
    // H1: the GUI save's Carton fields (base, actor, intents) reach the worker in the scope.
    replace(
      '_e.handle("project:patch",async({document:t,scope:r})=>{',
      '__cartonMain.library(St),_e.handle("carton:call",({method:t,args:r})=>__cartonMain.call(t,r??[])),_e.handle("project:patch",async({document:t,scope:r,carton:__cm})=>{',
    );
    replace('St.call("projects.updateScoped",t,r)', 'St.call("projects.updateScoped",t,__cartonMain.on&&__cm?{...r,carton:{...__cm,actor:"person"}}:r)');
    // H5: a project change while Carton is on takes the pages' Carton path (adopt without an undo entry).
    replace('e.tabs.broadcast("project:changed",{id:i,stateUpdatedAt:o.stateUpdatedAt,...s})', 'e.tabs.broadcast("project:changed",{id:i,stateUpdatedAt:o.stateUpdatedAt,...s,...__cartonMain.on&&{carton:!0}})');
    // H8: the worker's Carton events go to every tab.
    replace('onChange:async i=>{if(i.kind==="removed"){n(i.id);return}', 'onChange:async i=>{if(i.kind==="carton"){e.tabs.broadcast("carton:event",i);return}if(i.kind==="removed"){n(i.id);return}');
    // H9: who is acting, for every agent main starts.
    replace("this.deps.spawn(o.path,c.args(p),{cwd:i.bundlePath,env:b})", "this.deps.spawn(o.path,c.args(p),{cwd:i.bundlePath,env:__cartonMain.agentEnv(b,a.provider,s)})");
    replace("env:CVt(e,t,c),", "env:__cartonMain.directorEnv(CVt(e,t,c),t,()=>e.turnId(t.project.id,t.chatId)),");
    // H9: the Director's Bash hook names the turn and the subagent; Stop and SubagentStop return late conflicts.
    replace('PreToolUse:[{matcher:"Bash",hooks:[async v=>{', 'PreToolUse:[{matcher:"Bash",hooks:[__cartonMain.directorHook(e,async v=>{');
    replace("permissionDecisionReason:k.reason}}}],timeout:Tzt}]}", "permissionDecisionReason:k.reason}}})],timeout:Tzt}],...__cartonMain.stopHooks(e)}");
    // H9: host Claude Code gets the same hooks through --settings.
    replace('"--append-system-prompt",ju(e),', '"--append-system-prompt",ju(e),...__cartonMain.hostSettings(),');
  });

  // H4, H6, H7: the editor store (installErrorTelemetry-*.js). The bridge goes first; it waits for the store's handles.
  patch(storeFile, (replace, prepend) => {
    replace("ne.setState=tN({getState:ne.getState,isWriteBlocked:Tm,onAcceptedDocumentWrite:rN,onRejectedWrite:xv,setState:_m});", "ne.setState=tN({getState:ne.getState,isWriteBlocked:Tm,onAcceptedDocumentWrite:rN,onRejectedWrite:xv,setState:_m});window.__carton.store({state:ne.getState,raw:_m,adopt:Rde,armed:Mde,flush:()=>cN().work,invoke:On,on:CI,deserialize:av,projects:De});");
    // H4: the save names the version the editor shows; initializeEditor starts from the project's.
    replace('updateScoped:(t,e)=>Zp(t.id,cK(e),On("project:patch",{document:t,scope:e}))', 'updateScoped:(t,e)=>Zp(t.id,cK(e),On("project:patch",{document:t,scope:e,carton:window.__carton.saveMeta(t,e)}))');
    replace('_m({projectId:n,projectName:r,activeLeftTab:"media",', '_m({cartonBase:a?.stateUpdatedAt??null,cartonPreview:null,projectId:n,projectName:r,activeLeftTab:"media",');
    // H4: a preview of an earlier version is read-only, says so, and is never saved.
    replace('Tm=t=>ah()||t.timelineLockState!=="unlocked"', 'Tm=t=>!!t.cartonPreview||ah()||t.timelineLockState!=="unlocked"');
    replace("ure=t=>ah()?aN:", "ure=t=>t.cartonPreview?window.__carton.previewMessage:ah()?aN:");
    replace("(n===iN||n===sN||n===aN)&&", "(n===iN||n===sN||n===aN||n===window.__carton.previewMessage)&&");
    replace("function de(){const e=ne.getState().projectId;", "function de(){if(ne.getState().cartonPreview)return;const e=ne.getState().projectId;");
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
  // The History panel: a rail tab in the editor (EditorRoute-*.js), loaded from carton-ui.js when first shown.
  patch(editorFile, (replace, prepend) => {
    replace('{id:"effects",icon:gw,label:"Effects",event:"filters_panel_opened"}]],U_=V_.map(', '{id:"effects",icon:gw,label:"Effects",event:"filters_panel_opened"}],...window.__carton?.on?[[{id:"carton",icon:__cbCartonIcon,label:"History",event:"carton_panel_opened"}]]:[]],U_=V_.map(');
    replace('uf=["media","layouts","music","captions","voiceover","text","transitions","effects"].filter(', 'uf=["media","layouts","music","captions","voiceover","text","transitions","effects",...window.__carton?.on?["carton"]:[]].filter(');
    replace('case"effects":return c.jsx(tP,{});default:return null}', 'case"effects":return c.jsx(tP,{});case"carton":return c.jsx(__cbCartonPanel,{projectId:t});default:return null}');
    prepend(require("./carton/editor-panel"));
  });
} else {
  throw new Error("usage: node patch-carton.js --cli <cardboard.mjs> <chunk-LL26E55H.mjs> | --app <main.js> <library-worker.js> <index-*.js> <EditorRoute-*.js> <installErrorTelemetry-*.js>");
}
