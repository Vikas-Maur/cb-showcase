// Patches Cardboard's renderer: its main bundle (index-*.js) and the editor's (EditorRoute-*.js).
// - A dropped folder imports the media inside it.
// - Windows keyboards: shortcut recording and conflicts, the Shortcuts page's keyboard, Ctrl+Y.
// - Answering the agent's questions from the keyboard.
// - The pages' part of the activity log (see __cbLog in patch-main.js).
// Usage: node patch-renderer.js <path-to-dist/renderer/assets/index-*.js> <path-to-…/EditorRoute-*.js>
const fs = require("fs");
const path = require("path");

const [indexFile, editorFile] = process.argv.slice(2);
if (!editorFile) throw new Error("usage: node patch-renderer.js <index-*.js> <EditorRoute-*.js>");

// The pristine copy of a bundle, kept outside the asar source tree so it is not repacked.
const pristine = (file, origName) => {
  const orig = path.join(path.dirname(file), "..", "..", "..", "..", origName);
  if (!fs.existsSync(orig)) fs.copyFileSync(file, orig);
  return fs.readFileSync(orig, "utf8");
};
const patch = (file, origName, edits) => {
  let src = pristine(file, origName);
  edits((from, to, count = 1) => {
    const n = src.split(from).length - 1;
    if (n !== count) throw new Error(`expected ${count} match(es), found ${n}: ${from}`);
    src = src.split(from).join(to);
  });
  fs.writeFileSync(file, src);
  console.log(`patched ${path.basename(file)} (${src.length} bytes)`);
};

// Windows wording for text that names the Mac: "this PC" for "this Mac", File Explorer for Finder. Cardboard
// already words some of it per platform ("Show in Folder", Ctrl for ⌘); these it missed. Either text is
// chosen when it's shown, so the same bundle still reads right on a Mac.
const onWin = (mac, win) => `(window.desktop?.platform==="win32"?${JSON.stringify(win)}:${JSON.stringify(mac)})`;
const macWords = (replace, pairs) => {
  for (const [before, mac, win] of pairs) replace(before.replace("%", JSON.stringify(mac)), before.replace("%", onWin(mac, win)));
};

// Controls the activity log may name: the aria-labels written as plain strings in the two bundles. Labels
// built at run time can hold what the user typed ("Steer the turn with: <the prompt>", "Rename <project>"),
// so those are never logged.
const labels = [...new Set([pristine(indexFile, "index.orig.js"), pristine(editorFile, "EditorRoute.orig.js")]
  .flatMap((src) => [...src.matchAll(/"aria-label":"([^"\\]{1,40})"/g)].map((m) => m[1])))].sort();

patch(indexFile, "index.orig.js", (replace) => {
  // ── Dropped folders ──
  // Helpers, after Cardboard's own folder walker (PH, which reads directory entries recursively).
  // Chromium lists a dropped folder in dataTransfer.files as one entry with no media type, which the
  // media filter (VH) throws away, so a folder imported nothing. The entries that can be walked ($H)
  // are only readable while the drop event is dispatching, and Cardboard read them after an await.
  replace(
    `async function PH(e){const t=[];return await Promise.all(e.map(a=>O5(a,t))),t}`,
    `async function PH(e){const t=[];return await Promise.all(e.map(a=>O5(a,t))),t}` +
      // The drop's entries, if any of them is a folder. Call while the drop event is dispatching.
      `const __cbDroppedFolders=e=>{const t=$H(e);return t.some(a=>a.isDirectory)?t:null},` +
      `__cbPath=e=>window.desktop?.getPathForFile(e)||e.name,` +
      // Every file in the dropped folders and their subfolders (and any files dropped with them), in path order.
      `__cbWalk=async e=>(await PH(e)).sort((t,a)=>__cbPath(t).localeCompare(__cbPath(a),void 0,{numeric:!0,sensitivity:"base"})),` +
      // For drop targets that opt in: the media in dropped folders. When there is none, the files as
      // dropped, so the target still says what it could not add; with media set, only media, for targets
      // that take any file without a type (a folder of code would attach every LICENSE and Makefile).
      `__cbDropFiles=async(e,m)=>{const t=Array.from(e.files),a=__cbDroppedFolders(e);if(!a)return t;const n=await __cbWalk(a),s=n.filter(VH);return m||s.length>0?s:n.length>0?n:t};`,
  );

  // 1. The editor (its media panel, and anywhere else in the editor): a dropped folder's media files go
  // through the usual filter, which also skips files the project already has.
  replace(
    `gQ=async(e,t)=>{const a=Array.from(e.files);try{const n=await Fg(e);`,
    `gQ=async(e,t)=>{const a=Array.from(e.files),__cbDirs=__cbDroppedFolders(e);try{if(__cbDirs)return z1((await __cbWalk(__cbDirs)).map(c=>({file:c})),t);const n=await Fg(e);`,
  );

  // 2. The Dashboard: a dropped folder's media go where dropped files go (the prompt's attachments). The
  // drop hook takes folders only where asked, so the Report an Issue attachments and other drop targets
  // behave as before.
  replace(`Pn=({onFiles:e,contain:t=!1})=>{`, `Pn=({onFiles:e,contain:t=!1,folders:__cbF=!1})=>{`);
  replace(
    `s.current=0,n(!1),e(Array.from(l.dataTransfer.files)))},[t,e])`,
    `s.current=0,n(!1),__cbF?__cbDropFiles(l.dataTransfer,__cbF==="media").then(e,a=>console.error("[desktop] could not read the dropped folder:",a)):e(Array.from(l.dataTransfer.files)))},[t,e,__cbF])`,
  );
  replace(`R=Pn({onFiles:I})`, `R=Pn({onFiles:I,folders:!0})`);
  // The Dashboard's prompt box ("drop footage") has its own drop target, which keeps the drop from the
  // page's: a folder dropped there became one attachment named after the folder. Now it attaches the
  // folder's media, and nothing else (its filter lets files without a type through).
  replace(`_=Pn({onFiles:L=>C(L),contain:!0})`, `_=Pn({onFiles:L=>C(L),contain:!0,folders:"media"})`);

  // ── Keyboard and activity log ──
  // Helpers, at the top level (and before the shortcut keyboard, z9, is built).
  // z is the request to main, ue the toast, se/Oi/IH the shortcut ids, list and matcher.
  const helpers = String.raw`
const __cbWinKeys=window.desktop?.platform==="win32";
// Cardboard writes Cmd/Ctrl shortcuts with meta. On Windows Ctrl is that key, so a shortcut recorded
// with Ctrl is stored, compared and drawn as meta, like the built-in ones.
const __cbPrimary=e=>e.ctrl?{...e,ctrl:void 0,meta:!0}:e;
// The Shortcuts page draws a Mac keyboard. On Windows: Ctrl, Win and Alt along the bottom, Shift,
// Backspace and Enter, and layers named Ctrl+, Shift+, Ctrl+Shift+.
const __cbBoard=rows=>!__cbWinKeys?rows:rows.map(row=>row.flatMap(k=>{switch(k.id){
case"backspace":return[{...k,label:"Backspace"}];
case"enter":return[{...k,label:"Enter"}];
case"shift-left":case"shift-right":return[{...k,label:"Shift",modifier:"Shift"}];
case"ctrl":return[{id:"ctrl",label:"Ctrl",width:1.25,modifier:"Ctrl"},{id:"win",label:"Win"}];
case"alt-left":return[{...k,label:"Alt",modifier:"Alt"}];
case"meta-left":case"meta-right":return[];
case"alt-right":return[{...k,label:"Alt",modifier:"Alt"},{id:"ctrl-right",label:"Ctrl",width:1.25,modifier:"Ctrl"}];
default:return[k]}}));
const __cbLayer=e=>[(e.ctrl||e.meta)&&"Ctrl",e.alt&&"Alt",e.shift&&"Shift"].filter(Boolean).map(m=>m+"+").join("");
// Windows' redo is Ctrl+Y. Redo takes it too while Redo has its default Ctrl+Shift+Z and no shortcut
// is set to Ctrl+Y.
const __cbRedoY=(id,b,e,get)=>__cbWinKeys&&id===se.REDO&&e.key.toLowerCase()==="y"&&(e.ctrlKey||e.metaKey)&&!e.shiftKey&&!e.altKey&&b.key.toLowerCase()==="z"&&(b.meta||b.ctrl)&&b.shift&&!b.alt&&!Oi.some(o=>{const x=get(o.id);return x&&IH(e,x)});

// Activity log. Main writes it; this page reports shortcuts, keys nothing handled, how an agent
// question was answered, errors and error toasts. Never text typed into a field.
const __cbLog=(ev,f)=>{try{z("cb:log",{ev,where:location.pathname.startsWith("/app/editor/")?"editor":location.pathname.replace(/^\/app\/?/,"")||"home",...f}).catch(()=>{})}catch{}};
const __cbKeyName=k=>k===" "?"Space":k.length===1?k.toUpperCase():{ArrowLeft:"Left",ArrowRight:"Right",ArrowUp:"Up",ArrowDown:"Down",Escape:"Esc"}[k]??k;
const __cbCombo=e=>[e.ctrlKey&&"Ctrl",e.altKey&&"Alt",e.shiftKey&&"Shift",e.metaKey&&(__cbWinKeys?"Win":"Cmd"),__cbKeyName(e.key)].filter(Boolean).join("+");
const __cbEditable=t=>t instanceof HTMLElement&&(t.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
// What a control is, for the log: its label when that is one of the bundles' fixed labels, else its
// analytics id, else its role or tag. Never its text or a label built from what the user typed.
const __cbLabels=new Set(${JSON.stringify(labels)});
const __cbName=t=>{const l=t.getAttribute("aria-label"),a=t.getAttribute("data-analytics");return l&&__cbLabels.has(l)?l:a&&/^[\w.:-]{1,48}$/.test(a)?a:t.getAttribute("role")||t.tagName.toLowerCase()};
// The last key or click, for telling how an agent question was answered.
let __cbLast=null;
const __cbVia=()=>__cbLast!==null&&performance.now()-__cbLast.t<3e3?__cbLast.via:"unknown";
const __cbShortcut=(id,e)=>{if(!e.isTrusted||e.__cbLogged)return;e.__cbLogged=!0;e.repeat||__cbLog("shortcut",{id,combo:__cbCombo(e)})};
addEventListener("pointerdown",e=>{e.isTrusted&&(__cbLast={t:performance.now(),via:"pointer"})},{capture:!0,passive:!0});
addEventListener("keydown",e=>{
if(!e.isTrusted||/^(Control|Shift|Alt|Meta|AltGraph|CapsLock|NumLock|Process|Dead|Unidentified)$/.test(e.key))return;
__cbLast={t:performance.now(),via:"key:"+__cbCombo(e)};
const mod=e.ctrlKey||e.altKey||e.metaKey,typing=__cbEditable(e.target);
// AltGr is Ctrl+Alt on Windows and types characters.
if(e.repeat||e.getModifierState?.("AltGraph")||(e.ctrlKey&&e.altKey&&typing))return;
if(!mod&&(typing||e.key==="Tab"))return;
// After every handler has run: did any of them take the key?
setTimeout(()=>{
if(e.__cbLogged)return;
// Enter or Space on a focused button presses it: the browser handled that.
const t=e.target,control=!mod&&(e.key==="Enter"||e.key===" ")&&t instanceof HTMLElement&&t.closest('button,a[href],[role="button"],[role^="menuitem"],[role="option"],[role="tab"],[role="checkbox"],[role="switch"]');
const handled=e.defaultPrevented||(control?"native":!1);
// In a field, and with text selected, the browser's own editing keys (copy, paste, undo…) are not ours.
if(!handled&&(typing||e.ctrlKey&&/^[acx]$/i.test(e.key)&&String(getSelection()).length>0))return;
__cbLog("key",{combo:__cbCombo(e),handled,...typing&&{field:__cbName(t)},...control&&{on:__cbName(control)}})})},!0);
addEventListener("error",e=>{__cbLog("error",{msg:String(e.message).slice(0,500),...e.filename&&{src:e.filename.split("/").pop()+":"+e.lineno+":"+e.colno}})});
addEventListener("unhandledrejection",e=>{const r=e.reason;__cbLog("error",{msg:String(r?.stack??r?.message??r).slice(0,800),rejection:!0})});
for(const k of["error","warning"]){const f=ue[k];typeof f=="function"&&(ue[k]=(m,o)=>(__cbLog("toast",{kind:k,...typeof m=="string"&&{msg:m.slice(0,300)},...typeof o?.description=="string"&&{detail:o.description.slice(0,300)}}),f(m,o)))}
`;
  replace(`async function O5(e,t){`, helpers + `async function O5(e,t){`);

  // 3. Recording a shortcut on Windows stores Ctrl as meta (see __cbPrimary). It stored ctrl, which the
  // conflict check told apart from the built-in meta ones, so Ctrl+D for Split was saved without a
  // word while Duplicate also had Ctrl+D, and Ctrl+D then did one or the other.
  replace(
    `const m={key:u.key};u.ctrlKey&&(m.ctrl=!0),u.metaKey&&(m.meta=!0)`,
    `const m={key:u.key};__cbWinKeys?(u.ctrlKey||u.metaKey)&&(m.meta=!0):(u.ctrlKey&&(m.ctrl=!0),u.metaKey&&(m.meta=!0))`,
  );
  // Shortcuts recorded before this fix still have ctrl: compare them as meta too.
  replace(`N4=e=>{`, `N4=e=>{__cbWinKeys&&(e=__cbPrimary(e));`);
  replace(`P5=(e,t)=>`, `P5=(e,t)=>(__cbWinKeys&&(e=__cbPrimary(e),t=__cbPrimary(t)),0)||`);

  // 4. The Shortcuts page's keyboard and its layers, the Windows way (see __cbBoard).
  replace(`z9=[[`, `z9=__cbBoard([[`);
  replace(`,CK=new Map(`, `),CK=new Map(`);
  replace("bd=e=>`", "bd=e=>__cbWinKeys?__cbLayer(e):`");
  replace(`IK=e=>e===""?"No modifier":e`, `IK=e=>e===""?"No modifier":__cbWinKeys?e.slice(0,-1):e`);
  replace("\" on their own\":` with ${d}`", "\" on their own\":` with ${__cbWinKeys?d.slice(0,-1):d}`");

  // 5. Ctrl+Y redoes on Windows (see __cbRedoY), and every shortcut that runs goes in the activity log.
  replace(
    `if(h&&IH(l,h)){if(V5()&&(h.meta||h.ctrl)){const u=h.key.toLowerCase();if(u==="c"||u==="x")return}s&&l.preventDefault(),t()}`,
    `if(h&&(IH(l,h)||__cbRedoY(e,h,l,c))){if(V5()&&(h.meta||h.ctrl)){const u=h.key.toLowerCase();if(u==="c"||u==="x")return}s&&l.preventDefault(),__cbShortcut(e,l),t()}`,
  );

  // 6. An answer to an agent question says how it was given (a key, or a click); main logs it with how
  // long the question waited.
  replace(`zY=(e,t,a={})=>z("local-agent:answer",{id:e,answers:t,`, `zY=(e,t,a={})=>z("local-agent:answer",{via:__cbVia(),id:e,answers:t,`);

  // 7. Windows wording (see onWin): Settings → Library and Agents, the plans note, the project menu.
  macWords(replace, [
    [`x.startup?%:x.name`, "this Mac", "this PC"],
    [`children:%`, "Show in Finder", "Show in File Explorer"],
    [`Ze(%)`, "Could not show the project in Finder", "Could not show the project in File Explorer"],
    [`lead:%`, "Let Claude Code and Codex on this Mac edit your projects. They sign in with your own Claude and ChatGPT accounts.",
      "Let Claude Code and Codex on this PC edit your projects. They sign in with your own Claude and ChatGPT accounts."],
    [`Ce,{title:%`, "On this Mac", "On this PC"],
    [`detail:%`, "Choose a drive connected to this Mac.", "Choose a drive connected to this PC."],
    [`%`, "Editing with your own agents on this Mac is free. Cloud, captions and generation need a plan.",
      "Editing with your own agents on this PC is free. Cloud, captions and generation need a plan."],
    [`%`, "Projects and cloud services need an account. Their files stay on this Mac.",
      "Projects and cloud services need an account. Their files stay on this PC."],
  ]);
  replace('"aria-label":`Show ${e.name} in Finder`', '"aria-label":`Show ${e.name} in ${window.desktop?.platform==="win32"?"File Explorer":"Finder"}`');
});

patch(editorFile, "EditorRoute.orig.js", (replace) => {
  // 7. Enter on an agent question's option that is already picked confirms the answer. Clicking an
  // option leaves the keyboard on it, and Enter then clicked it again, which un-picked it, so "click,
  // Enter" sent nothing. Enter on an option not picked yet still picks it, so from the keyboard it is
  // Enter to pick, Enter to send; Space still toggles. The same for voice options.
  const confirmKey = (picked, confirm) => `onKeyDown:k=>{k.key==="Enter"&&${picked}&&!(k.shiftKey||k.altKey||k.ctrlKey||k.metaKey||k.repeat)&&(k.preventDefault(),${confirm})}`;
  replace(
    `c.jsx("button",{type:"button","aria-pressed":a,onClick:()=>e.pick(n.label),"data-analytics":"director-question-option"`,
    `c.jsx("button",{type:"button","aria-pressed":a,onClick:()=>e.pick(n.label),${confirmKey("a", `e.confirm("")`)},"data-analytics":"director-question-option"`,
  );
  replace(`gA=({option:e,voice:t,selected:n,preview:a,onPick:r})=>`, `gA=({option:e,voice:t,selected:n,preview:a,onPick:r,onConfirm:__cbConfirm})=>`);
  replace(`c.jsx("button",{type:"button","aria-pressed":n,onClick:r`, `c.jsx("button",{type:"button","aria-pressed":n,onClick:r,${confirmKey("n", "__cbConfirm?.()")}`);
  replace(
    `c.jsx(gA,{option:n,voice:n.voice,selected:a,preview:t,onPick:()=>e.pick(n.label)}`,
    `c.jsx(gA,{option:n,voice:n.voice,selected:a,preview:t,onPick:()=>e.pick(n.label),onConfirm:()=>e.confirm("")}`,
  );

  // 8. Windows wording (see onWin): the project's reveal button and the agent's reveal step.
  replace('"aria-label":`Show ${R0(s)} in Finder`', '"aria-label":`Show ${R0(s)} in ${window.desktop?.platform==="win32"?"File Explorer":"Finder"}`');
  macWords(replace, [
    [`reveal:{running:%,`, "Revealing the project in Finder", "Revealing the project in File Explorer"],
    [`done:%}`, "Revealed the project in Finder", "Revealed the project in File Explorer"],
  ]);
});
