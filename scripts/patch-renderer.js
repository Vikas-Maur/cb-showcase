// Patches Cardboard's renderer: its main bundle (index-*.js), the editor's (EditorRoute-*.js) and the editor
// store's (installErrorTelemetry-*.js).
// - A dropped folder imports the media inside it.
// - Windows keyboards: shortcut recording and conflicts, the Shortcuts page's keyboard, Ctrl+Y.
// - Answering the agent's questions from the keyboard.
// - The timeline keeps the playhead in view, and redraws after the GPU drops its canvases.
// - The timeline draws a clip's name once when the clip starts just off its left edge (Cardboard drew it twice).
// - Playback starts without waiting on muted audio, and at once on a second press.
// - A graphic whose video frames are slow to decode waits for them instead of being rebuilt.
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
  // Helpers, after Cardboard's own folder walker (qH, which reads directory entries recursively).
  // Chromium lists a dropped folder in dataTransfer.files as one entry with no media type, which the
  // media filter (YH) throws away, so a folder imported nothing. The entries that can be walked (JH)
  // are only readable while the drop event is dispatching, and Cardboard read them after an await.
  replace(
    `async function qH(e){const t=[];return await Promise.all(e.map(a=>U5(a,t))),t}`,
    `async function qH(e){const t=[];return await Promise.all(e.map(a=>U5(a,t))),t}` +
      // The drop's entries, if any of them is a folder. Call while the drop event is dispatching.
      `const __cbDroppedFolders=e=>{const t=JH(e);return t.some(a=>a.isDirectory)?t:null},` +
      `__cbPath=e=>window.desktop?.getPathForFile(e)||e.name,` +
      // Every file in the dropped folders and their subfolders (and any files dropped with them), in path order.
      `__cbWalk=async e=>(await qH(e)).sort((t,a)=>__cbPath(t).localeCompare(__cbPath(a),void 0,{numeric:!0,sensitivity:"base"})),` +
      // For drop targets that opt in: the media in dropped folders. When there is none, the files as
      // dropped, so the target still says what it could not add; with media set, only media, for targets
      // that take any file without a type (a folder of code would attach every LICENSE and Makefile).
      `__cbDropFiles=async(e,m)=>{const t=Array.from(e.files),a=__cbDroppedFolders(e);if(!a)return t;const n=await __cbWalk(a),s=n.filter(YH);return m||s.length>0?s:n.length>0?n:t};`,
  );

  // 1. The editor (its media panel, and anywhere else in the editor): a dropped folder's media files go
  // through the usual filter, which also skips files the project already has.
  replace(
    `CJ=async(e,t)=>{const a=Array.from(e.files);try{const n=await Vg(e);`,
    `CJ=async(e,t)=>{const a=Array.from(e.files),__cbDirs=__cbDroppedFolders(e);try{if(__cbDirs)return W1((await __cbWalk(__cbDirs)).map(c=>({file:c})),t);const n=await Vg(e);`,
  );

  // 2. The Dashboard: a dropped folder's media go where dropped files go (the prompt's attachments). The
  // drop hook takes folders only where asked, so the Report an Issue attachments and other drop targets
  // behave as before.
  replace(`Pn=({onFiles:e,contain:t=!1})=>{`, `Pn=({onFiles:e,contain:t=!1,folders:__cbF=!1})=>{`);
  replace(
    `s.current=0,n(!1),e(Array.from(l.dataTransfer.files)))},[t,e])`,
    `s.current=0,n(!1),__cbF?__cbDropFiles(l.dataTransfer,__cbF==="media").then(e,a=>console.error("[desktop] could not read the dropped folder:",a)):e(Array.from(l.dataTransfer.files)))},[t,e,__cbF])`,
  );
  replace(`N=Pn({onFiles:I})`, `N=Pn({onFiles:I,folders:!0})`);
  // The Dashboard's prompt box ("drop footage") has its own drop target, which keeps the drop from the
  // page's: a folder dropped there became one attachment named after the folder. Now it attaches the
  // folder's media, and nothing else (its filter lets files without a type through).
  replace(`j=Pn({onFiles:D=>C(D),contain:!0})`, `j=Pn({onFiles:D=>C(D),contain:!0,folders:"media"})`);

  // ── Keyboard and activity log ──
  // Helpers, at the top level (and before the shortcut keyboard, G9, is built).
  // q is the request to main, ue the toast, se/$i/UH the shortcut ids, list and matcher.
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
const __cbRedoY=(id,b,e,get)=>__cbWinKeys&&id===se.REDO&&e.key.toLowerCase()==="y"&&(e.ctrlKey||e.metaKey)&&!e.shiftKey&&!e.altKey&&b.key.toLowerCase()==="q"&&(b.meta||b.ctrl)&&b.shift&&!b.alt&&!$i.some(o=>{const x=get(o.id);return x&&UH(e,x)});

// Activity log. Main writes it; this page reports shortcuts, keys nothing handled, how an agent
// question was answered, errors and error toasts. Never text typed into a field.
const __cbLog=(ev,f)=>{try{q("cb:log",{ev,where:location.pathname.startsWith("/app/editor/")?"editor":location.pathname.replace(/^\/app\/?/,"")||"home",...f}).catch(()=>{})}catch{}};
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
  replace(`async function U5(e,t){`, helpers + `async function U5(e,t){`);

  // 3. Recording a shortcut on Windows stores Ctrl as meta (see __cbPrimary). It stored ctrl, which the
  // conflict check told apart from the built-in meta ones, so Ctrl+D for Split was saved without a
  // word while Duplicate also had Ctrl+D, and Ctrl+D then did one or the other.
  replace(
    `const m={key:u.key};u.ctrlKey&&(m.ctrl=!0),u.metaKey&&(m.meta=!0)`,
    `const m={key:u.key};__cbWinKeys?(u.ctrlKey||u.metaKey)&&(m.meta=!0):(u.ctrlKey&&(m.ctrl=!0),u.metaKey&&(m.meta=!0))`,
  );
  // Shortcuts recorded before this fix still have ctrl: compare them as meta too.
  replace(`R4=e=>{`, `R4=e=>{__cbWinKeys&&(e=__cbPrimary(e));`);
  replace(`O5=(e,t)=>`, `O5=(e,t)=>(__cbWinKeys&&(e=__cbPrimary(e),t=__cbPrimary(t)),0)||`);

  // 4. The Shortcuts page's keyboard and its layers, the Windows way (see __cbBoard).
  replace(`G9=[[`, `G9=__cbBoard([[`);
  replace(`,PK=new Map(`, `),PK=new Map(`);
  replace("xd=e=>`", "xd=e=>__cbWinKeys?__cbLayer(e):`");
  replace(`ZK=e=>e===""?"No modifier":e`, `ZK=e=>e===""?"No modifier":__cbWinKeys?e.slice(0,-1):e`);
  replace("\" on their own\":` with ${d}`", "\" on their own\":` with ${__cbWinKeys?d.slice(0,-1):d}`");

  // 5. Ctrl+Y redoes on Windows (see __cbRedoY), and every shortcut that runs goes in the activity log.
  replace(
    `if(h&&UH(l,h)){if(B5()&&(h.meta||h.ctrl)){const u=h.key.toLowerCase();if(u==="c"||u==="x")return}s&&l.preventDefault(),t()}`,
    `if(h&&(UH(l,h)||__cbRedoY(e,h,l,c))){if(B5()&&(h.meta||h.ctrl)){const u=h.key.toLowerCase();if(u==="c"||u==="x")return}s&&l.preventDefault(),__cbShortcut(e,l),t()}`,
  );

  // 6. An answer to an agent question says how it was given (a key, or a click); main logs it with how
  // long the question waited.
  replace(`eX=(e,t,a={})=>q("local-agent:answer",{id:e,answers:t,`, `eX=(e,t,a={})=>q("local-agent:answer",{via:__cbVia(),id:e,answers:t,`);

  // 7. Windows wording (see onWin): Settings → Library and Agents, the plans note, the project menu.
  macWords(replace, [
    [`x.startup?%:x.name`, "this Mac", "this PC"],
    [`children:%`, "Show in Finder", "Show in File Explorer"],
    [`ze(%)`, "Could not show the project in Finder", "Could not show the project in File Explorer"],
    [`lead:%`, "Let Claude Code and Codex on this Mac edit your projects. They sign in with your own Claude and ChatGPT accounts.",
      "Let Claude Code and Codex on this PC edit your projects. They sign in with your own Claude and ChatGPT accounts."],
    [`Me,{title:%`, "On this Mac", "On this PC"],
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
  // Backspace and Delete next to one already removed it whole (HD); the word deletes (Ctrl+Backspace,
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
// (Er: from the left, the longest badge text starting at each place). Er tries every badge at every
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
// events, so they are found by their rectangles. A chip's number is its badge's place in Er's list.
const __cbChipAt=(t,x,y)=>[...t.parentElement.querySelectorAll("[data-chip]")].find(c=>[...c.getClientRects()].some(r=>x>=r.left&&x<r.right&&y>=r.top&&y<r.bottom));
// Over a badge the pointer is a hand, as over a link: a click opens it.
const __cbChipCursor=m=>{const t=m.currentTarget,on=!m.buttons&&!!__cbChipAt(t,m.clientX,m.clientY);on!==!!t.__cbHand&&(t.__cbHand=on,t.style.cursor=on?"pointer":"")};
// What a click on a badge opens, each in its own place: a link in the browser, an attached file or a skill's
// file in its app (as the badge card's Preview does, oz), and a clip or media file in the editor, which
// takes the keyboard (the editor's bundle selects the clip on the timeline, or opens the file's Preview from
// the Library).
const __cbOpen=(t,k,skills)=>{
if(!k)return;
const kind=k.kind!=="mention"?k.kind:k.type===fi?"skill":k.target?.kind??"mention";
__cbLog("badge.open",{kind});
if(k.kind==="link")window.open(k.url,"_blank","noopener");
else if(k.kind==="attachment")oz(k.file);
else if(kind==="skill"){const s=skills?.find(x=>x.label===k.label);s?.path&&oz({path:s.path,name:s.label})}
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
addEventListener("mouseup",u=>{if(Math.abs(u.clientX-x)>4||Math.abs(u.clientY-y)>4||__cbChipAt(t,u.clientX,u.clientY)?.dataset.chip!==n)return;const k=Er(t.value,p)[Number(n)];k&&__cbOpen(t,k.pick??p.find(q=>q.token===k.token),skills)},{once:!0,capture:!0})};
// The word keys (Ctrl+Backspace/Delete/←/→, Option on a Mac).
const __cbMac=window.desktop?.platform==="darwin",__cbWordKey=k=>__cbMac?k.altKey&&!k.ctrlKey&&!k.metaKey:k.ctrlKey&&!k.altKey&&!k.metaKey;
// Where the caret at q is drawn ({left, top, bottom}): the chips' overlay beside the textarea holds the same
// text, laid out the same. It is measured on the character at q, since at a line wrap the caret is drawn at
// the start of the next line (a collapsed range there gives the end of the line above); at the very end, after
// the last character.
const __cbCaretRect=(t,q)=>{const o=t.parentElement?.querySelector('[aria-hidden="true"]');if(!o)return null;const w=document.createTreeWalker(o,NodeFilter.SHOW_TEXT),r=document.createRange();let x,at=0,last=null;while(x=w.nextNode()){const l=x.data.length;if(q<at+l){r.setStart(x,q-at);r.setEnd(x,q-at+1);const c=r.getClientRects()[0];return c?{left:c.left,top:c.top,bottom:c.bottom}:null}at+=l;l&&(last=x)}if(!last)return null;r.setStart(last,last.data.length-1);r.setEnd(last,last.data.length);const c=r.getClientRects()[0];return c?{left:c.right,top:c.top,bottom:c.bottom}:null};
// Keys at a badge, before the box's own handling: ← → step over it (with Shift, select it whole), Backspace
// and Delete remove it whole (Cardboard's HD), and so do the word deletes, also across the spaces between
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
const r=HD(v,p,s,e,fwd?"forward":"backward");
if(r===null)return!1;
t.setSelectionRange(r.start,r.end);
return!0};
// 17: a click on the timeline or the preview blurs what has the keyboard outside it. A click on the
// timeline's tracks, ruler or track headers blurs whatever has it there too (its zoom slider kept it, so → and
// ← then zoomed as well as stepping the playhead), unless the click is inside it. The preview's own fields
// (its text editing) keep their ways.
addEventListener("pointerdown",e=>{const a=document.activeElement,t=e.target;if(!e.isTrusted||!(a instanceof HTMLElement)||a===document.body||!(t instanceof Element)||a.contains(t))return;const r=t.closest('[data-analytics-region="editor-timeline"],[data-analytics-region="editor-preview"]');r&&(!r.contains(a)||t.closest("[data-timeline-scroll],[data-vertical-scroll-region]"))&&a.blur()},{capture:!0,passive:!0});
`;
  replace(`function ei(e){`, badges + `function ei(e){`);
  // The agent's prompt box: its keys, its selection and its mouse presses.
  replace(
    `if((G.key==="Backspace"||G.key==="Delete")&&!G.metaKey&&!G.ctrlKey&&!Ne.busy){`,
    `if(__cbChipKey(G,sn))return;if((G.key==="Backspace"||G.key==="Delete")&&!G.metaKey&&!G.ctrlKey&&!Ne.busy){`,
  );
  replace(
    `onClick:()=>a1(),onSelect:()=>a1(),`,
    `onClick:()=>a1(),onSelect:W=>{__cbSnap(W.currentTarget,sn),a1()},onMouseDown:W=>__cbChipDown(W,sn,Z),onMouseMove:__cbChipCursor,`,
  );
  // The Report an Issue box, whose badges are pasted links.
  replace(
    `E=S=>{S.key!=="Enter"||!(S.metaKey||S.ctrlKey)||(S.preventDefault(),!d&&e.send())}`,
    `E=S=>{if(__cbChipKey(S,e.links.map(Bf)))return;S.key!=="Enter"||!(S.metaKey||S.ctrlKey)||(S.preventDefault(),!d&&e.send())}`,
  );
  replace(
    `onKeyDown:E,onPaste:p,onScroll:x,placeholder:"What happened?"`,
    `onKeyDown:E,onSelect:S=>__cbSnap(S.currentTarget,e.links.map(Bf)),onMouseDown:S=>__cbChipDown(S,e.links.map(Bf)),onMouseMove:__cbChipCursor,onPaste:p,onScroll:x,placeholder:"What happened?"`,
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
  replace(`SA=({option:e,voice:t,selected:n,preview:a,onPick:r})=>`, `SA=({option:e,voice:t,selected:n,preview:a,onPick:r,onConfirm:__cbConfirm})=>`);
  replace(`c.jsx("button",{type:"button","aria-pressed":n,onClick:r`, `c.jsx("button",{type:"button","aria-pressed":n,onClick:r,${confirmKey("n", "__cbConfirm?.()")}`);
  replace(
    `c.jsx(SA,{option:n,voice:n.voice,selected:a,preview:t,onPick:()=>e.pick(n.label)}`,
    `c.jsx(SA,{option:n,voice:n.voice,selected:a,preview:t,onPick:()=>e.pick(n.label),onConfirm:()=>e.confirm("")}`,
  );

  // 8. Windows wording (see onWin): the project's reveal button and the agent's reveal step.
  replace('"aria-label":`Show ${L0(s)} in Finder`', '"aria-label":`Show ${L0(s)} in ${window.desktop?.platform==="win32"?"File Explorer":"Finder"}`');
  macWords(replace, [
    [`reveal:{running:%,`, "Revealing the project in Finder", "Revealing the project in File Explorer"],
    [`done:%}`, "Revealed the project in Finder", "Revealed the project in File Explorer"],
  ]);

  // 9. Previous/next frame (← →) keep the playhead in view. Jump to start/end scroll the timeline to it (G1),
  // the frame steps did not: holding ← walked the playhead off the edge of the timeline, out of sight.
  replace(
    `U.getState().setPlaybackPosition(_),d("timeline"),lt("playback_prev_frame",{})`,
    `U.getState().setPlaybackPosition(_),G1({playheadTime:_,pixelsPerSecond:U.getState().pixelsPerSecond}),d("timeline"),lt("playback_prev_frame",{})`,
  );
  replace(
    `U.getState().setPlaybackPosition(V),d("timeline"),lt("playback_next_frame",{})`,
    `U.getState().setPlaybackPosition(V),G1({playheadTime:V,pixelsPerSecond:U.getState().pixelsPerSecond}),d("timeline"),lt("playback_next_frame",{})`,
  );

  // 10. Dragging the playhead (or scrubbing the ruler) past the edge of the timeline scrolls it. Zv, the
  // scrub both use, followed the pointer only within the visible part: past the edge the playhead left the
  // view and the timeline stayed put, so a far point could only be reached by scrolling first. Once the
  // pointer has moved, being within 12 px of an edge or past it scrolls the timeline that way, faster the
  // further out (up to 48 px a frame), and the time follows the pointer as it does. Rightward it stops
  // once the project's end is in view: the playhead stops at the end, and the timeline runs on far past it.
  replace(
    `const I=M=>x(M.clientX),C=M=>v(M.clientX);window.addEventListener("mousemove",I),window.addEventListener("mouseup",C),f.current=()=>{window.removeEventListener("mousemove",I),window.removeEventListener("mouseup",C)},E&&x(T)}`,
    `let __cbX=T,__cbMoved=!1,__cbRaf=0;const __cbEdge=()=>{__cbRaf=requestAnimationFrame(__cbEdge);if(!__cbMoved)return;const q=document.querySelector("[data-timeline-scroll]");if(!q)return;const r=q.getBoundingClientRect(),over=__cbX<r.left+12?__cbX-(r.left+12):__cbX>r.right-12?__cbX-(r.right-12):0;if(over===0)return;const st=U.getState(),was=q.scrollLeft,end=Math.max(0,st.duration*st.pixelsPerSecond-q.clientWidth+24);let to=was+Math.sign(over)*Math.min(48,2+Math.abs(over)*.5);over>0&&(to=Math.min(to,Math.max(was,end)));if(to===was)return;q.scrollLeft=to;q.scrollLeft!==was&&x(__cbX)};__cbRaf=requestAnimationFrame(__cbEdge);` +
      `const I=M=>(__cbX=M.clientX,__cbMoved=!0,x(M.clientX)),C=M=>v(M.clientX);window.addEventListener("mousemove",I),window.addEventListener("mouseup",C),f.current=()=>{cancelAnimationFrame(__cbRaf),window.removeEventListener("mousemove",I),window.removeEventListener("mouseup",C)},E&&x(T)}`,
  );

  // 11. The timeline redraws when the GPU gives its canvases back. Its ruler and tracks are opaque 2D
  // canvases; when the GPU drops them (a driver reset, the GPU process restarting, memory pressure) Chromium
  // restores them blank, black, and fires contextrestored, which nothing listened to. They stayed black
  // until something else made them redraw (measured: still 99% black 10 s after the GPU process restarted).
  replace(
    `const b=o.useCallback(S=>{if(!s.current)return null;const T=s.current.getBoundingClientRect();return(S-T.left+u.current.offsetX)/p.current},[])`,
    `o.useEffect(()=>{const c=s.current;if(!c)return;const f=()=>{window.__cbLog?.("canvas.restored",{what:"ruler"}),g()};c.addEventListener("contextrestored",f);return()=>c.removeEventListener("contextrestored",f)},[g]);` +
      `const b=o.useCallback(S=>{if(!s.current)return null;const T=s.current.getBoundingClientRect();return(S-T.left+u.current.offsetX)/p.current},[])`,
  );
  replace(
    `o.useEffect(()=>{te.current=we},[we]);`,
    `o.useEffect(()=>{te.current=we},[we]);o.useEffect(()=>{const cs=[I.current,M.current].filter(Boolean),f=e=>{e.target===I.current&&window.__cbLog?.("canvas.restored",{what:"tracks"}),we()};for(const c of cs)c.addEventListener("contextrestored",f);return()=>{for(const c of cs)c.removeEventListener("contextrestored",f)}},[we]);`,
  );

  // 22. A clip's name is drawn once on the timeline. Cardboard draws the names on two canvases (D$): the tracks'
  // base canvas, which scrolls with the clips and spans up to three screens around the view (Iv) so that it is
  // redrawn only every half screen of scrolling, holds each name at its clip's start ("natural": k1 with the base's
  // own left edge); a fixed canvas over the view (the "titles" layer, Ee) holds the names of clips that start left of
  // the view at its left edge ("sticky", k1 with the scroll position), redrawn on every scroll. A clip that starts
  // left of the view but on the base canvas was on both: its name at its start, cut by the view's edge, and again
  // at the edge, the two overlapping ("…verie (light score)" over "Arctic Reverie (light score)") whenever the
  // clip started less than its name's width off screen. Cardboard's own code, on any screen and scale (seen at
  // 1, 1.25 and 2 in its pristine 1.4.0 pages, and unchanged in 1.4.1); not ours, and only the drawing of names.
  // Now the fixed canvas draws a clip's name at the edge only once the name on the base canvas has wholly left the
  // view: until then that name scrolls off with its clip, cut by the edge, and then it shows at the edge. The base
  // canvas is Cardboard's, untouched (its redraws cost what they did, it keeps nothing); the fixed canvas, which
  // already draws the sticky names on every scroll, leaves out those whose clip's name the base canvas still
  // shows in the view: its letters' right edge as I1 draws them (__cbNameEnd, measureText's ink box, once per name
  // per redraw of the base canvas), so the edge name comes once no more than 2 px of the last letter is left (a faint
  // sliver, 6 px clear of the edge name: no frame without a name).
  // Rejected after review: handing each name over between the two canvases at the edge (a copy of the base
  // canvas's name rows taken on redraws while scrolling, to take a name off it) made those redraws slower and kept
  // the copy's memory, and a separate canvas for the names would cost its own memory and compositing. The name
  // can't move to the fixed canvas before then either: that canvas is redrawn in the frame after a scroll, so a name
  // that moves with its clip would trail it. This also stops the edge name of a graphic with a poster being drawn
  // over its own name (Cardboard counts it sticky while it still sits at the clip's start, right of the poster).
  // Drags and marquees draw what Cardboard draws (the fixed canvas is cleared during them).
  // The switch must be drawn in the frame the view moves. Cardboard's wheel and touchpad scrolling (a non-passive wheel
  // handler) moves the view inside an animation frame, but the timeline redraws its names on the scroll event, which
  // comes a frame later: each wheel notch, and the first frame of a touchpad stroke, was shown with the fixed canvas
  // still drawn for where the view had been. Cardboard's own edge names hide it (they stay put); at the switch it
  // showed as a frame with no name (scrolling right) or with the clip's name coming back under the edge one
  // (scrolling left). Now the wheel's frame runs the timeline's own scroll update (X: the base canvas's window, and the
  // fixed canvas) at once, and the update the scroll event then asks for at the same place is skipped, once (K's
  // unchanged-window branch), so the names are drawn as many times as before, a frame sooner on a notch. Scrolling
  // the timeline's scrollbar or with the keyboard still updates a frame late, as in Cardboard.
  // Same code on a Mac and on Windows: it isn't a Windows difference.
  const labels = String.raw`__cbNameEnd=(g,n,cache)=>{g.save(),g.font=ym;let r=n.x;if(n.kind){const d=zU(g,n.kind);if(d-ku<=n.maxWidth){const u=d-ku+BU,m=n.maxWidth-u;let h="";g.measureText(n.label).width<=m?h=n.label:m>=UU&&(h=E1(g,n.label,m,cache)),r=Math.max(n.x-ku+d,h?n.x+u+g.measureText(h).actualBoundingBoxRight:0)}}else{const l=E1(g,n.label,n.maxWidth,cache);l&&(r=n.x+g.measureText(l).actualBoundingBoxRight)}return g.restore(),r},
__cbEdgeNames=(c,list,sl,g,cache)=>{const nat=c?.__cbNat;if(!nat?.length||!list.length)return list;const by=nat.by??=new Map(nat.map(n=>[n.itemId,n])),on=e=>{const n=by.get(e.itemId);return!!n&&(n.end??=__cbNameEnd(g,n,cache))>sl+2};return list.some(on)?list.filter(e=>!on(e)):list},`;
  // The helpers, beside the names' own functions (k1 lays them out, I1 draws them).
  replace(`,WU=8,ZU=28,GU=(`, `,${labels}WU=8,ZU=28,GU=(`);
  // The base canvas's names, as drawn, kept on the canvas for the fixed canvas to look up.
  replace(
    `I1({ctx:J,entries:ue?ie.filter(Re=>!ue.has(Re.itemId)):ie,`,
    `I1({ctx:J,entries:J.canvas.__cbNat=ue?ie.filter(Re=>!ue.has(Re.itemId)):ie,`,
  );
  // The fixed canvas's names (Ee, on every scroll): not those still shown on the base canvas.
  replace(
    `const et=k1({clips:J.clips,viewportLeft:Re,viewportRight:Re+ie,mode:"sticky"});I1({ctx:ue,entries:et,`,
    `const et=__cbEdgeNames(I.current,k1({clips:J.clips,viewportLeft:Re,viewportRight:Re+ie,mode:"sticky"}),Re,ue,$.current);I1({ctx:ue,entries:et,`,
  );
  // The timeline's scroll update, callable from the wheel's frame (X, leaving a scroll event's pending frame as it was).
  replace(
    `j.current=J,D.current=U3(e.current);const ne=()=>ae.current(),`,
    `j.current=J,D.current=U3(e.current),J.__cbSync=()=>{const f=O.current;ae.current(),O.current=f};const ne=()=>ae.current(),`,
  );
  // The scroll event's update at the place the wheel's frame already drew: skipped, once. Whatever update comes next
  // uses the skip up, so it can't hold back a later one (after a resize, say).
  replace(
    `const K=o.useCallback(J=>{if(di(ve.current,J)){Ee(R.current);return}`,
    `const K=o.useCallback(J=>{const __s=j.current,__k=!!__s&&__s.__cbSkip===__s.scrollLeft;__s&&(__s.__cbSkip=null);if(di(ve.current,J)){__k||Ee(R.current);return}`,
  );
  // Cardboard's wheel frame (horizontal wheel and touchpad scrolling): the update at once when the view moved.
  replace(
    `(tt.scrollLeft+=ot,Me.current=tt.scrollLeft)`,
    `(tt.__cbWas=tt.scrollLeft,tt.scrollLeft+=ot,Me.current=tt.scrollLeft,tt.__cbSync&&tt.scrollLeft!==tt.__cbWas&&(tt.__cbSkip=null,tt.__cbSync(),tt.__cbSkip=tt.scrollLeft))`,
  );

  // 12. Starting playback waits only for audio that will be heard. After a seek, Play waits (up to 8 s,
  // "Loading audio...") until the sound of every clip in the next seconds is loaded, and that included
  // clips on muted tracks and muted, hidden or reversed clips, which the audio graph (syncAudioGraph) never
  // plays. __cbAudible keeps what syncAudioGraph keeps. A wait over half a second goes in the activity log.
  replace(
    `hasBuffersReadyForClipsAtTime(Ye.current.timelineItems,Ye.current.mediaItems,K,we)`,
    `hasBuffersReadyForClipsAtTime(__cbAudible(Ye.current),Ye.current.mediaItems,K,we)`,
  );
  replace(
    `ne.preloadAudioForClipsAtTime(Ye.current.timelineItems,Ye.current.mediaItems,ue,de)`,
    `ne.preloadAudioForClipsAtTime(__cbAudible(Ye.current),Ye.current.mediaItems,ue,de)`,
  );
  // Each load is numbered (window.__cbPreloadGen, shared with the store, see 15): only the newest one may
  // clear the loading flag and start playback when it ends. Once 15 lets Play start during a load, a
  // pause, a seek and Play again start a second load while the first still runs, and the first one's end
  // started playback before the second load's audio was in.
  replace(`we(!0);let J=!1;try{`, `const __cbG=window.__cbPreloadGen=(window.__cbPreloadGen||0)+1;we(!0);let J=!1;const __cbT=performance.now();try{`);
  replace(
    `finally{we(!1);const{pendingPlayback:ne}=U.getState();ne&&(K(!1),X(!0)),J&&wt.info("Still loading audio, playback may start silent")}`,
    `finally{if(__cbG===window.__cbPreloadGen){we(!1);const{pendingPlayback:ne}=U.getState();ne&&(K(!1),X(!0)),J&&wt.info("Still loading audio, playback may start silent");const __cbMs=performance.now()-__cbT;__cbMs>500&&window.__cbLog?.("playback.wait",{ms:Math.round(__cbMs),timedOut:J,started:ne})}}`,
  );
  replace(
    `class gH{`,
    `const __cbAudible=c=>{const m=new Map(c.tracks.map(t=>[t.id,t]));return c.timelineItems.filter(u=>{if(u.type!=="audio"&&u.type!=="video")return!0;const k=m.get(u.trackId);return!(!k||k.muted||cn(u)||u.muted||u.audioDisabled||u.playbackDirection==="reverse")})};class gH{`,
  );

  // 13. A graphic is rebuilt only when its page stops answering. gH, the preview's frame pump, started its
  // 10 s "stopped responding" timer before fetching the graphic's video frames, so a slow video decode
  // (a busy machine) rebuilt the graphic's page, which stays invisible until it draws: the preview went
  // black for as long as the new page took. The page's timer now starts when the frame is sent to it; a
  // slow fetch is waited for, and only one that hasn't answered in 30 s gets Cardboard's rebuild (see
  // below). Rebuilds and slow fetches go in the activity log.
  replace(
    `if(n&&a.rebuilds<hH){a.rebuilds++,this.options.onRebuild();return}`,
    `if(n&&a.rebuilds<hH){a.rebuilds++,window.__cbLog?.("preview.rebuild",{reason:t}),this.options.onRebuild();return}`,
  );
  // 13's part, in gH.pump: the page's timer starts at postMessage. A fetch that is only slow is waited for (and
  // logged at 10 s): its result is used when it comes. Only a fetch that hasn't answered in 30 s falls back to
  // what Cardboard did at 10 s, rebuilding the page (and after two rebuilds, its "couldn't render" note), so a
  // hung decode still ends somewhere. Cardboard 1.5.0 reworked this pump (it fetches only the videos the graphic
  // draws, at the size drawn, and drops late frames while scrubbing), but its timer still starts before the fetch.
  // A late fetch's result after a rebuild or a newer request is released as before (qc).
  replace(
    `this.requestId=r,this.timer=setTimeout(()=>this.fail("The graphic stopped responding.",!0),mH);const s=d=>{this.active&&this.requestId===r&&this.fail(d instanceof Error?d.message:String(d),!1)}`,
    `this.requestId=r;const __cbW=setTimeout(()=>{this.active&&this.requestId===r&&this.__cbSlow("frames",mH)},mH),__cbW2=setTimeout(()=>{this.active&&this.requestId===r&&this.fail("The graphic stopped responding.",!0)},3*mH);` +
      `const s=d=>{clearTimeout(__cbW),clearTimeout(__cbW2),this.active&&this.requestId===r&&this.fail(d instanceof Error?d.message:String(d),!1)}`,
  );
  replace(
    `const l=d=>{if(!this.active||this.requestId!==r){qc(d);return}`,
    `const l=d=>{clearTimeout(__cbW),clearTimeout(__cbW2);if(!this.active||this.requestId!==r){qc(d);return}`,
  );
  replace(
    `const x=h3(d);try{x.length===0?t.postMessage(b,"*"):t.postMessage(b,"*",x)}catch(v){qc(d),s(v)}};`,
    `const x=h3(d);this.timer=setTimeout(()=>this.fail("The graphic stopped responding.",!0),mH);try{x.length===0?t.postMessage(b,"*"):t.postMessage(b,"*",x)}catch(v){qc(d),s(v)}};`,
  );
  replace(
    `d?d.then(l,s):l(void 0)}catch(d){s(d)}}updateScales(t){`,
    `d?d.then(l,s):l(void 0)}catch(d){s(d)}}` +
      `__cbSlow(kind,ms){const now=Date.now();now-(this.__cbSlowAt??0)<1e4||(this.__cbSlowAt=now,window.__cbLog?.("preview.slow",{kind,ms:Math.round(ms)}))}updateScales(t){`,
  );
  // 14 (speed), dropped for 1.5.0. On 1.4.0, while playing, a graphic drew with the newest video frames already
  // fetched instead of waiting for this moment's. Cardboard 1.5.0's pump fetches only the videos the graphic drew
  // last time, and the page answers "needsFrames" with the ones it was missing; reusing held frames would answer that
  // with the same frames again, a loop, and the held set could be the wrong videos or size. Doing it safely means
  // keying held frames on 1.5.0's draw set, sizes and bitmaps, and measuring again on Windows first. So the pump is
  // Cardboard's own in both builds (ours and the baseline).

  // 18. A click on a badge in the agent's prompt box opens what it stands for (16, __cbOpen). A clip's badge
  // selects the clip, puts the playhead at its start and scrolls the timeline to it, as clicking the clip
  // there would. A media file's badge opens the file in Cardboard's own Media preview, the one its tile's
  // Preview opens in the Library: the Library's state (zY) is asked to preview that file, by its id, from
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
    `return tn(Vt.IMPORT_MEDIA,q),{media:O,filteredMedia:ae,`,
    `o.useEffect(()=>{const f=v=>{const d=v.detail;if(!d||d.seen)return;d.seen=!0;const m=O.find(x=>x.id===d.id);if(m){d.found=!0,$(m.id),z(null),P(null),j(d.top);return}const o=(H?.media??[]).find(x=>x.id===d.id);o&&(d.elsewhere=o.data?.type??"other")};addEventListener("cb:preview-media",f);return()=>removeEventListener("cb:preview-media",f)},[O,H]);` +
      `return tn(Vt.IMPORT_MEDIA,q),{media:O,filteredMedia:ae,`,
  );
  const openBadge = String.raw`
const __cbOpenClip=it=>{const st=U.getState();st.isPlaying&&st.setIsPlaying(!1);st.previewMode!=="timeline"&&st.setPreviewMode("timeline");st.selectTimelineItem(it.id);st.setPlaybackPosition(it.startTime);G1({playheadTime:it.startTime,pixelsPerSecond:st.pixelsPerSecond,behavior:"smooth"})};
addEventListener("keydown",e=>{if(e.key!=="Escape"||e.defaultPrevented||e.target instanceof HTMLElement&&(e.target.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)))return;const b=document.querySelector('[role="dialog"][aria-label="Media preview"] button[aria-label="Close preview"]');b&&!document.querySelector('[role="alertdialog"],[role="menu"],[role="dialog"]:not([aria-label="Media preview"])')&&(e.preventDefault(),e.stopImmediatePropagation(),b.click())},!0);
addEventListener("cb:open-badge",e=>{const{kind:k,id:i,label:l}=e.detail??{},st=U.getState();
if(k==="media"){
// d.seen: the Library answered; d.found: it opened the file's preview; d.elsewhere: the file is in the project
// but not in the Library's list. The preview is placed beside the left panel, near its top.
const ask=()=>{const p=document.querySelector("[data-editor-left-panel]")?.getBoundingClientRect(),d={id:i,top:(p?.top??0)+64};dispatchEvent(new CustomEvent("cb:preview-media",{detail:d}));return d};
st.isLeftPanelCollapsed&&st.setLeftPanelCollapsed(!1);
let n=0;const go=()=>{const d=ask();if(d.found)return;
if(d.elsewhere){const c=U.getState().timelineItems.find(x=>x.mediaItemId===i);c?__cbOpenClip(c):d.elsewhere==="audio"?(U.getState().setActiveLeftTab("music"),wt.info(l+" is in Audio, with the music and sound effects.")):wt.info(l+" isn't in the Library anymore.");return}
if(d.seen){wt.info(l+" isn't in the Library anymore.");return}
// No Library mounted: show it by the panel's state, then ask again.
n++===0&&U.getState().setActiveLeftTab("media");n<90?requestAnimationFrame(go):wt.info("Couldn't open the Library to preview "+l+".")};
requestAnimationFrame(go);return}
if(k!=="item")return;
const it=st.timelineItems.find(x=>x.id===i);
it?__cbOpenClip(it):wt.info("That clip isn't on the timeline anymore.")});
`;
  replace(`class gH{`, openBadge + `class gH{`);

  // 19. The editor's left rail (Library, Layout, Audio, Captions, Text, Transitions, Effects) shows its
  // tooltips. Each icon is wrapped in Cardboard's tooltip, but the button inside (Z_) kept only its own props
  // and dropped the ones the tooltip's trigger hands it (its pointer and focus handlers, its ref, data-state),
  // so no tooltip ever opened: the rail was icons with no names. The button now takes them; its click runs
  // the trigger's (which closes the tooltip) and then switches the panel, as before.
  replace(
    `Z_=({tab:e,tile:t,className:n,label:a})=>{const r=e.icon;return c.jsxs("button",{"aria-label":a===void 0?e.label:void 0,className:W("group flex w-full cursor-pointer flex-col items-center gap-1 px-1",n),onClick:e.select,`,
    `Z_=({tab:e,tile:t,className:n,label:a,...__cbTip})=>{const r=e.icon;return c.jsxs("button",{...__cbTip,"aria-label":a===void 0?e.label:void 0,className:W("group flex w-full cursor-pointer flex-col items-center gap-1 px-1",n),onClick:v=>{__cbTip.onClick?.(v),e.select()},`,
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
      `function TF(e,t,n=.5){`,
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
        `function TF(e,t,n=.5){`,
    );
    replace(
      `let r=null;const s=()=>{a(),r=window.requestAnimationFrame(s)};r=window.requestAnimationFrame(s);const i=new ResizeObserver(a);`,
      `const __cbRest=__cbRectWatch(e,a);let r=null;const i=new ResizeObserver(a);`,
    );
    replace(`n.stop=()=>{r!==null&&window.cancelAnimationFrame(r),r=null,i.disconnect(),`, `n.stop=()=>{__cbRest(),r!==null&&window.cancelAnimationFrame(r),r=null,i.disconnect(),`);
  }

  // 21. What is drawn over the preview is drawn at the preview's own scale, also in full screen. The preview's
  // zoom (Ctrl+wheel or a pinch over it, undone by its "Reset" button) is a CSS scale on a wrapper around the
  // stage, and the tracker (h8) took that zoom from the store as the scale its overlays are drawn at: a graphic's
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
    `const Hc=new WeakMap,h8=(e,t)=>{`,
    `const __cbDrawnScale=(e,r)=>{const w=parseFloat(getComputedStyle(e).width);return w>0&&r.width>0?r.width/w:U.getState().canvasTransform.scale};const Hc=new WeakMap,h8=(e,t)=>{`,
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
