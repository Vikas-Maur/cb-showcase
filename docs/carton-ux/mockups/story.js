// The History story the mockups share (Main cut, today), as HTML builders. Clock times always carry am/pm (a bare
// "12:20" reads as a timecode beside 0:06); versions are named by their name, an agent's prompt, or "your edit at …".
const agentTitle = (s) => `<span class="q">“${s}”</span>`;
const mark = (html, style = "") => `<span class="av sys" style="${style}">${html}</span>`;
const named = mark(I("bookmarkF", 11), "color:#f3cf58;box-shadow:inset 0 0 0 1px #fbbd2340");
// Today's story on Main cut, newest first.
const turnRow = (extra = {}) => row({ w: "claude", title: agentTitle("Tighten the intro and add a lower third"), meta: `Claude Code<span class="dot"></span>4 changes`, when: "Now", whenCls: "now", ...extra });
const mineRow = (extra = {}) => row({ w: "you", title: "Moved “Interview B” 2 s later", meta: `You<span class="dot"></span>6 changes${I("caretR", 10)}`, when: "12:41 pm", ...extra });
const dirRow = (extra = {}) => row({ w: "director", title: agentTitle("Add captions to the interview"), meta: `Director<span class="dot"></span>12 changes`, when: "12:20 pm", ...extra });
const viewingWhen = `${I("eye", 12)}Viewing<button class="btn icon" style="width:18px;height:18px;margin-left:2px;color:var(--view)" title="Back to my edit (Esc)">${I("x", 11)}</button>`;
const today = (opts = {}) => [
  opts.top ?? turnRow(opts.turn),
  opts.after ?? "",
  mineRow(opts.mine ?? {}),
  opts.mineAfter ?? "",
  dirRow(opts.dir ?? {}),
  opts.dirAfter ?? "",
  row({ w: "you", icon: named, title: `<b style="font-weight:600">Sent to client</b>`, meta: `Named by You<span class="dot"></span>1 change`, when: "12:05 pm" }),
  row({ w: "you", icon: mark(I("foldIn", 12)), title: "Folded in “30s cut”", meta: `You<span class="dot"></span>2 of 3 changes`, when: "11:52 am" }),
  row({ w: "you", icon: mark(I("restore", 12)), title: "Restored the 11:02 am version", meta: `You<span class="dot"></span>5 changes`, when: "11:40 am" }),
  row({ w: "codex", title: "Trimmed “Product close-up”, now ends at 0:16", meta: `Codex<span class="dot"></span>1 change`, when: "11:31 am" }),
].join("");
const older = day("Yesterday", "23 versions · 2 named", true) + day("Sat, Oct 31", "41 versions", true);
const since = (n) => `<div class="since">${I("layers", 12)}<span>Your edit has <b>${n} changes</b> since this</span><span class="link">See them</span></div>`;

// The newest version's card (Claude Code's turn): Play all runs on your edit, nothing is viewed.
const detail = () => `
  <div class="detail">
    ${map([[5, "chg", 1], [13, "chg"], [31, "add"], [55, "rem"]], null, null)}
    ${chg("0:02", "v", "chg", "Trimmed “Intro”, now ends at 0:05", "", "hov")}
    ${chg("0:05", "t", "chg", "Moved “Summer launch” 1 s earlier")}
    ${chg("0:12", "t", "add", "Added lower third “Jane Smith, Founder”")}
    ${chg("0:22", "v", "rem", "Removed “B-roll 3”")}
    <div class="acts">
      <button class="btn sm sec">${I("play", 12)}Play all</button>
      <button class="btn sm ghost" title="Takes out only these 4 changes. Later changes stay.">${I("undo", 14)}Undo this turn</button>
      <span class="sp"></span>
      <button class="btn icon">${I("dots", 16)}</button>
    </div>
  </div>`;

// An older version's card (Director's turn): first, how far your edit has moved on since it. Playing: its row lit, Before.
const olderCard = (playing = false, before = false) => `
  <div class="detail">
    ${since(7)}
    ${map([[14, "chg", playing], [62, "chg"], [70, "chg"]], playing ? 15.5 : null)}
    ${chg("0:06", "v", "chg", "Moved “Interview B” 2 s later", "", playing ? "on" : "hov", playing ? 40 : null)}
    ${chg("0:25", "c", "chg", "Changed caption to “we cut editing time”")}
    ${chg("0:28", "c", "chg", "Changed caption to “in half”")}
    <div class="chg more-row"><span></span><span></span><span class="w">and 9 more</span></div>
    <div class="acts">
      ${playing ? `<button class="btn sm sec">${I("pause", 12)}Pause</button><button class="toggle${before ? " on" : ""}" title="Hold to see how it was before (or press B)">Before</button>` : `<button class="btn sm sec">${I("play", 12)}Play all</button><button class="btn sm ghost">${I("restore", 14)}Restore…</button>`}
      <span class="sp"></span>
      <button class="btn icon">${I("dots", 16)}</button>
    </div>
  </div>`;
const olderDetail = olderCard();

const restoreConfirm = `
  <div class="detail">
    ${chg("0:06", "v", "chg", "Moved “Interview B” 2 s later")}
    <div class="chg more-row"><span></span><span></span><span class="w">and 5 more</span></div>
    <div class="confirm">
      <h4>Restore your edit from 12:41 pm?</h4>
      <p>Your edit goes back to how it was then. The 4 changes made since are undone. They stay in History, and Ctrl+Z brings them back.</p>
      <div style="display:flex;gap:6px;align-items:center"><button class="btn sm pri">${I("restore", 14)}Restore</button><button class="btn sm ghost">Cancel</button><span style="flex:1"></span><a class="link" style="font-size:12px">See the 4</a></div>
    </div>
  </div>`;

const newCut = `
  <div class="detail">
    <div class="field"><label>New cut from this version</label><div class="input focus">30s Instagram cut<span class="caret"></span></div></div>
    <p class="hint" style="margin-top:6px">You'll switch to it. Main cut stays as it is.</p>
    <div class="acts"><button class="btn sm pri">Make cut</button><button class="btn sm ghost">Cancel</button></div>
  </div>`;

const menu = `
  <div class="menu" style="position:absolute;right:14px;top:162px;width:250px">
    <div class="mi hov">${I("play")}Play its changes</div>
    <div class="mi">${I("layers")}Compare with your edit</div>
    <div class="msep"></div>
    <div class="mi">${I("bookmark")}Name this version</div>
    <div class="mi">${I("cut")}New cut from this version…</div>
    <div class="msep"></div>
    <div class="mi">${I("restore")}<span>Restore…<span class="sub">Go back to this version. Later changes stay in History.</span></span></div>
  </div>`;

const working = row({ w: "director", icon: av("director", false, "live"), title: agentTitle("Add music under the interview"), meta: `<span class="pill live">Working</span>Director<span class="dot"></span>2 changes so far`, when: "Now", whenCls: "now", cls: "" }) +
  `<div class="hint" style="margin:-2px 14px 8px 46px;font-size:12px;line-height:16px">Keep editing. Director sees your changes when its turn ends.</div>`;

const empty = `
  <div style="padding:28px 22px;display:flex;flex-direction:column;gap:10px;align-items:flex-start">
    <span class="av sys" style="width:32px;height:32px">${I("versions", 16)}</span>
    <p style="margin:0;color:var(--fg1);font-weight:600;font-size:14px">Your edit's history starts here</p>
    <p style="margin:0;color:var(--fg3);font-size:12.5px;line-height:18px">Every change, yours or an agent's, is saved as a version. Look back at any of them, play what changed, or restore one. Nothing is lost.</p>
    <p style="margin:6px 0 0;color:var(--fg4);font-size:12px">Main cut · started today at 9:12 am</p>
  </div>`;

const many = `
  ${day("Today", "")}
  ${row({ w: "you", title: "Changed caption to “built for speed”", meta: `You<span class="dot"></span>9 changes${I("caretR", 10)}`, when: "10:14 am" })}
  ${row({ w: "claude", title: agentTitle("Make every caption two lines at most"), meta: `Claude Code<span class="dot"></span>38 changes`, when: "10:02 am" })}
  ${row({ w: "you", title: "Trimmed “Interview A”, now ends at 0:11", meta: `You<span class="dot"></span>14 changes${I("caretR", 10)}`, when: "9:47 am" })}
  ${day("Yesterday", "118 versions · 3 named", true)}
  ${day("Sat, Oct 31", "204 versions", true)}
  ${day("Fri, Oct 30", "96 versions · 1 named", true)}
  ${day("Thu, Oct 29", "12 versions", true)}
  <div style="position:absolute;left:0;right:0;bottom:12px;display:flex;justify-content:center"><button class="btn xs" style="background:#2a2a2a;box-shadow:var(--near);color:var(--fg1);height:26px;padding:0 10px">${I("arrowUp", 12)}Newest</button></div>`;
