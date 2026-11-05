// Patches Cardboard's renderer: its main bundle (index-*.js), the editor's (EditorRoute-*.js) and the editor
// store's (installErrorTelemetry-*.js).
// - A dropped folder imports the media inside it.
// - Windows keyboards: shortcut recording and conflicts, the Shortcuts page's keyboard, Ctrl+Y.
// - Answering the agent's questions from the keyboard.
// - The timeline keeps the playhead in view, and redraws after the GPU drops its canvases.
// - Playback starts without waiting on muted audio, and at once on a second press.
// - Graphics with a video inside play without waiting on the video's frames ("speed").
// - The editor stops measuring the preview's place on every frame while nothing moves ("speed").
// - What is drawn over the preview (graphics…) keeps the preview's scale in full screen with the preview zoomed.
// - Badges in prompt boxes are one unit and open on a click; clicking the timeline takes the keyboard.
// - The editor rail's tooltips show.
// - The pages' part of the activity log (see __cbLog in patch-main.js).
// Usage: node patch-renderer.js <…/index-*.js> <…/EditorRoute-*.js> <…/installErrorTelemetry-*.js>
const fs = require("fs");
const path = require("path");

const [indexFile, editorFile, storeFile] = process.argv.slice(2);
if (!storeFile) throw new Error("usage: node patch-renderer.js <index-*.js> <EditorRoute-*.js> <installErrorTelemetry-*.js>");
// CB_BASELINE=1 (build-windows.js --baseline) leaves out the "speed" changes, as patch-worker.js does.
const speed = process.env.CB_BASELINE !== "1";

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
  console.log(`patched ${path.basename(file)} (${src.length} bytes${speed ? "" : ", baseline"})`);
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
// The editor's bundle (EditorRoute) and the store's report playback, preview and canvas events through it.
window.__cbLog=__cbLog;
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

  // ── Badges in prompt boxes, and the timeline's clicks ──
  // 16. A badge in a prompt box (a clip or media file mentioned, a file attached, a pasted link, a skill) is
  // one unit for the caret. A badge is text in the box's textarea with a chip drawn over it: two figure
  // spaces, the name, a no-break space (ha, t5, H1). The caret could go inside it: a click on a badge or ←/→
  // put the caret between its letters, and typing there broke it into loose text with its chip gone.
  // Backspace and Delete next to one already removed it whole (TD); the word deletes (Ctrl+Backspace,
  // Ctrl+Delete) cut into it. Now a click on a badge opens what it stands for, as a link does, and leaves the
  // caret and the text alone (the editor's part is 18); the keys step over a badge or select it whole; no
  // caret or selection end is ever left inside one. Used by the agent's prompt box (Mz, on the Dashboard and
  // in the editor) and the Report an Issue box (its link badges), whose Backspace took a link badge apart a
  // letter at a time.
  // 17. Clicking the timeline or a clip in the preview takes the keyboard from a text field, as a click
  // anywhere else in the editor does. Both cancel the pointer's default action, so that a drag doesn't
  // select text, and that also kept the focus where it was: with the agent's prompt box focused, Space after
  // clicking a clip typed a space instead of playing, and Delete, S and the arrows edited the prompt. The
  // same kept the keyboard on the timeline's zoom slider, so → and ← zoomed as well as stepping the playhead.
  const badges = String.raw`
// [start, end) of each badge in the text v, for the box's picks p: the same badges the chips are drawn for
// (kr: from the left, the longest badge text starting at each place). kr tries every badge at every
// character, which takes milliseconds on a long prompt; this finds each badge's text with indexOf.
const __cbChips=(v,p)=>{const c=[];for(const k of new Set(p.map(x=>x.token)))if(k)for(let i=v.indexOf(k);i!==-1;i=v.indexOf(k,i+1))c.push([i,i+k.length]);c.sort((x,y)=>x[0]-y[0]||y[1]-x[1]);const r=[];let n=0;for(const x of c)x[0]>=n&&(r.push(x),n=x[1]);return r};
// Whether a badge's text starts, ends or lies across q. It looks only at the characters around q, so the
// checks below cost the same on any length of prompt; the badges are found only when one is there.
const __cbNear=(v,p,q)=>p.some(({token:k})=>k&&v.slice(Math.max(0,q-k.length),q+k.length).includes(k));
// On every selection change: keeps the caret and the selection out of badges, as a last resort (the arrows,
// the word moves and a press on a badge never put it there, see __cbChipKey and __cbChipDown). A key that
// moves into one (Home, End, Page Up/Down on a wrapped badge) carries on to the edge it was heading for, a
// selection that ends inside one takes the whole badge, and anything else goes to its nearer edge.
const __cbSnap=(t,p)=>{
const{selectionStart:s,selectionEnd:e,value:v}=t,back=t.selectionDirection==="backward",o=t.__cbSel;
t.__cbSel={s,e,back,v};
if(s==null||!__cbNear(v,p,s)&&(s===e||!__cbNear(v,p,e)))return;
const rs=__cbChips(v,p),inside=q=>rs.find(([a,b])=>a<q&&q<b);
let f=back?s:e,n=back?e:s;
const rf=inside(f),ra=s===e?void 0:inside(n);
if(!rf&&!ra)return;
// Where the moving end was, when a key moved it (the text unchanged).
const was=o&&o.v===v&&!t.__cbPtr?(o.back?o.s:o.e):null;
if(rf){const[a,b]=rf;f=was!==null&&was!==f?(f<was?a:b):s===e?(f-a<=b-f?a:b):back?a:b}
if(s===e)n=f;else if(ra)n=back?ra[1]:ra[0];
n<=f?t.setSelectionRange(n,f,"forward"):t.setSelectionRange(f,n,"backward");
t.__cbSel={s:Math.min(n,f),e:Math.max(n,f),back:f<n,v}};
// The chip drawn at a point, if any. The chips are in an overlay beside the textarea that takes no pointer
// events, so they are found by their rectangles. A chip's number is its badge's place in kr's list.
const __cbChipAt=(t,x,y)=>[...t.parentElement.querySelectorAll("[data-chip]")].find(c=>[...c.getClientRects()].some(r=>x>=r.left&&x<r.right&&y>=r.top&&y<r.bottom));
// Over a badge the pointer is a hand, as over a link: a click opens it.
const __cbChipCursor=m=>{const t=m.currentTarget,on=!m.buttons&&!!__cbChipAt(t,m.clientX,m.clientY);on!==!!t.__cbHand&&(t.__cbHand=on,t.style.cursor=on?"pointer":"")};
// What a click on a badge opens, each in its own place: a link in the browser, an attached file or a skill's
// file in its app (as the badge card's Preview does, QU), and a clip or media file in the editor, which
// takes the keyboard (the editor's bundle selects the clip on the timeline, or opens the file's Preview from
// the Library).
const __cbOpen=(t,k,skills)=>{
if(!k)return;
const kind=k.kind!=="mention"?k.kind:k.type===ci?"skill":k.target?.kind??"mention";
__cbLog("badge.open",{kind});
if(k.kind==="link")window.open(k.url,"_blank","noopener");
else if(k.kind==="attachment")QU(k.file);
else if(kind==="skill"){const s=skills?.find(x=>x.label===k.label);s?.path&&QU({path:s.path,name:s.label})}
else if(k.target){t.blur();dispatchEvent(new CustomEvent("cb:open-badge",{detail:{kind:k.target.kind,id:k.target.id,label:k.target.label}}))}};
// A mouse press in the box. On a badge the caret doesn't move, not even while the button is down, and a
// click (not a drag, not the second press of a double-click) opens the badge. Any other press is the
// browser's, and while the button is down (React reports the selection only on release) a drag that
// reaches a badge takes it whole.
const __cbChipDown=(m,p,skills)=>{
if(m.button!==0&&m.button!==2)return;
const t=m.currentTarget,c=__cbChipAt(t,m.clientX,m.clientY);
t.__cbPtr=!0;
if(!c){if(m.button===0){const fix=()=>document.activeElement===t&&__cbSnap(t,p);document.addEventListener("selectionchange",fix);addEventListener("mouseup",()=>document.removeEventListener("selectionchange",fix),{once:!0,capture:!0})}return}
m.preventDefault();
if(m.button!==0||m.detail>1)return;
const x=m.clientX,y=m.clientY,n=c.dataset.chip;
addEventListener("mouseup",u=>{if(Math.abs(u.clientX-x)>4||Math.abs(u.clientY-y)>4||__cbChipAt(t,u.clientX,u.clientY)?.dataset.chip!==n)return;const k=kr(t.value,p)[Number(n)];k&&__cbOpen(t,k.pick??p.find(q=>q.token===k.token),skills)},{once:!0,capture:!0})};
// The word keys (Ctrl+Backspace/Delete/←/→, Option on a Mac).
const __cbMac=window.desktop?.platform==="darwin",__cbWordKey=k=>__cbMac?k.altKey&&!k.ctrlKey&&!k.metaKey:k.ctrlKey&&!k.altKey&&!k.metaKey;
// Where the caret at q is drawn ({left, top, bottom}): the chips' overlay beside the textarea holds the same
// text, laid out the same. It is measured on the character at q, since at a line wrap the caret is drawn at
// the start of the next line (a collapsed range there gives the end of the line above); at the very end, after
// the last character.
const __cbCaretRect=(t,q)=>{const o=t.parentElement?.querySelector('[aria-hidden="true"]');if(!o)return null;const w=document.createTreeWalker(o,NodeFilter.SHOW_TEXT),r=document.createRange();let x,at=0,last=null;while(x=w.nextNode()){const l=x.data.length;if(q<at+l){r.setStart(x,q-at);r.setEnd(x,q-at+1);const c=r.getClientRects()[0];return c?{left:c.left,top:c.top,bottom:c.bottom}:null}at+=l;l&&(last=x)}if(!last)return null;r.setStart(last,last.data.length-1);r.setEnd(last,last.data.length);const c=r.getClientRects()[0];return c?{left:c.right,top:c.top,bottom:c.bottom}:null};
// Keys at a badge, before the box's own handling: ← → step over it (with Shift, select it whole), Backspace
// and Delete remove it whole (Cardboard's TD), and so do the word deletes, also across the spaces between
// the caret and the badge. True when it took the key; the delete keys then delete the selection it made.
const __cbChipKey=(k,p)=>{
const t=k.currentTarget;t.__cbPtr=!1;
if(k.nativeEvent?.isComposing)return!1;
const{selectionStart:s,selectionEnd:e,value:v}=t,back=t.selectionDirection==="backward",f=back?s:e,n=back?e:s,right=k.key==="ArrowRight";
const go=to=>{k.preventDefault();k.shiftKey?n<=to?t.setSelectionRange(n,to,"forward"):t.setSelectionRange(to,n,"backward"):t.setSelectionRange(to,to);return!0};
if((right||k.key==="ArrowLeft")&&!k.ctrlKey&&!k.altKey&&!k.metaKey&&(s===e||k.shiftKey)){
const r=__cbNear(v,p,f)&&__cbChips(v,p).find(([a,b])=>(right?a:b)===f);
return r?go(right?r[1]:r[0]):!1}
// The word moves (Ctrl+← →, Option on a Mac) treat a badge as one word. The browser takes its leading figure
// spaces for spaces and its name for words, so where the next or previous stop was in a badge the caret
// landed inside it. These take over exactly there, and leave every other stop to the browser (measured on
// Windows: Ctrl+→ stops before punctuation and at a line's end, Ctrl+← at punctuation):
// - Ctrl+→ (to the next word's start): from a badge's start, past it and the spaces after it; to the badge,
//   from punctuation, spaces or a line break before it, or from a word followed by spaces and the badge.
// - Ctrl+← (to the previous word's start): to the badge's start, across spaces and line breaks after it.
// - Option+→ / Option+← on a Mac, which skip punctuation: to the badge's end, or its start.
if((right||k.key==="ArrowLeft")&&__cbWordKey(k)){
const rs=__cbChips(v,p),word=/[\p{L}\p{N}_]/u;
if(right){const r=rs.find(([a])=>a>=f);if(!r)return!1;const[a,b]=r,gap=v.slice(f,a);
if(__cbMac)return word.test(gap)?!1:go(b);
if(f===a){let to=b;for(;to<v.length&&(v[to]===" "||v[to]==="\t");)to++;return go(to)}
return!word.test(gap)||/^[\p{L}\p{N}_]+[ \t]*$/u.test(gap)?go(a):!1}
const r=rs.findLast(([,b])=>b<=f);if(!r)return!1;const gap=v.slice(r[1],f);
return(__cbMac?!word.test(gap):/^\s*$/.test(gap))?go(r[0]):!1}
// ↑ ↓ that would land inside a badge on the line above or below go to the badge's edge on that line nearer
// the caret's column instead. Where they land is found from where the caret is drawn in the chips' overlay,
// as the browser does: from the selection's start (↑) or end (↓) when Shift isn't held, and at the column the
// first of a run of ↑ ↓ started from.
if((k.key==="ArrowUp"||k.key==="ArrowDown")&&p.length>0&&!k.ctrlKey&&!k.altKey&&!k.metaKey){
const up=k.key==="ArrowUp",from=k.shiftKey||s===e?f:up?s:e,c=__cbCaretRect(t,from);if(!c)return!1;
const g=t.__cbGoal,x=g&&g.at===from?g.x:c.left,lh=parseFloat(getComputedStyle(t).lineHeight)||c.bottom-c.top||20,y=up?c.top-lh/2:c.bottom+lh/2;
// Where this move ends, for the next one (the browser's move has happened by then).
setTimeout(()=>{t.__cbGoal={x,at:t.selectionDirection==="backward"?t.selectionStart:t.selectionEnd}},0);
const q=document.caretPositionFromPoint?.(x,y);if(q?.offsetNode!==t)return!1;
const r=__cbChips(v,p).find(([a,b])=>a<q.offset&&q.offset<b);if(!r)return!1;
const d=o=>{const m=__cbCaretRect(t,o);return m?Math.abs((m.top+m.bottom)/2-y)*1e3+Math.abs(m.left-x):1/0};
return go(d(r[0])<=d(r[1])?r[0]:r[1])}
if(k.key!=="Backspace"&&k.key!=="Delete"||t.readOnly||t.disabled)return!1;
const fwd=k.key==="Delete";
if(s===e&&__cbWordKey(k)){
let q=s;
if(fwd)for(;q<v.length&&(v[q]===" "||v[q]==="\t");)q++;else for(;q>0&&(v[q-1]===" "||v[q-1]==="\t");)q--;
const r=__cbNear(v,p,q)&&__cbChips(v,p).find(([a,b])=>(fwd?a:b)===q);
if(!r)return!1;
fwd?t.setSelectionRange(s,r[1]):t.setSelectionRange(r[0],s);
return!0}
if(k.metaKey||k.ctrlKey||s===e&&!__cbNear(v,p,s))return!1;
const r=TD(v,p,s,e,fwd?"forward":"backward");
if(r===null)return!1;
t.setSelectionRange(r.start,r.end);
return!0};
// 17: a click on the timeline or the preview blurs what has the keyboard outside it. A click on the
// timeline's tracks, ruler or track headers blurs whatever has it there too (its zoom slider kept it, so → and
// ← then zoomed as well as stepping the playhead), unless the click is inside it. The preview's own fields
// (its text editing) keep their ways.
addEventListener("pointerdown",e=>{const a=document.activeElement,t=e.target;if(!e.isTrusted||!(a instanceof HTMLElement)||a===document.body||!(t instanceof Element)||a.contains(t))return;const r=t.closest('[data-analytics-region="editor-timeline"],[data-analytics-region="editor-preview"]');r&&(!r.contains(a)||t.closest("[data-timeline-scroll],[data-vertical-scroll-region]"))&&a.blur()},{capture:!0,passive:!0});
`;
  replace(`function J0(e){`, badges + `function J0(e){`);
  // The agent's prompt box: its keys, its selection and its mouse presses.
  replace(
    `if((W.key==="Backspace"||W.key==="Delete")&&!W.metaKey&&!W.ctrlKey&&!Me.busy){`,
    `if(__cbChipKey(W,rn))return;if((W.key==="Backspace"||W.key==="Delete")&&!W.metaKey&&!W.ctrlKey&&!Me.busy){`,
  );
  replace(
    `onClick:()=>t1(),onSelect:()=>t1(),`,
    `onClick:()=>t1(),onSelect:W=>{__cbSnap(W.currentTarget,rn),t1()},onMouseDown:W=>__cbChipDown(W,rn,Z),onMouseMove:__cbChipCursor,`,
  );
  // The Report an Issue box, whose badges are pasted links.
  replace(
    `E=S=>{S.key!=="Enter"||!(S.metaKey||S.ctrlKey)||(S.preventDefault(),!d&&e.send())}`,
    `E=S=>{if(__cbChipKey(S,e.links.map($f)))return;S.key!=="Enter"||!(S.metaKey||S.ctrlKey)||(S.preventDefault(),!d&&e.send())}`,
  );
  replace(
    `onKeyDown:E,onPaste:p,onScroll:x,placeholder:"What happened?"`,
    `onKeyDown:E,onSelect:S=>__cbSnap(S.currentTarget,e.links.map($f)),onMouseDown:S=>__cbChipDown(S,e.links.map($f)),onMouseMove:__cbChipCursor,onPaste:p,onScroll:x,placeholder:"What happened?"`,
  );
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

  // 9. Previous/next frame (← →) keep the playhead in view. Jump to start/end scroll the timeline to it (H1),
  // the frame steps did not: holding ← walked the playhead off the edge of the timeline, out of sight.
  replace(
    `U.getState().setPlaybackPosition(_),d("timeline"),it("playback_prev_frame",{})`,
    `U.getState().setPlaybackPosition(_),H1({playheadTime:_,pixelsPerSecond:U.getState().pixelsPerSecond}),d("timeline"),it("playback_prev_frame",{})`,
  );
  replace(
    `U.getState().setPlaybackPosition(H),d("timeline"),it("playback_next_frame",{})`,
    `U.getState().setPlaybackPosition(H),H1({playheadTime:H,pixelsPerSecond:U.getState().pixelsPerSecond}),d("timeline"),it("playback_next_frame",{})`,
  );

  // 10. Dragging the playhead (or scrubbing the ruler) past the edge of the timeline scrolls it. Zv, the
  // scrub both use, followed the pointer only within the visible part: past the edge the playhead left the
  // view and the timeline stayed put, so a far point could only be reached by scrolling first. Once the
  // pointer has moved, being within 12 px of an edge or past it scrolls the timeline that way, faster the
  // further out (up to 48 px a frame), and the time follows the pointer as it does. Rightward it stops
  // once the project's end is in view: the playhead stops at the end, and the timeline runs on far past it.
  replace(
    `const I=M=>x(M.clientX),w=M=>v(M.clientX);window.addEventListener("mousemove",I),window.addEventListener("mouseup",w),f.current=()=>{window.removeEventListener("mousemove",I),window.removeEventListener("mouseup",w)},E&&x(S)}`,
    `let __cbX=S,__cbMoved=!1,__cbRaf=0;const __cbEdge=()=>{__cbRaf=requestAnimationFrame(__cbEdge);if(!__cbMoved)return;const q=document.querySelector("[data-timeline-scroll]");if(!q)return;const r=q.getBoundingClientRect(),over=__cbX<r.left+12?__cbX-(r.left+12):__cbX>r.right-12?__cbX-(r.right-12):0;if(over===0)return;const st=U.getState(),was=q.scrollLeft,end=Math.max(0,st.duration*st.pixelsPerSecond-q.clientWidth+24);let to=was+Math.sign(over)*Math.min(48,2+Math.abs(over)*.5);over>0&&(to=Math.min(to,Math.max(was,end)));if(to===was)return;q.scrollLeft=to;q.scrollLeft!==was&&x(__cbX)};__cbRaf=requestAnimationFrame(__cbEdge);` +
      `const I=M=>(__cbX=M.clientX,__cbMoved=!0,x(M.clientX)),w=M=>v(M.clientX);window.addEventListener("mousemove",I),window.addEventListener("mouseup",w),f.current=()=>{cancelAnimationFrame(__cbRaf),window.removeEventListener("mousemove",I),window.removeEventListener("mouseup",w)},E&&x(S)}`,
  );

  // 11. The timeline redraws when the GPU gives its canvases back. Its ruler and tracks are opaque 2D
  // canvases; when the GPU drops them (a driver reset, the GPU process restarting, memory pressure) Chromium
  // restores them blank, black, and fires contextrestored, which nothing listened to. They stayed black
  // until something else made them redraw (measured: still 99% black 10 s after the GPU process restarted).
  replace(
    `const b=o.useCallback(T=>{if(!s.current)return null;const S=s.current.getBoundingClientRect();return(T-S.left+u.current.offsetX)/p.current},[])`,
    `o.useEffect(()=>{const c=s.current;if(!c)return;const f=()=>{window.__cbLog?.("canvas.restored",{what:"ruler"}),g()};c.addEventListener("contextrestored",f);return()=>c.removeEventListener("contextrestored",f)},[g]);` +
      `const b=o.useCallback(T=>{if(!s.current)return null;const S=s.current.getBoundingClientRect();return(T-S.left+u.current.offsetX)/p.current},[])`,
  );
  replace(
    `o.useEffect(()=>{ee.current=we},[we]);`,
    `o.useEffect(()=>{ee.current=we},[we]);o.useEffect(()=>{const cs=[I.current,M.current].filter(Boolean),f=e=>{e.target===I.current&&window.__cbLog?.("canvas.restored",{what:"tracks"}),we()};for(const c of cs)c.addEventListener("contextrestored",f);return()=>{for(const c of cs)c.removeEventListener("contextrestored",f)}},[we]);`,
  );

  // 12. Starting playback waits only for audio that will be heard. After a seek, Play waits (up to 8 s,
  // "Loading audio...") until the sound of every clip in the next seconds is loaded, and that included
  // clips on muted tracks and muted, hidden or reversed clips, which the audio graph (syncAudioGraph) never
  // plays. __cbAudible keeps what syncAudioGraph keeps. A wait over half a second goes in the activity log.
  replace(
    `hasBuffersReadyForClipsAtTime(ge.current.timelineItems,ge.current.mediaItems,K,we)`,
    `hasBuffersReadyForClipsAtTime(__cbAudible(ge.current),ge.current.mediaItems,K,we)`,
  );
  replace(
    `ne.preloadAudioForClipsAtTime(ge.current.timelineItems,ge.current.mediaItems,me,de)`,
    `ne.preloadAudioForClipsAtTime(__cbAudible(ge.current),ge.current.mediaItems,me,de)`,
  );
  // Each load is numbered (window.__cbPreloadGen, shared with the store, see 15): only the newest one may
  // clear the loading flag and start playback when it ends. Once 15 lets Play start during a load, a
  // pause, a seek and Play again start a second load while the first still runs, and the first one's end
  // started playback before the second load's audio was in.
  replace(`we(!0);let Q=!1;try{`, `const __cbG=window.__cbPreloadGen=(window.__cbPreloadGen||0)+1;we(!0);let Q=!1;const __cbT=performance.now();try{`);
  replace(
    `finally{we(!1);const{pendingPlayback:ne}=U.getState();ne&&(K(!1),X(!0)),Q&&Et.info("Still loading audio, playback may start silent")}`,
    `finally{if(__cbG===window.__cbPreloadGen){we(!1);const{pendingPlayback:ne}=U.getState();ne&&(K(!1),X(!0)),Q&&Et.info("Still loading audio, playback may start silent");const __cbMs=performance.now()-__cbT;__cbMs>500&&window.__cbLog?.("playback.wait",{ms:Math.round(__cbMs),timedOut:Q,started:ne})}}`,
  );
  replace(
    `class sH{`,
    `const __cbAudible=c=>{const m=new Map(c.tracks.map(t=>[t.id,t]));return c.timelineItems.filter(u=>{if(u.type!=="audio"&&u.type!=="video")return!0;const k=m.get(u.trackId);return!(!k||k.muted||cn(u)||u.muted||u.audioDisabled||u.playbackDirection==="reverse")})};class sH{`,
  );

  // 13. A graphic is rebuilt only when its page stops answering. sH, the preview's frame pump, started its
  // 10 s "stopped responding" timer before fetching the graphic's video frames, so a slow video decode
  // (a busy machine) rebuilt the graphic's page, which stays invisible until it draws: the preview went
  // black for as long as the new page took. The page's timer now starts when the frame is sent to it; a
  // slow fetch is waited for, and only one that hasn't answered in 30 s gets Cardboard's rebuild (see
  // below). Rebuilds and slow fetches go in the activity log.
  replace(
    `if(n&&a.rebuilds<rH){a.rebuilds++,this.options.onRebuild();return}`,
    `if(n&&a.rebuilds<rH){a.rebuilds++,window.__cbLog?.("preview.rebuild",{reason:t}),this.options.onRebuild();return}`,
  );
  // 14 (speed). While playing, a graphic draws with the newest video frame that is ready instead of waiting
  // for the frame of this exact moment. Every frame of a graphic waited for its video assets' frames, even
  // when the video wasn't on screen, and only then asked for the next: measured 7–13 frames/s with a video
  // inside against 32–41 without, and multi-second freezes when a decode was slow. Paused and scrubbing,
  // and the first frame after Play, still wait for the exact frame. Frames held as bitmaps (transferred to
  // the page, so not reusable) keep the old way.
  const pumpFrom = `const r=this.options.counters.nextRequestId++;this.requestTime=n,this.requestKey=this.options.renderKey?.(),this.requestId=r,this.timer=setTimeout(()=>this.fail("The graphic stopped responding.",!0),aH);const s=l=>{this.active&&this.requestId===r&&this.fail(l instanceof Error?l.message:String(l),!1)},i=l=>{if(!this.active||this.requestId!==r){qc(l);return}const d=this.options.playbackSession?.(),u=a!==void 0&&a===d,m=this.pendingTime!==null&&this.pendingTime!==n;if(a!==d||this.requestKey!==this.options.renderKey?.()||m&&!u){qc(l),this.clearTimer(),this.requestId=null,this.pendingTime??=this.latestTime,this.pump();return}const h={type:Cs.render,id:r,time:n};l&&(h.frames=l);const p=o3(l);try{p.length===0?t.postMessage(h,"*"):t.postMessage(h,"*",p)}catch(f){qc(l),s(f)}};try{const l=this.options.frames?.(n);l?l.then(i,s):i(void 0)}catch(l){s(l)}}}`;
  // 13's part: the page's timer starts at postMessage. A fetch that is only slow is waited for (and logged
  // at 10 s): its result is used when it comes. Only a fetch that hasn't answered in 30 s falls back to
  // what Cardboard did at 10 s, rebuilding the page (and after two rebuilds, its "couldn't render" note),
  // so one request has one fetch at a time and a hung decode still ends somewhere.
  const rel = (l) => `${l}!==this.__cbFrames&&qc(${l})`;
  const pumpTo =
    `const r=this.options.counters.nextRequestId++;this.requestTime=n,this.requestKey=this.options.renderKey?.(),this.requestId=r;` +
    `const __cbW=setTimeout(()=>{this.active&&this.requestId===r&&this.__cbSlow("frames",aH)},aH),__cbW2=setTimeout(()=>{this.active&&this.requestId===r&&this.fail("The graphic stopped responding.",!0)},3*aH);` +
    `const s=l=>{clearTimeout(__cbW),clearTimeout(__cbW2),this.active&&this.requestId===r&&this.fail(l instanceof Error?l.message:String(l),!1)},i=l=>{clearTimeout(__cbW),clearTimeout(__cbW2);if(!this.active||this.requestId!==r){${rel("l")};return}const d=this.options.playbackSession?.(),u=a!==void 0&&a===d,m=this.pendingTime!==null&&this.pendingTime!==n;if(a!==d||this.requestKey!==this.options.renderKey?.()||m&&!u){${rel("l")},this.clearTimer(),this.requestId=null,this.pendingTime??=this.latestTime,this.pump();return}const h={type:Cs.render,id:r,time:n};l&&(h.frames=l);const p=o3(l);this.timer=setTimeout(()=>this.fail("The graphic stopped responding.",!0),aH);try{p.length===0?t.postMessage(h,"*"):t.postMessage(h,"*",p)}catch(f){${rel("l")},s(f)}};` +
    `try{(a===void 0||this.__cbSession!==a)&&(this.__cbSession=a,this.__cbFrames=void 0);` +
    (speed
      ? // 14: playing with frames in hand: draw now, fetch the next frames alongside.
        `if(a!==void 0&&this.__cbFrames!==void 0){this.__cbFetch(n,a),i(this.__cbFrames);return}` +
        `const l=this.options.frames?.(n);l?l.then(x=>{a!==void 0&&this.__cbSession===a&&x&&o3(x).length===0&&(this.__cbFrames=x),i(x)},s):i(void 0)`
      : `const l=this.options.frames?.(n);l?l.then(i,s):i(void 0)`) +
    `}catch(l){s(l)}}` +
    // One fetch at a time; the newest frames replace the held ones if nothing was transferred. A fetch
    // that hasn't answered in 30 s is given up (its late answer dropped) so a new one can start.
    `__cbFetch(n,a){if(this.__cbBusy)return;let l;try{l=this.options.frames?.(n)}catch{return}if(!l)return;const tok=this.__cbBusy={},t0=performance.now(),tm=setTimeout(()=>{this.__cbBusy===tok&&(this.__cbBusy=null,this.__cbSlow("video-frame",3*aH))},3*aH);` +
    `l.then(x=>{clearTimeout(tm);const cur=this.__cbBusy===tok;cur&&(this.__cbBusy=null);const ms=performance.now()-t0;cur&&ms>1e3&&this.__cbSlow("video-frame",ms);if(!cur||!this.active||this.__cbSession!==a||!x||o3(x).length!==0){x&&qc(x);return}this.__cbFrames=x},()=>{clearTimeout(tm),this.__cbBusy===tok&&(this.__cbBusy=null)})}` +
    `__cbSlow(kind,ms){const now=Date.now();now-(this.__cbSlowAt??0)<1e4||(this.__cbSlowAt=now,window.__cbLog?.("preview.slow",{kind,ms:Math.round(ms)}))}}`;
  replace(pumpFrom, pumpTo);

  // 18. A click on a badge in the agent's prompt box opens what it stands for (16, __cbOpen). A clip's badge
  // selects the clip, puts the playhead at its start and scrolls the timeline to it, as clicking the clip
  // there would. A media file's badge opens the file in Cardboard's own Media preview, the one its tile's
  // Preview opens in the Library: the Library's state (EY) is asked to preview that file, by its id, from
  // all of the project's media, so a file scrolled out of the list, hidden by a search or sharing its name
  // with another opens as well. Cardboard keeps the Library mounted behind the left panel's other tabs and
  // behind a clip's properties, and the preview opens from there without changing the panel. A collapsed
  // panel is opened as it was (its state, not the rail's Library button, which deselects the clip and so
  // takes its reference out of the prompt). A sound effect from Audio is in the project but not in the
  // Library's list: its badge opens its clip on the timeline if it has one, else the Audio panel. (Music
  // can't be mentioned as a file.) A clip or file deleted since it was mentioned says so. Escape with a
  // Media preview open closes only the preview, as its close button does: the preview listens after the
  // editor's shortcuts, so the same Escape also cleared the selection, and with a clip selected (which a
  // badge, unlike the Library, can open the preview over) its reference left the prompt. In a text field,
  // and with a dialog or menu open over the preview (its delete confirmation, a tile's menu), Escape is left
  // as it was, so it closes that first.
  replace(
    `return tn(Vt.IMPORT_MEDIA,J),{media:F,filteredMedia:ae,`,
    `o.useEffect(()=>{const f=v=>{const d=v.detail;if(!d||d.seen)return;d.seen=!0;const m=F.find(x=>x.id===d.id);if(m){d.found=!0,z(m.id),$(null),P(null),j(d.top);return}const o=(V?.media??[]).find(x=>x.id===d.id);o&&(d.elsewhere=o.data?.type??"other")};addEventListener("cb:preview-media",f);return()=>removeEventListener("cb:preview-media",f)},[F,V]);` +
      `return tn(Vt.IMPORT_MEDIA,J),{media:F,filteredMedia:ae,`,
  );
  const openBadge = String.raw`
const __cbOpenClip=it=>{const st=U.getState();st.isPlaying&&st.setIsPlaying(!1);st.previewMode!=="timeline"&&st.setPreviewMode("timeline");st.selectTimelineItem(it.id);st.setPlaybackPosition(it.startTime);H1({playheadTime:it.startTime,pixelsPerSecond:st.pixelsPerSecond,behavior:"smooth"})};
addEventListener("keydown",e=>{if(e.key!=="Escape"||e.defaultPrevented||e.target instanceof HTMLElement&&(e.target.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)))return;const b=document.querySelector('[role="dialog"][aria-label="Media preview"] button[aria-label="Close preview"]');b&&!document.querySelector('[role="alertdialog"],[role="menu"],[role="dialog"]:not([aria-label="Media preview"])')&&(e.preventDefault(),e.stopImmediatePropagation(),b.click())},!0);
addEventListener("cb:open-badge",e=>{const{kind:k,id:i,label:l}=e.detail??{},st=U.getState();
if(k==="media"){
// d.seen: the Library answered; d.found: it opened the file's preview; d.elsewhere: the file is in the project
// but not in the Library's list. The preview is placed beside the left panel, near its top.
const ask=()=>{const p=document.querySelector("[data-editor-left-panel]")?.getBoundingClientRect(),d={id:i,top:(p?.top??0)+64};dispatchEvent(new CustomEvent("cb:preview-media",{detail:d}));return d};
st.isLeftPanelCollapsed&&st.setLeftPanelCollapsed(!1);
let n=0;const go=()=>{const d=ask();if(d.found)return;
if(d.elsewhere){const c=U.getState().timelineItems.find(x=>x.mediaItemId===i);c?__cbOpenClip(c):d.elsewhere==="audio"?(U.getState().setActiveLeftTab("music"),Et.info(l+" is in Audio, with the music and sound effects.")):Et.info(l+" isn't in the Library anymore.");return}
if(d.seen){Et.info(l+" isn't in the Library anymore.");return}
// No Library mounted: show it by the panel's state, then ask again.
n++===0&&U.getState().setActiveLeftTab("media");n<90?requestAnimationFrame(go):Et.info("Couldn't open the Library to preview "+l+".")};
requestAnimationFrame(go);return}
if(k!=="item")return;
const it=st.timelineItems.find(x=>x.id===i);
it?__cbOpenClip(it):Et.info("That clip isn't on the timeline anymore.")});
`;
  replace(`class sH{`, openBadge + `class sH{`);

  // 19. The editor's left rail (Library, Layout, Audio, Captions, Text, Transitions, Effects) shows its
  // tooltips. Each icon is wrapped in Cardboard's tooltip, but the button inside (H_) kept only its own props
  // and dropped the ones the tooltip's trigger hands it (its pointer and focus handlers, its ref, data-state),
  // so no tooltip ever opened: the rail was icons with no names. The button now takes them; its click runs
  // the trigger's (which closes the tooltip) and then switches the panel, as before.
  replace(
    `H_=({tab:e,tile:t,className:n,label:a})=>{const r=e.icon;return c.jsxs("button",{"aria-label":a===void 0?e.label:void 0,className:W("group flex w-full cursor-pointer flex-col items-center gap-1 px-1",n),onClick:e.select,`,
    `H_=({tab:e,tile:t,className:n,label:a,...__cbTip})=>{const r=e.icon;return c.jsxs("button",{...__cbTip,"aria-label":a===void 0?e.label:void 0,className:W("group flex w-full cursor-pointer flex-col items-center gap-1 px-1",n),onClick:v=>{__cbTip.onClick?.(v),e.select()},`,
  );

  // 20 (speed). The preview's position loop rests while nothing moves. The overlays drawn over the preview
  // (selection handles, a playing graphic's page, background removal, pending generations) follow the
  // canvas's place on screen through one tracker per canvas (pF), which measured it on every screen refresh
  // for as long as the editor was open: 60 or 144 times a second with nothing on screen changing, and in
  // every open project tab, since background tabs are only stacked behind the front one and never hidden
  // (backgroundThrottling off). It polled because the canvas can move without an event of its own: the
  // preview's zoom and pan, a panel sliding or resizing, its aspect-ratio animation. Now each such change
  // wakes the same per-frame measuring, which carries on while the canvas moves (and while a finite
  // animation runs on it or its parents) and stops 0.5 s after it last moved. What wakes it: a parent or the
  // canvas resizing (ResizeObserver) or changing its attributes or children (inline style, class, data-state;
  // MutationObserver, not the subtree), a scroll or transition or animation on a parent, the window or
  // viewport resizing, fonts loading, the preview's zoom, pan or aspect ratio changing in the store, and a
  // press, release or drag of the pointer. A once-a-second check is the safety net for anything else: a
  // timer asks for no frames, so it costs far less than the loop it replaces. Cardboard's own listeners
  // (resize, scroll, its ResizeObserver) still measure at once, and measureNow still measures on demand.
  if (speed) {
    replace(
      `function fF(e,t,n=.5){`,
      `const __cbRectWatch=(el,measure)=>{let raf=0,last=null,since=0;const d=document,now=()=>performance.now(),` +
        `mine=t=>t===d||t instanceof Element&&t.contains(el),` +
        `moving=()=>d.getAnimations().some(x=>x.playState==="running"&&mine(x.effect?.target)&&isFinite(x.effect.getComputedTiming().endTime)),` +
        `tick=()=>{raf=0;const r=measure();r!==last&&(last=r,since=now());(now()-since<500||moving())&&(raf=requestAnimationFrame(tick))},` +
        `wake=()=>{since=now();raf||(raf=requestAnimationFrame(tick))},` +
        `onMine=e=>mine(e.target)&&wake(),onDrag=e=>e.buttons&&wake(),` +
        `ro=new ResizeObserver(()=>{measure(),wake()}),mo=new MutationObserver(wake),` +
        `iv=setInterval(()=>{raf||measure()===last||wake()},1e3),` +
        `off=U.subscribe((s,p)=>{(s.canvasTransform!==p.canvasTransform||s.aspectRatio!==p.aspectRatio)&&wake()}),` +
        `vv=window.visualViewport,` +
        `on=[[d,"scroll",onMine],[d,"transitionrun",onMine],[d,"transitionstart",onMine],[d,"animationstart",onMine],[d,"pointerdown",wake],[d,"pointerup",wake],[d,"pointermove",onDrag],[window,"resize",wake],[vv,"resize",wake],[vv,"scroll",wake],[d.fonts,"loadingdone",wake]];` +
        `for(let x=el;x;x=x.parentElement)ro.observe(x),mo.observe(x,{attributes:!0,childList:!0});` +
        `for(const[t,n,f]of on)t?.addEventListener(n,f,{capture:!0,passive:!0});` +
        `wake();` +
        `return()=>{raf&&cancelAnimationFrame(raf),raf=0,clearInterval(iv),off(),ro.disconnect(),mo.disconnect();for(const[t,n,f]of on)t?.removeEventListener(n,f,{capture:!0})}};` +
        `function fF(e,t,n=.5){`,
    );
    replace(
      `let r=null;const s=()=>{a(),r=window.requestAnimationFrame(s)};r=window.requestAnimationFrame(s);const i=new ResizeObserver(a);`,
      `const __cbRest=__cbRectWatch(e,a);let r=null;const i=new ResizeObserver(a);`,
    );
    replace(`n.stop=()=>{r!==null&&window.cancelAnimationFrame(r),r=null,i.disconnect(),`, `n.stop=()=>{__cbRest(),r!==null&&window.cancelAnimationFrame(r),r=null,i.disconnect(),`);
  }

  // 21. What is drawn over the preview is drawn at the preview's own scale, also in full screen. The preview's
  // zoom (Ctrl+wheel or a pinch over it, undone by its "Reset" button) is a CSS scale on a wrapper around the
  // stage, and the tracker (l8) took that zoom from the store as the scale its overlays are drawn at: a graphic's
  // page, the background-removal shimmer, a pending item's placeholder, a clip's proxy progress ring. Their box is
  // the canvas's box on screen divided by it (Nl). Full screen shows the stage on its own (the browser's top layer), outside
  // the wrapper and its scale, so with the preview zoomed to 0.9 a graphic was drawn 1/0.9 = 1.11 times too large
  // from the frame's top-left corner and cut off at its right and bottom, over a picture drawn right. This is
  // Cardboard's own bug: at any screen scale (no device pixels are involved), so on a Mac too, and 1.4.1 has the
  // same code. The zoom is now the scale the canvas is drawn at, its width on screen over its width in the
  // layout, whatever is around the stage (Carton's Compare, for one, turns the wrapper's scale off too). It is
  // read when the canvas's box changes, as the zoom was; a canvas that isn't laid out keeps the store's zoom.
  replace(`t.rect=n,t.zoom=U.getState().canvasTransform.scale,t.version+=1;`, `t.rect=n,t.zoom=__cbDrawnScale(e,n),t.version+=1;`);
  replace(
    `const Hc=new WeakMap,l8=(e,t)=>{`,
    `const __cbDrawnScale=(e,r)=>{const w=parseFloat(getComputedStyle(e).width);return w>0&&r.width>0?r.width/w:U.getState().canvasTransform.scale};const Hc=new WeakMap,l8=(e,t)=>{`,
  );
});

patch(storeFile, "installErrorTelemetry.orig.js", (replace) => {
  // 15. A second Play while "Loading audio..." starts playback at once. Play after a seek waits for the
  // audio ahead to load (up to 8 s, see 12), and pressing it again did nothing: it was still waiting. Now
  // the second press plays without waiting (the sound joins as it loads, as after the 8 s limit). The
  // loading flag is cleared with it: the button shows that flag before playing, so it kept spinning
  // "Loading audio..." while the playhead ran (measured: playing at 0.9 s, spinner until 6.8 s). Only the
  // button reads the flag. The load it overrode is retired (its number bumped, see 12), so when it ends it
  // neither clears the flag of a newer load nor starts playback.
  replace(
    `if(n.isAudioPreloading){t({pendingPlayback:!0});return}`,
    `if(n.isAudioPreloading){if(n.pendingPlayback){window.__cbPreloadGen=(window.__cbPreloadGen||0)+1,t({isPlaying:!0,pendingPlayback:!1,isAudioPreloading:!1}),window.__cbLog?.("playback.forced",{});return}t({pendingPlayback:!0});return}`,
  );
});
