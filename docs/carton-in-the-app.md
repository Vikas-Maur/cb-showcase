# Carton: version history for a project (on by default; `CARDBOARD_CARTON=0` turns it off)

[README](../README.md) · [Windows port](windows-port.md) · [Carton in the app](carton-in-the-app.md) · [Benchmarks](benchmarks.md)

Carton in the Windows build of Cardboard: what changes with it on, sharing, and how it's tested. These
sections were the README until 2026-11-10. Carton itself (the module) is in [carton/](../carton/README.md).

Carton gives a Cardboard project permanent history with authors, cuts (variants) you can fold into each other, undo
by actor, and, later, live collaboration. Its code is in `carton\`; how it hooks into Cardboard is in
`carton\docs\INTEGRATION-1.5.0.md`. The build includes it, and it is **on** by default: the cut you're on, History and
Share are in the title bar and every `cb` goes through it, with no setup. To turn it off, start Cardboard with `CARDBOARD_CARTON=0`
(`false`, `off` and `no` work too; for every start, `setx CARDBOARD_CARTON 0` and restart Cardboard). With it off,
every hook below runs Cardboard's own code, and the app and `cb` read the same variable, so they always agree.
`build-windows.js --no-carton` leaves Carton out of the build altogether.

What changes with it on:
- **No lost edits.** The app and every `cb` agent used to read `project.json`, change it, and rename a new one over it.
  Two of them at once could lose one's edit, even on different clips (seen with 1.4.0's own `cb` here). A GUI save
  wrote the whole timeline and could revert an agent's clip. Now each change is committed to `.carton\carton.db`
  against the exact version it was made on. A stale one is merged in, and a clash becomes a conflict card. Nothing is
  overwritten. Two quick edits of yours never clash with each other: a save sent before the previous one's answer came
  back builds on that save, and a save that landed past an agent's change on another clip brings that change into the
  editor (it used to stay out of the editor, and your next save undid it).
- **History** keeps every version, not the last 20, with who made it, down to the Director's turn and subagent.
  `cb history` shows who made each version, and each turn of an agent in the app (the Director, your own Claude Code,
  Codex, the others) is named from what you typed ("Make the intro tighter"), then from a short title of what it did
  (below); its hold on `timeline.tsx` ends with the
  turn (an agent without Claude Code's hooks, such as Codex, holds it until a minute after its last `cb` call). Your
  own Claude Code's edits are credited to "Claude Code" (they used to read "Director (chat …)", and its turns went
  unnamed). `cb undo <rev>` reaches any version, and `cb undo --turn <id>` undoes one agent turn.
- **History's words and Play, from the laptop (2026-11-05).**
  - **A turn is titled with what you typed.** After a message that never reached an agent (a stopped or failed turn),
    a switch of agent or a fresh agent session, Cardboard sends the agent your message behind a preamble and the earlier
    conversation ("[Earlier messages in this conversation did not reach an agent…"). History used to title the turn
    with that preamble. Now the Working row and the version take your own message. Versions already named that way show
    in their default words ("Claude Code · 1 change") in History, `cb history`, Find, landmarks and Undo's words. The
    stored name stays, so one turn's run of versions still ends where it did.
  - **Then a short title of what was done.** Once a turn that changed the edit ends, its version is titled in a few
    words ("Split audio for J/L cuts"). Cardboard names its chats the same way: one call to your own signed-in Claude
    Code (else Codex), with the cheap model, no tools, no hooks and no session kept. The call is built from your request
    and the turn's changes as History words them, so the title says what actually changed. Nothing waits for it. Until
    it comes, and whenever it doesn't (offline, not signed in, a failure, no answer in 12 s, an answer that isn't a
    title), your words stay. A version you renamed meanwhile keeps your name, and a turn that changed nothing isn't
    titled. The open card shows what you asked in one quiet line ("You asked: “…”", whole on hover), and Find still
    finds the turn by your words. Titles are kept on this computer; they reach a teammate with the cut when you share
    it, as other names do. Neither your message nor the title is logged.
  - **Program code is never quoted.** A change to a code graphic's code read "Changed the code of “Cardboard on
    Windows” to “export default function Graphic({ tim…”". It now reads "Changed the code of code graphic “Cardboard on
    Windows” (3 lines)": what holds the code, and how many lines changed (counted in one pass, from the first changed
    line to the last). The same goes for a shader's code and a code graphic's code kept on its clip, in History, its
    cards, Compare, the Fold dialog and `cb history`.
  - **A change to a clip's own part plays where the clip is.** A code graphic's code and a title's text entry are
    their clip's own media entries, which had no place in the edit: the row's time read "—" and Play all lit it for a
    moment and did nothing. Such a change now takes its clip's place (the earliest, if several clips share it), so its
    row shows the time, ▶ plays it and Play all plays it with the rest. When nothing in a version has a place (an
    aspect ratio or frame rate change alone), Play all is off and its tooltip says "Nothing to play: these changes
    aren't on the timeline", and those rows have no ▶.
  - **Play plays with sound.** History's Play used to move Cardboard's playhead up to 10 times a second from a clock of
    its own, so nothing was heard and the picture stepped. Play, ▶ and Play all now play each stretch through
    Cardboard's own playback, as Space does, with the sound and at full frame rate, and follow its clock. There is no
    seek per frame. Between stretches Play stops, jumps and plays on (back-to-back stretches play straight through),
    and at the end it stops. Like Space, it waits for the sound where it starts to load, and it never asks again while
    it loads (a second Play forces playback before the sound is in; that stays yours to press). Pause and Space still
    pause and go on. Pausing in the editor itself pauses Play too, but Cardboard's own stop at the end of the timeline
    doesn't count as a pause. Pause, Esc, a row's ✕ and closing the card or the panel stop what Play started, a start
    still waiting for its sound included, so nothing starts playing afterwards. Holding Before on an older version
    that ends sooner waits at its end, and the rest plays once you let go. Play only ever stops playback it started: if
    the editor is already playing when you press Play, Play replaces it with its own (as pressing Play anywhere would),
    and playback you start yourself afterwards is never stopped by Play. A viewed version plays its
    own timeline, so clips only it has (an agent's detached "1.mp4 audio") play from the project's media. A media file
    deleted from the project since is neither seen nor heard in a viewed version, as before: the editor takes media
    from the project as it is now.
  - **A group's Play keeps its Pause (laptop check, 2026-11-06).** An edit of yours that joined the group whose Play
    all was playing (or still loading its sound) put the card back on "Play all" with no row lit, while the play went
    on with no control: Cardboard played to the end, and a start still loading began once its sound came in. The play
    now belongs to its card. It carries on over the changes it started with, with its Pause and its lit row; Pause and
    Space stop it, and Play all after a pause goes on from there. Once it ends, Play all plays the new change too. That
    holds only while edits are added to the group. When a version leaves it (naming a version in the middle splits
    the group, and the card keeps the older part) or its start changes, the play ends: Cardboard stops, a start still
    waiting for its sound is called off, and Play all plays what the card shows now. A paused play is let go the same
    way. (The build the laptop checked also kept a paused play's Before on a card it no longer matched, and let a play
    run on with no control when the group's newest version was named.) A single version that an edit turns into a
    group gets the group's card, and its play ends as before. An undo is a version of its own, never in a group, so the
    group keeps its versions and its play goes on.
  - **Play all's "Nothing to play" tooltip reads clearly.** A button that is off is drawn faded, and its tooltip was
    faded with it, so the next row's words showed through it. A button that is off and has a tooltip is now faded by
    its icon, words and background, and its tooltip is drawn solid.
- **Finding a version, and bringing back one clip** (Carton UX v2). Every change is a version, so a long history
  needs finding, by you or your agent:
  - `cb history <project> --find <words>` finds versions by a clip's name (before or after the change), title and
    caption text they set, an agent's request, a version's name, a person or a day. Every word matches the start of
    a word, in any order ("intr cap" finds "Add captions to the intro").
  - `cb history <project> --landmarks` lists the versions people remember: exported, sent (a link made), named,
    agent turns, how it was when you opened the project, and just before a restore. Start and Before are yours only.
  - `cb restore <project> <version> --clip <name>` brings back one clip as it was, and nothing else changes (Ctrl+Z
    takes it back). A clip deleted since comes back; one that wasn't there then is taken out only with `--remove`, and
    its version says so in History and in `cb history` alike: "Took out 'Psst…'" (`cb history` read "Brought back
    'Psst…' from an earlier version" for it), and so does `cb restore` itself on a shared cut, where it answered
    "Brought back “Psst…” as it was in …" (the lease holder's answer, after the sharing server's, lost what the write
    had said of itself).
    It never lands on top of another clip: if its place is taken now it goes on a new track just above, at the same
    time. A clip deleted with a ripple comes back with the rest of its track moved back; one added with a ripple,
    taken out, moves the rest earlier. The History panel's confirmation is refused if the clip changed again meanwhile.
  - `cb compare <project> <left> [right] --show` opens the comparison in your editor, also between two cuts.
  - In place of a version you can write `sent`, `exported`, `today`, `now`, a version's name or a cut's name.
  - The agents' instructions say when to use these ("go back to the version I sent the client", "bring back the old
    intro", "show me what changed"). The History panel gets the same through its view model (`find`, `landmarks`,
    `restoreClip`, the Bring back choices, `align`).
  - The search index is built the first time you search, then kept and extended; nothing is added to saving or opening.
    Exported and Sent landmarks stay on this computer until the sync server carries them.
- **The History panel** (Ctrl+Shift+H) reads as a list of what happened, by day: each row says who (an agent's own
  mark), what (an agent's prompt in quotes, a version's name, or the change itself: "Moved “Interview B” 2 s later")
  and when (always with am/pm; the newest says **Now**). Your run of edits is one row ("You · 6 changes ›"), an agent
  at work shows as a live row ("Keep editing. Director sees your changes when its turn ends."), and the cut's start is
  one row at the bottom. A click opens the version's card under it: how far your edit has moved on since ("Your edit has
  7 changes since this · See them"), where each change is in the edit (0:12) and on what kind of clip, Play all, and
  **Go back…** (on the newest agent turn, Undo this turn). Go back… shows the four ways back side by side, smallest
  first, each saying what it will do before anything happens: **Bring back one clip** (pick a clip that changed, was
  deleted or wasn't there yet; only it goes back, "Brought back “B-roll pier” as it was at 10:20 am." [Undo]), **Undo
  Director's turn** (an agent's turn only), **Restore the whole edit**, and **Start a new cut from here**. With a clip
  selected on the timeline, Bring back is picked for it. A click never changes what the editor shows; only Play does,
  and the row then says "Viewing ✕"; **press and hold** a row (or hold V) to peek at it on the stage, and let go to
  come back. The versions people remember are marked on their own, as **landmarks**: Exported, Sent, Named, an agent's
  turn, the day's Start, and Before (kept just before a restore, only for you), with a small picture of the version,
  and a folded day keeps them in view. **Find a clip, a word, a person…** above the list finds versions by clip names,
  title and caption text, agents' requests, names and people, newest first, each saying why it matched. **⇆ Compare**
  answers "what changed since the version I sent / the last export / this morning / in another cut", and a row's ⋯ →
  **Compare with…** picks any second version (or another cut) to compare with. A filter (the icon by the cut) shows
  landmarks, named versions, agent turns, your changes, or only the versions that touched the clip selected on the
  timeline, with that clip's credits.
- **A teammate's change stands out as it arrives.** On a shared project, when a teammate's change (or their agent's)
  comes in while History is open, its row fades in with a ring in that person's colour, the colour of their avatar,
  and a soft glow; after a few seconds it settles into a faint edge of that colour, which stays while History is open.
  So with your own Claude Code adding rows as it works, "Leo's Claude Code · Added title “Summer launch”" reads at a
  glance as someone else. Your own changes and your agents' never get it, nor what was there when you opened History,
  nor a cut you switch to. When a teammate's edit joins their row of edits, or their agent's turn goes on, that row
  glows again for it. Changes arriving in a burst (a teammate's agent at work) get the ring without the fade, so a busy
  project costs no frames. With Windows' animation effects off (reduced motion), the ring and then the edge show
  without fading. A screen reader hears "Leo made a change", and nothing more from that person until they have been quiet for a
  minute. A teammate's change that arrived live also reads by name now: History used to say "Teammate" for their edits
  and "Claude Code" for their Claude Code, the same as yours, until History was loaded again; it now says "Leo" and
  "Leo's Claude Code", in Leo's colour, from the moment the row appears, with no flash of another name first, also
  when two people's Cardboards share one computer.
- **Undo (Ctrl+Z)** undoes your edits and the agent turns you started, never someone else's change. A change from
  an agent or a teammate arrives in the editor without an undo step and without dropping your unsaved edit. Undo and
  redo step back and forward in the order you made the edits, as Cardboard's own do: split a clip, drag a piece, and
  Ctrl+Z twice gives the one clip back; Ctrl+Shift+Z gives the split back, and Ctrl+Y the drag. (Carton used to record
  the drag's undo as if it closed a gap on the track, so the split's undo then clashed with it and did nothing.) With
  live sync, that undo also leaves alone a clip a teammate or an agent put later on the same track meanwhile, whether
  the undo was made offline or the other edit was: Carton used to slide that clip back by the length of the drag,
  on every machine, without a card. An undo that does clash with a later change, such as a terminal agent's `cb` edit
  of one of the pieces, changes nothing and says why in a conflict card.
- **One action is one version, and one undo.** Deleting a title (or a code graphic) also removes its own media entry
  ("Text: W6"), which Cardboard saves on its own, a moment before or after the timeline. Carton made two versions of
  it ("Deleted title 'W6'", then "Deleted media 'Text: W6'"), and one Ctrl+Z took back only one of them: the title
  stayed gone, or came back without its entry. Adding a title did the same. Now the title and its entry are saved
  together, as one version that reads "Deleted title 'W6'", and one Ctrl+Z, Ctrl+Shift+Z or `cb undo` takes back the
  whole action, as Cardboard's own undo does, on a shared project too. Versions saved before this stay as they are.
- **A timeline printed from a version that's gone** is refused ("print it again") where 1.4.0 silently merged
  against the current timeline and reverted newer edits. An edit of an older print merges against the version it was
  printed from, whether its header is Cardboard's number or Carton's version.
- **The cut you're on, in the title bar**: on every project tab, before Cardboard's own "16:9 ⌄", a chip names the cut
  the editor shows: "✂ Main cut ⌄", or a colour dot and the name for any other cut ("● 30s Instagram cut ⌄"; a long
  name is cut off at 220 px, 150 px in a window under 1180 px wide, and shown whole in its tooltip). It follows every
  switch, the cuts menu's or a `cb cut switch` from a terminal, as soon as the editor hears of it. A click drops the
  cuts menu down under the chip, History staying closed: every cut with who changed it last and when (a click switches;
  while an agent works on your cut, the cut opens in place with "Switch when it finishes" and "Switch now"), New cut
  from your edit, Fold in changes from a cut…, Rename, Open History, and "Agents work on the cut you're on." The chip
  shows it open. The title bar is a page of its own above the editor's, so the chip sends where it is with its click
  and the editor's page draws the menu under the title bar at the chip's left edge (at any window width or zoom, kept
  inside the window). The keyboard is in it at once (arrows, Enter, Esc). Esc, a click anywhere else (the title bar
  included) or the chip again closes it, and focus goes back to the editor. While the editor shows something other than your
  own edit (an earlier version opened, a teammate's cut), the chip grows a second part saying what ("👁 The version
  from 2:14 PM (Codex) ✕"), and its ✕ brings your edit back. In a narrow window the chip is what gives way, never the
  window's own buttons: the editor controls beside the tabs may shrink now (they kept their full width and could push
  the minimise, maximise and close buttons out at 960 px), the chip's name and label shorten first, and under 1000 px
  while viewing the cut shows as its dot or scissors alone, its name in the tooltip, and while comparing the second part
  says "⇆ Comparing ✕". With Carton off there is no chip, and nothing else in that row shrinks. The project tabs keep
  room for one tab whole (its ✕) and the New project "+" after it, so the chip gives way before they do; with more tabs
  than fit, the tab list scrolls with "+" at its end (Cardboard let the tabs run on under "+", whose click then started
  a new project where you meant to close a tab: it did at 960 px while comparing). "+" is the 28 px button its class
  asks for; Cardboard's stylesheet made it as wide as the tab list, so a click anywhere after the tabs made a project.
- **History and Share** icons in the title bar, beside "Report an issue", on a project tab. History opens a
  full-height panel beside the agent's chat, in the chat's look (drag its edge to resize), with two tabs, History and
  Comments; the same icon closes it, and shows as pressed while it is open. Share opens a dialog (below). Ctrl+Shift+H opens and closes History from the keyboard (H is free in Cardboard's
  keymap). The preview, the timeline, Ctrl+Z and the chat keep working while it is open.
  History: versions, compare with current and play the changes, restore, cuts, fold in (from the cut's own menu
  too: "Fold “X” in here"). Every change reads as one sentence in the editor's words, the same in History, Compare and
  the Fold dialog: verb first, the clip by its name, positions as the timeline shows them ("Trimmed “Intro”, now ends at
  0:05", "Moved “W6” 2 s later (now starts at 0:09)", "Restored the 12:41 pm version", "Folded in “30s cut”"), and
  times of day always with am/pm. A click, Enter or a double-click on a row opens its card and never changes the
  preview. Only a deliberate step shows something other than your edit ("viewing"): Play on a version that isn't the
  newest, a conflict side's See it, a comment's "See it as it was", a teammate's cut. There is no banner over the
  picture: three quiet marks say it, with one label ("Director's “Add captions…”"): the title bar's chip, a thin blue
  frame round the preview and the timeline (the timeline's clips muted), and the row in History ("👁 Viewing ✕"). When
  History's list isn't on screen to show the row (the panel closed, Comments, a conflict's side), the frame carries the
  label itself in a small tab on its top-left corner, with ✕. The marks follow what the preview actually shows: a
  version Play or Before puts on the preview at once is framed at once (its label follows a moment later), and your
  edit asked for is unframed at once. Esc, any of those ✕, closing the panel or switching its
  tab brings your edit back (a conflict side stays until its card or Esc leaves it). Undo and Redo look unavailable
  meanwhile; an Esc the editor uses first, such as deselecting a clip or skipping an agent's question, stays the
  editor's, whichever was selected first, and with focus in the History panel the first Esc returns to your edit and
  the next closes the panel. Play and See it never select a clip, so the first Esc is always viewing's. An edit tried
  while viewing (a drag, a trim, Delete, Ctrl+Z, Enter or a double-click on a title) changes nothing: the frame pulses
  once and one line says "You're looking at Director's “Add captions…”. [Back to my edit] Esc", in place of
  Cardboard's own refusal note, from the same guard, so every edit Cardboard refuses there is still refused (the
  stage's text editor doesn't open there either, and a selected title or caption shows no text toolbar: nothing in it
  looks editable); with Carton off Cardboard's own note is unchanged. Export opened while viewing (Ctrl+E, the title
  bar's Export, or an agent's export) goes back to your edit first ("Back to your edit to export it.") and exports
  that, never what you were looking at. On a cut other than Main, the timeline's toolbar shows the cut's name and colour
  dot beside the zoom. The keys the History list uses (arrows, Enter) stay the list's. A version shorter than the
  playhead shows from its end, and the playhead goes back where it was on return, unless you moved it. Playing the
  changes moves the preview's playhead with it, so the frames are the real ones. Viewing and the return are each
  announced once to a screen reader.
  **Compare** takes over the editor to show two versions, or two cuts, at once. Every way into it opens it: a card's
  See them, a row's Compare with your edit, Shift+click on a second row, another cut's Compare in the cuts menu, or an
  agent asked in the chat (`cb compare … --show`).
  - **The stage** has three modes:
    - Side by side: the other version in a second player on the left, Cardboard's own preview on the right;
    - Wipe: one picture with a line you drag, or move with ← →;
    - Flip: hold B, or press the pill, to see the other side.
    Play both plays them in step by shot: the two sides' clips are matched by identity, so a trimmed or moved clip is
    still the same shot (the shorter side waits), a clip only one side has gets a slate on the other, and one moved past
    others says where it is ("“Drone shot” is later in your edit now"). Which side Flip shows is said under the
    picture, never over it. Side by side needs a stage 682 px wide, and the Library steps aside for it.
    Narrower than that, Compare shows Flip with Side by side greyed. If closing History would make the room (a laptop
    with History and the chat open), a click on Side by side closes History and shows it; otherwise its tooltip says
    what to close (History, the chat, the Library) or to widen the window. Without a second player it shows only Flip.
    If the second player doesn't start within 2 s, Compare shows Flip and says so once; Side by side and Wipe stay
    greyed, and picking one tries again. The 2 s count only while the window is on screen and the other side shows a
    picture, so a minimised window, or a comparison with the start of History (a slate on the left), doesn't fall back
    to Flip. Under 360 px Compare is Flip only, but Side by side is still offered when closing History alone makes the
    room. Play both run to its end plays again from 0:00 with one click.
  - **The timeline** shows your edit with marks on its clips: green for added, a red dashed ghost where a removed clip
    left a gap (a seam where the rest moved up), amber with "←4 s" for moved, and amber for trimmed or changed. Above the
    tracks is a strip of the other version on its own time, its clips in the same colours (a gap left plain).
  - **History** becomes the list of changes ("differences" between two cuts). A click jumps both players and the
    timeline there, and ▶ or Enter plays that spot on both sides. Its footer offers Restore your edit to it… (asked
    first) or, between cuts, Fold in changes from it….
  - **The title bar's chip** says "⇆ Comparing “Sent to client” with your edit now ✕"; each side has one name
    everywhere in Compare. Esc, its ✕, Done comparing and ← History all go back to your edit, where the playhead stays
    at the change. Esc does so even with a clip selected (clicking one while comparing selects it), and deselects it;
    the keyboard is then in History, so the next Esc closes it.
  - **History can close while comparing**, for a bigger picture: its icon, Ctrl+Shift+H or the panel's ✕ keep Compare
    on and give the stage the room. The frame then shows its own label, "⇆ Comparing “Sent to client” with your edit now
    · 7 changes ✕": a click on its words opens History on the list again, and its ✕ ends Compare. The marks, Play both
    and Flip work as before. History that an agent opened for its comparison closes again when Compare ends, unless you
    closed it yourself.
  - **Nothing can be edited while comparing.** An edit tried gives one line, "You're comparing … [Done comparing] Esc",
    and Export goes back to your edit first.
  - **An agent's request** opens Compare only when you're idle. Mid-edit it waits up to 8 s; while you're viewing,
    playing or in a dialog it offers a note with Open instead. Either way it tells `cb` which it did. A `cb compare
    --show` you type in a terminal is yours ("You opened a comparison."). `cb` says "No editor window has this project
    open" only when no app has it; an app busy for a moment is asked again for up to 4 s (one ask in three said no
    window on the laptop).
  - **The second player** is Cardboard's own preview engine on a canvas of its own, muted. It exists only while Side
    by side or Wipe shows: Flip and closing Compare free it, and paused it draws nothing between seeks.
  Restore ("Restored your edit from 12:41 pm. Later changes are in History."), Fold in ("Folded 3 changes from “30s
  cut” into Main cut.", the count the Fold dialog's button gave), Fold in the rest, a conflict card's pick, Undo this
  turn ("Took out Claude Code's “Tighten the intro…” (4 changes).") and a new cut ("You're on “30s Instagram cut”,
  made from Director's “Add captions…”. Main cut is unchanged.") each end with a short confirmation over the preview,
  and so does switching cuts ("You're on “30s Instagram cut” now."). Each offers the next step: **Undo** (with Fold
  in, also the cut it went into when you're not on it; with a cut, Switch back). Undo takes back exactly what that
  action made, the same way Ctrl+Z does (the whole fold, both parts of a fold that brought in an earlier fold's rest),
  then offers Redo ("Restore undone." [Redo]); if anything landed on top meanwhile it changes nothing and says so. A
  pick of the side already in the timeline changes nothing, so it has no Undo. Ctrl+Z of a restore or a fold says so
  too ("Fold undone." [Redo]). A confirmation stays while the pointer is on it or the keyboard is in it, else 6 s. A History that spans days is grouped by day ("Today", "Yesterday", "Sat, Oct 31"),
  each with its count; a day folds to its named versions with a click or Enter, and with more than 150 versions every
  day but today starts folded. The reader keeps their place as versions arrive. In a narrow window the panel never takes the preview's room: it narrows (down to
  300 px) so the preview keeps at least 320 px, and when even that won't fit it floats over the chat as a drawer, as
  wide as the chat column (a chat narrower than 300 px: 300 px, ending above the timeline, so the timeline and its
  toolbar stay clear). Wherever the timeline's toolbar runs on under the drawer (at 960 px with the chat open it reaches
  under the chat column), the drawer ends above it too, so it never covers Fullscreen or Hide timeline.
  Every layer takes the keyboard: focus moves into a menu, card or dialog as it opens
  and back where it came from as it closes, and Esc closes the innermost one only.
  Comments: notes pinned at the playhead, with replies; a timecode moves the playhead there. The box says where a note
  goes before you write it ("Add a note at 0:13…", "At the playhead · 0:13"), following the playhead until you start;
  times read as the editor's (0:06), a note on the whole video "Whole video". A note whose moment changed since says
  so ("That moment changed since.") with **See it as it was**, which shows the version it was written on, as History's
  Play does (Esc or ✕ comes back). Open, Resolved and All show once a note is resolved. The comment box grows
  with its text up to about eight lines, then scrolls, and has no resize grip.
- **Conflict cards** sit in the preview's bottom-right corner, one at a time: your own edits that clashed, and an
  agent's view edit that clashed with yours (see "An agent's edit and yours at once" below). A card says in words what
  each side did to which clip: "“Interview B”: you and Claude Code both moved it", then "Yours · 2 min ago: Moved it to
  start at 0:18" and "Claude Code's · just now: Moved it to start at 0:20" ("Made it bigger (font size 120)", "Set its
  opacity to 50%", "Removed it"; a clip by its name or file, never an id), and which side the timeline shows until you
  pick ("Until you pick, yours is in the timeline."). The sides are radio buttons that only pick, starting on the side
  shown; the one main button names the pick ("Keep yours", "Keep Claude Code's", "Keep both") and Enter presses it.
  **See it** on a side shows that side on the preview, with the clip in view and the frame's label naming the side
  ("Claude Code's move of “Interview B”"; "Seeing it"; again, Esc, or deciding brings your edit back); "On timeline"
  selects the clip and moves the playhead to it. "Keep Director's" puts
  the agent's in as your own version (Ctrl+Z takes it back), and the confirmation names it ("Kept Claude Code's move
  of “Interview B”."). Two changes of your own read "Your earlier change · 10:04 am" and "Your later change", with
  "Keep earlier" and "Keep later". While the agent is still working, the card says so; if it changes the same thing
  again, a pick you made on the old values is dropped ("Claude Code changed it again. Pick again."). "1/2 ›" steps
  through the cards; "Not now" folds them into a "2 conflicts to pick" pill and sends that card to the back, deciding
  nothing. While History is open or you're looking at another version, the cards wait as the pill, whose click brings
  your edit back and opens them.
- **Who made each version** reads as you'd say it: "You" (a `cb` you typed included), a teammate's name, "Director",
  "Claude Code", "Codex", and a teammate's agent as theirs ("Leo's Director"). A subagent shows as the agent that
  started it; its type and the model are in the tooltip. The project's import reads "Imported the project" by you;
  the cut's start names no one. A clip without a name is named by its media's file name. What you do in the History
  panel is yours too, however the app was started: Fold in (and "Fold in the rest"), New cut from here, Name this
  version, Restore, Undo, a conflict card's "Keep yours" and a comment are you in History and `person` in
  `cb history` (a fold made in the panel was "Terminal", or "Claude Code" when the app was started from its shell). A
  new cut's first version, "Made this cut", names who made it (it named no one; `cb history` said `unknown`). Who made a
  cut is kept beside the cut, not in it, so a Cardboard with an earlier Carton still edits and renames that cut; it
  travels with a `.cbproj` that includes history and with a shared cut to a teammate who joins it, and a maker that
  isn't a well-formed name shows as no one.
- **What each version did** (UI audit, 2026-11-02): a version of several changes reads as one line ("Moved
  'clip.mp4', changed 'W1' and 'W2'"), and "3 changes" beside it opens the full list. A fold reads "Folded 'Client
  review' into 'Main cut': 3 changes", a restore "Restored an earlier version". No version shows an id or a hash:
  sharing footage reads "Linked 'clip.mp4' for sharing" (it read `Set 'clip.mp4' content to "8291f1d9…"`), and a clip
  dragged onto a new track names that track. **Fold in some of it** is one version, "Folded 'Client review' into 'Main
  cut': 2 of 3 changes", by whoever folded, holding exactly the changes taken (it showed the fold, then a change nobody
  made: the undoing of what was left out); `cb history` lists it as a `merge` with what it left out. A track left out
  keeps out the clips on it when the cut folded into doesn't have that track, and a title left out keeps out its own
  text entry (ordinary media, a video a kept-out clip uses, comes in as before): in the demo rehearsals `cb fold … --reject tracks/<Talk>`, with its list made before a teammate added
  another title on Talk, brought that title in on no track, which Cardboard's print showed on a made-up "Missing
  track", and History's Fold in did the same for a track's row left unticked. They count as left out, and `cb fold`
  names them ("and with them, since they can't come in without them: …"). Changes are
  counted one way everywhere (laptop re-check, 2026-11-02): a change per clip or field, a split one change, so the
  Fold dialog's "2 changes", History's "1 of 2 changes" and `cb history`'s "merge (1 left out)" agree (they read 2, "1
  of 4" and "3 left out"), as do Compare's and Watch the changes' counts (Watch's counter now steps through
  "Section 1 of 2", the stretches of the edit that differ), and a watch link's "N newer versions" counts a fold-some
  once. A split of a clip with auto reframe reads "Split 'clip.mp4' at 1.5 s" (it went on "…, cleared auto reframe on
  its left part, … on its right part": the editor's save drops it from the new parts). Titles are titles: "Added 2
  tracks, video 'clip.mp4', 6 titles and media 'clip.mp4'" (it read "7 clips and 6 media files", counting each
  title's own media entry), and Compare's clips read "1 clip, 6 titles". A title's own media entry ("Text: W1") is the
  title's in the counts and lists too: that setup version counts and lists its tracks, clip and titles, with no "Added
  media 'Text: W1'" lines (each title counted twice before), a restore's list names the titles only, and in the Fold dialog a new title and its entry are one
  row, left out together. The Fold dialog names a track the same fold adds ("Moved 'W1' to track 'Text 1'", as
  History's row says it; it read "to track another track"). Every undo or redo of a restore says so ("Undid the
  restore", "Redid the restore"), also the second and later ones (they read as fresh edits), and the undo of a fold or
  of "Folded the rest…" reads "Undid the fold of 'Alt' into 'Main cut'". **Fold in some of it is one undo**
  (laptop P2-1): after "Fold in 2 of 3" and then the rest, Ctrl+Z takes back the rest, and the next Ctrl+Z the whole
  partial fold, leaving Main as it was before it. The second press used to bring the rest back in (the two presses
  flipped between the same two states, the second misnamed) and a third undid the fold; a partial fold on its own
  undid to the rest brought in. Redo walks forward the same way, and `cb undo`, `cb undo --turn` and History's Undo
  do the same, also on a shared cut with a teammate's edits in between. `cb history` lists "Folded the rest" as
  `merge (the rest)` (it read `revert`), and a redo as `redo` (it read `revert` too), as an undo reads `undo`. **You can fold in the rest later** is true now: the next Fold in lists what
  was left out ("Left out earlier") beside anything new, instead of "Nothing to fold in"; what one fold left out comes
  in, or stays out, together. The filter "Agent turns" (it was "Director turns", and empty for agents with no turn
  recorded) lists every agent's turns: a Director turn, and a run of your Claude Code's or Codex's versions up to the
  one its turn's end names. A conflict card's "Preview" of the agent's side shows the agent's edit (it showed yours,
  and yours showed the agent's). After Restore or "Fold in the rest", Undo offers that version at once.
- **`cb`**: `cut`, `fold`, `credits`, `restore`, `compare`, `conflicts`, `resolve` and `publish`, and the MCP tools
  `timeline_cuts`, `timeline_fold`, `timeline_credits` and `timeline_publish`.
- **A project is never left unreadable.** History's oldest row, "Started the cut", is where the history of a project
  Carton took in begins, before the project itself (the next version): it has nothing to preview, restore or make a
  cut from, so History doesn't offer those, and `cb restore`, `cb cut new --from` and `cb publish` refuse it, naming
  the version that holds the project. (Restoring it used to write a `project.json` with no name and nothing in it, and
  the project vanished from the library.) No writer turns a `project.json` Cardboard reads into one it can't, or
  removes a project's name: the old file stays, and the refusal is logged in the bundle's `.carton\refused.log`.
  History never starts from a file Cardboard can't read. When History or `cb` would have written such a file, they
  say the project file wasn't changed.
  A project the earlier build broke that way is listed again under its name, found by `cb history` and `cb cut list`,
  and opens with its History: Restore of a version from before brings back its name, timeline and media library.
  `cb` mentions a project it can't read only in a command that names that project, not in every command on the
  library.
- **Restore keeps each clip's details.** What Cardboard knows about a media file and history doesn't version (its size,
  duration and dimensions, where it plays from, its thumbnails and waveform, when it was added) is kept in the
  bundle's `.carton\media.json` whenever a write removes the clip from `project.json` (a restore to a version
  without it, a fold, an undo, a deletion). A restore or fold that brings the clip back writes those details with it.
  Before, Restore of `main@1` and then of the newest version brought `clip.mp4` back without its duration, size or
  thumbnail, `cb media list` showed "-" for them, and the clip played black until Cardboard restarted. When nothing
  kept them (a project an earlier build left like that, or one the root restore broke), Cardboard's own probe reads
  the file again, as its import does, and the app makes its thumbnails and waveform again (from its cache when it has
  them). So a recovered project's clip plays at once. A restore also moves the project's "Updated" time in the library. And `cb undo <project> 0` reads 0 as the
  version to restore, `main@0`, which it refuses as empty, where it used to undo your newest change without a word.
  (`carton\packages\cardboard\src\node\media-details.ts`, `scripts\carton\carton-node.js`)
- **A recovered project saves your edits.** A project brought back through History, from the state the earlier build's
  bug left it in, came back with media entries that had no "created" and "added" dates. History doesn't keep those
  dates, and nothing else had kept them, since the bug came before Restore kept clips' details. Cardboard's editor
  writes both dates back at every save, so every edit on such a project failed ("Invalid time value" in the console),
  with nothing said, and a later `cb source apply` reloaded the editor without it. Now every entry Carton writes has
  both: the clip's own when the file or `.carton\media.json` has them, else the project's own date (no clip is older
  than its project); a title also gets what Cardboard's own titles have. A project already saved that way (one an
  earlier build recovered) gets them as Cardboard reads it, and its next save writes them. If a save still fails in
  the editor, Carton says so over the stage, with a warning sign (it used to show a confirmation's green check), and
  says what to do: "Your last change wasn't saved. Do it again, or reopen the project." A refused undo says so the same way.
- **Undo never empties a project.** Ctrl+Z (or `cb undo`) right after recovering such a project undid the Restore,
  back into the state the bug left (a name, and no aspect ratio, tracks, clips or media), and the open tab crashed
  ("This tab hit a snag"). Now an undo, redo or revert that would leave the project with nothing in it is refused
  before anything is saved, with "Can't undo that: the project would be left empty", and nothing else runs instead.
  Restore and "New cut from here" refuse such a version too. Their message used to say "the history starts there",
  which is true only of the first row: a later emptied version says "nothing of the project is in it", and `cb`
  names it ("main@4 holds nothing of the project"). The editor also never takes a project without an aspect ratio
  from History without Cardboard's own default (16:9), so a tab can't crash on one. In a shared project, an undo
  made offline that a teammate's edit would turn into one is refused when it is sent, and you're told. And an earlier
  copy of the project file that Carton itself wrote, found again on disk, is no longer taken for someone else's edit
  that puts the old version back over your undo.
- **`cb restore` lists the clip's file again.** After `cb restore` to a version without a clip and back, the project's
  list of where its media files are stayed empty, and every `cb` command printed "Recovered 1 unlisted media path(s)"
  until the next real save. The restore now lists the clip's file, as the app's own restore did.
  (`carton\packages\cardboard\src\host.ts`, `carton\packages\core\src\history\history.ts`,
  `scripts\carton\store-bridge.js`, `scripts\carton\renderer-bridge.js`, `scripts\carton\carton-node.js`)

The words, with git's (the app and `cb` use Carton's; git's work as `cb` aliases):

| Carton | git |
| --- | --- |
| Version | commit |
| Cut | branch |
| Fold in | merge |
| History | log |
| Credits | blame |
| Restore | revert |
| Compare | diff |
| Publish | tag |
| Undo turn | revert by author |

**Where it's still incomplete (2026-10-31).** History, cuts, fold, credits and `undo --turn` work in `cb` on real
Carton. Live sync and sharing, media for shared projects, `cb`'s cloud mode and `.cbproj` with "Bring in their
changes" work in the app's real library worker, and so do per-agent views, the `timeline.tsx` freeze during an
agent's turn and the agent prompt that describes them (a Director turn end to end: `director-turn.test.js`). All of it
is tested on Linux with Cardboard's own bundles. Not wired yet:
- Carton's merge in an apply's preview (the preview is Cardboard's own; the commit that follows merges with Carton);
- the engine thread (the worker commits on its own thread).

The editor's side, the History tab and main's agent hooks have only been tested on stand-ins: they need the Windows
run below.

`scripts\patch-carton.js` (after the Windows patches; `scripts\carton\` holds what it injects):
1. The project store, both copies (the app's library worker and the CLI's own): one Carton change per edit, against
   the version it was made on; the save into `project.json` and `timeline.tsx` displaces whatever is there and links
   the new file in, so a write by anything else is kept and imported, never overwritten (`.carton\displaced\`). The
   store hands that install the document it just wrote, so after a GUI save Carton's print of `timeline.tsx` takes it
   from there instead of reading `project.json` back.
2. History and undo read Carton's versions first, then the old `.revs`; an apply's base is the exact version its
   header names; Carton's merge replaces Cardboard's. The header can be Cardboard's (`// cardboard:rev <number>`) or
   Carton's (`// cardboard:rev Main cut@12~3f9a1c0e b:… p:… by …`, as Carton's own prints of the timeline write it);
   only the first such line counts. For Carton's, the edit merges against that exact version and is saved as made on
   it; a version Carton can't rebuild exactly is refused with "print it again". With Carton on, `cb source print` and
   the timeline file always carry Carton's header, so agents editing at once never merge against the wrong version (a
   number names one exactly too; before, the newest version "at or before" it was taken, and with several writers that
   could be a newer one, so an agent's edit put back another's older values). (Cardboard alone reads only a number
   there, so it took Carton's header for none and merged against the current timeline, reverting newer edits.)
3. A `.cbproj` never carries `.carton\` or Carton's view files in `.scratch\views\` (on or off: the database holds
   local paths); anything else in `.scratch\views\` goes in.
4. `cb`: the commands, WHO in `cb history`, `undo --turn`, the MCP tools, `cb source print --view <name>` (an agent's
   own view, below), and a `cb carton-hook` command a Claude Code started as a process runs for its hooks (which also
   tell the app what the agent reads and writes, below; the app's own agents run theirs inside the app, item 5). Its
   hooks on Read, Write and Edit run only for `timeline.tsx` and `project.json`
   (Claude Code's `if` conditions, checked inside Claude Code): a call on any other file starts no process, so an
   agent's ordinary reads cost nothing extra. A Claude Code too old for `if` runs them on every call, with the same
   answers.
5. Main: every agent gets `CARDBOARD_ACTOR`; the Director's Bash hook names its turn and subagent (and so does a hook
   on Claude Code's PowerShell tool, which Cardboard's hooks don't cover: `$env:CARDBOARD_ACTOR` there, left out of a
   script that must open with `using` or `param(...)`; `cb` is found in any case and as a quoted path); `Stop` and
   `SubagentStop` hand a late conflict back to the agent once (then the cards it left are the person's); the
   Director's Read, Write and Edit calls and its turn's end reach the app's timeline (below). Cardboard 1.4.0 runs your
   own Claude Code the way it runs the Director (its Agent SDK, with the same hooks inside the app; it never starts it
   as a process with `--settings`), so those hooks tell the two apart: your Claude Code's `cb` calls and reads of
   `timeline.tsx` are `claude-code/<session>` ("Claude Code"), and its turn's end lets go of exactly those and names its
   last version from your message (the chat's own record of what you typed, never the prompt Cardboard composes with its
   preamble), then from a short title made by Cardboard's own naming call (`UKt`'s `hke`, handed to `main-bridge.js` by
   `patch-carton.js`; the worker's `retitleTurn` keeps a name given meanwhile). That id is the same in every turn of a session, so the turn's end draws the line: a
   hook still waiting when you stop a turn (its `Stop`, a credit question) does nothing once it's answered, rather than
   letting go of the next turn's hold on `timeline.tsx`; and a turn is named only from a version made between its start
   and its end, never the next turn's, however late the naming runs. Codex, which Cardboard does start as a process, is
   `codex/<chat>`. The GUI save's base
   reaches the worker; `carton:call` for the pages. With Carton on, every agent's instructions (its system prompt and
   the `AGENTS.md` Cardboard writes into each bundle) describe the per-agent view; with Carton off they are
   Cardboard's, word for word.
6. The editor: the save names the version it was made on; a change from elsewhere is adopted without an undo step
   (a pending save goes first); Ctrl+Z goes to Carton; ripple and split deletes record what they moved; the History tab,
   whose writes (fold, a new cut, restore, undo, naming a version, a card's pick) are recorded as the person's, never as
   the worker's own identity; "Fold in the rest" reaches the editor as a fold does. What the worker writes into
   `project.json` from history (a panel write, a teammate's change) goes in only if history's newest version is still
   the one it was made from when Cardboard's store gets to it: an editor save made meanwhile goes first, and the write
   is made again from the version that save made, so it never puts the older timeline back over the save.
7. Cardboard's own `timeline.tsx` printer and parser, in both copies, for Carton's prints of the timeline (per-agent
   views, the shared file during an agent's turn): the print is exactly what `cb source print` shows, with Carton's
   header on its rev line; the parse is exactly what `cb source apply` would save for the file, without saving or
   importing anything. What only the apply can do (a path to a new clip, a LUT file outside `luts\`, a color match) is
   refused there, as is a half-written file. Each of Cardboard's functions it calls is checked at build time where
   Cardboard's own apply calls it.
8. Agents and the person editing at once (H8): the library worker runs Carton's materializer for each project it
   opens. It writes `timeline.tsx` from Carton's history (with that printer, under Carton's header) in place of
   Cardboard's own regeneration, and Cardboard's watcher hands it what others save there. While an agent works,
   `timeline.tsx` holds back other people's changes, so it doesn't change under the agent: a turn of the Director or of
   your own Claude Code in the app from its first `cb` call or read of the file until its turn ends, whatever runs in
   between: a `cb source print` holds it as a write does, `cb` in Claude Code's PowerShell tool as in Bash, and a long
   call that isn't `cb` (a ping, a render, a command the agent left running in the background) doesn't end it. Before,
   a real turn on the laptop let the person's mute into the file mid-turn: its first print and a 30 s ping ran in
   PowerShell, which the app's hooks didn't cover, so nothing held the file until a later Bash command; and the worker
   let go of an agent it hadn't heard from for a minute, so any longer call would have done the same. Now, while the
   turn runs, the app tells the worker so every 20 s; the turn's Stop or end lets go at once, and if the app goes away
   the worker lets go a minute after the last word, so no hold outlives its turn. Anyone without hooks
   (Codex, a Claude Code in a terminal without Carton's hooks, a `cb` you type) holds it until a minute after their last
   `cb` edit. The person's edits go on in the editor and `project.json` meanwhile, and reach the file when that ends. An agent can also print its own copy, `cb source print <project> --view
   <name>` (`.scratch\views\<name>.tsx`): each save of it is applied as that agent's change, and
   `.scratch\views\<name>.status` says how it landed. A clash keeps what is there and is a card on both sides: the
   agent's (`cb conflicts`, the Stop hook) and the person's (History). That worker is also the project's one lease
   holder, so `cb`'s writes and hook events reach it. A `timeline.tsx` printed by Cardboard 1.4.0 (a numbered header)
   still applies as an edit of the version it shows. **A `cb` write is in `timeline.tsx` by the time `cb` answers**,
   freeze or not (read-your-writes): `cb source apply`, MCP's `apply_timeline` and the Carton writes (`cb undo`, `cb
   fold`, `cb restore`…) ask the app to show it and wait for that print, at most 2 s, and the result says how it went
   (`timeline` in JSON: `shown`, or why not, with a line in the text: held for an agent's turn, or "will show this in a
   moment"). A wait of 500 ms or more is noted in the activity log with where the time went (on the laptop about 4 %
   of agents' round trips with Carton on took 2 s or 4 s longer, which no Linux run reproduced: the note names the
   cause in the app). During a freeze only the writer's own change goes in, never the person's edits made meanwhile. Before, the
   app noticed a `cb` commit at its next look at the history (it looks every 250 ms) and rewrote the file a moment
   later, so a read right after `cb` answered could miss the write; in a real turn on the laptop the agent read the old
   value and told the user the file showed its turn's start. A `cb` you type in a terminal holds the file as a
   windowless agent does, and now sees its own write in it (it was held back from it for a minute). An app that quit
   or crashed without letting go of the project leaves `timeline.tsx` to `cb` at once (its socket refuses), where `cb`
   skipped the file for the few seconds its lease still looked live. An agent that writes or edits `project.json`
   directly is refused and pointed to its own view. The views are checked for saves by reading their size and time a few times a
   second, not by a file watcher: on Windows an open watch inside the bundle could stop Cardboard renaming the
   project or moving it to the trash. Where the materializer writes `timeline.tsx`, Cardboard's own regeneration of it
   after each save is skipped (it printed the whole timeline, wrote it to a temp file and deleted it unread, on every
   save). Your Ctrl+Z shows in `timeline.tsx` at once, as your edits do: it is yours, not an agent's, so it doesn't
   freeze the file (it used to, for a minute, hiding the undo and your next edits from any agent that read it). The
   worker undoes it in its own process when it holds the project's sync lease, without a round trip through its own
   control socket. When another process holds the lease for a moment (a helper that took over while the app was
   busy) and saves your edit or your undo, the app still knows the change as yours and freezes nothing.

9. The bundle loader, both copies: a `project.json` Cardboard's reader refuses, for a project whose history this
   computer keeps (in `.carton\carton.db`, or in app data for a synced folder), is read through that history (the
   file with the project's last name), so the library lists it again and `cb` finds it. Another project's or another
   computer's history is never used. Cardboard's reader still decides, and a project it reads costs nothing more.

`scripts\carton\build.js` bundles it: `resources\carton\carton-node.cjs` (for the worker, main and `cb`), its engine
thread and helper beside it, and `carton-ui.js` beside the editor's code. **A `cb` call with Carton on starts faster**
(perf/apply-latency): it used to compile all of `carton-node.cjs` from source on every call, twice per agent's print
and apply; Node's compile cache (in `%TEMP%\node-compile-cache`, checked against the file's contents) now keeps that
work between calls. And a `cb` call no longer runs a checkpoint of the project's `carton.db` log when it opens it (it
copied and synced the log, even for a read-only `cb source print`): while the log is small, the app's worker does it
on its own timer; a log past 4 MiB is still checkpointed by whoever opens it. `build-windows.js --no-carton` leaves Carton
out entirely, and `--baseline` does too.

## Testing Carton

On any machine (Linux here), against Cardboard's own unpacked bundles: `CARDBOARD_PRISTINE` is a folder with
`app-asar\` (`pnpm dlx @electron/asar extract …\app.asar`) and `cli\` from the macOS installer.

```sh
cd carton && pnpm install --frozen-lockfile && cd ..
set CARDBOARD_PRISTINE=C:\cb-pristine
node --test --test-concurrency=1 "scripts/carton/test/*.test.js"
```

They check that with Carton off `cb`'s output and files equal this build's without Carton, that `.cbproj` leaves out
`.carton\` and Carton's view files and keeps the rest of `.scratch\views\`, that with Carton on every hook reaches
Carton with the right arguments (a recording stand-in), that the real library worker runs patched (on Node, standing
in for Electron's port), and the editor's and main's bridges on stand-ins, with the methods each answers itself, and
that a read catching `project.json` in the middle of an install waits for it instead of reporting the project removed,
and that the staging folder's removal is retried. `codec.test.js`: Cardboard's own printer and parser as Carton uses
them, in `cb` and the worker (the print equals `cb source print` but for the rev line, the parse equals what
`cb source apply` saves, a half-written file is refused), and an apply under Carton's header merging against that
exact version, or refused when it's gone; with Carton off, the same file applies as in this build without Carton.
38 tests. `asar-assets.test.js` (main's patch 16): `app://` gives the same status, headers and bytes for every
request as Cardboard's own handler, on Windows and macOS. The sweep deletes the byte copies and keeps everything
else (a byte changed, another extension or name, a prefix, an empty file, a folder, a link), keeps copies made since
Windows started, and is done once nothing it should delete is left.

On the Windows laptop (on mains power, with a throwaway profile and library, never your own):

```sh
cd tools && pnpm install --frozen-lockfile && cd ..\carton && pnpm install --frozen-lockfile && cd ..
node scripts/build-windows.js
set CARDBOARD_USER_DATA=%TEMP%\cb-carton\userdata
set CARDBOARD_HOME=%TEMP%\cb-carton\home
set CB=out\Cardboard-win\resources\cli\cardboard.mjs
```

The build's last step checks that `carton-node.cjs` loads in Cardboard's own Node.

1. **No regression, Carton off.** Start `out\Cardboard-win\Cardboard.exe --remote-debugging-port=9334` with
   `CARDBOARD_CARTON=0` and run `scripts\test-shortcuts.js` (both forms, see "[Testing the keyboard](windows-port.md#testing-the-keyboard)"). Expect 25 and 9
   passes, as before Carton. Repeat without the variable (Carton on, the default): the same.
2. **The lost update (B1), Carton off then on.** A signed-in app keeps its projects in its account's library,
   `%CARDBOARD_HOME%\accounts\<64 hex>` (made at the first sign-in), not in `%CARDBOARD_HOME%` itself, so the writers
   use that folder, or the app never shows their project: sign in once, then
   `for /d %A in ("%CARDBOARD_HOME%\accounts\*") do set LIB=%A` (`%%A` in a .cmd file). With the app closed:
   `node scripts/carton/writers.js setup "%CB%" "%LIB%" bench-media\<a clip>.mp4`, then
   `node scripts/carton/writers.js run "%CB%" "%LIB%" --writers 4 --rate 1 --seconds 120`. (`%CB%` runs with
   this Node; `cb` through `Cardboard.exe` works too. Steps 3 and 4 use the same `%LIB%`.) Each failed apply prints why after the table (`failed: W2 edit 41 apply, exit 1: <its message>`); `--out` keeps them in `failures`, and every edit in `samples`: its print's and apply's own times (`print`, `apply`) and how the apply's write showed in the app's `timeline.tsx` (`timeline`: `later` when it took longer than `cb`'s 2 s wait). Off, some writers can lose their last edit. On, none may, once
   history is in.
3. **Gate G2: GUI saves under 4 agents** (§6.2). Start the app with `CARDBOARD_CARTON=0` and
   `CARDBOARD_CARTON_TIMING=%TEMP%\g2-off.jsonl`, open
   "Carton gates", start the 4 writers (`run … --seconds 300`), and edit for 3 minutes in the editor: move, trim,
   split, a change every second or two. Every save's round trip to the library worker lands in the file. Then the same
   without `CARDBOARD_CARTON` (Carton on) and `g2-on.jsonl`. Alternate three runs of each. Pass: the p99 of `ms` with Carton on is
   no worse than off. Report medians and every run.
4. **Gate G1: 3 writers at 1/s for 10 minutes** (§16; `run … --writers 3 --rate 1 --seconds 600`), Carton on, while
   you edit the clip on track "Mine" (split it, move the pieces). Then:
   - none of your edits is missing: the pieces you made are all there;
   - none of the writers' changes is saved under your name: in `cb history "Carton gates"`, every version with WHO
     `person` changes only "Mine"'s clips (`cb compare "Carton gates" <the rev before> <its rev>`);
   - Ctrl+Z, as many times as you made edits, undoes only yours: the W1–W3 sizes keep the writers' last values;
   - playback frame times within noise of Carton off (DevTools Performance, the same 30 s of playback in each).
5. **The NTFS race** (§6.4, P10): `powershell -File carton\bench\race\run-windows.ps1` on the laptop's NTFS volume.
   Atomic writers must lose 0 writes. Then Claude Code's own fallback: Claude Code writes a file by temp and rename,
   and in place when the rename fails (Cardboard or Defender holding it). Run a Claude Code session that edits
   `timeline.tsx` in a loop while `writers.js` runs, and count the edits it reports against those in `cb history`;
   in-place writers may very rarely lose one (L19), never silently in a per-agent view.

## Carton: live sync and sharing

With Carton on, a project can be shared through a Carton host (`carton\apps\server-node`, or the Cloudflare Worker),
so two people, each with their own agents, edit it at once. Nothing here runs for a project that isn't shared, and
with Carton off none of it runs at all.

- **Share** (the "Share" icon in the title bar; in a window under 1180 px wide, the Share button in the History panel's
  head) opens a dialog over the editor, "Share “Weekend reel”" (it was a tab of the side panel). Not shared yet: the
  sharing server is already filled in, shown as one line with Change: this build's own server
  (`cardboard-showcase.vikasmaur10.workers.dev`, open to anyone, so nobody has to know an address). Change takes
  another (as people say it, "share.example.com" is enough; once used it is remembered and shown the same way). Then
  your name (asked once, then shown as "Teammates see you as …" with Change), then Share
  project; Enter in a field does the same. A host with open creation (the free web demo's) needs nothing else:
  you become the project's owner. Any other host asks for the invite you were given (the host's owner gets one with its
  admin token); the form shows that "Invite code" field only when the host asks for it. An address that can't be
  reached is said so at the address field, and every failure is a sentence that says what to do (can't reach the
  server, invalid or expired invite, server busy, its daily limit reached), never a raw "fetch failed".
  The project goes up with its whole history and authors. Its clips go up too: each clip's
  content id, and a 720p "collab proxy" (Cardboard's own proxy when it suits, else NVENC → QSV → AMF → x264) as ~2 s
  segments that upload as they are made. Video originals stay on your computer; audio and still images (which have no
  proxy) go up as they are, up to 200 MB and 50 MB.
- **Shared**: the dialog shows the status by its title ("Up to date", "Sending 3 changes", "Offline"), then People:
  You (drawn as History draws you, "Y", with the name teammates see and your role), and everyone here now with what
  they're doing ("Here now · editing captions"; someone idle is faded) and what they may do ("Can edit", "Can comment":
  each app tells its own role with its presence; an older app's teammate shows none). A teammate's agent (or a
  subagent it started) is listed under them as theirs, with its own mark: "Leo's Director · Working on “Add a title
  card”". Offline, an amber line
  says your changes are kept here and sent when you're back; when sync can't go on for another reason, that one line
  says why instead ("Can't sync: the sharing server needs an update. Your changes are saved here."), the server's own
  message only in its tooltip.
- **Invite** (the owner): who can do what ("Can edit", "Can comment", "Can watch", from a menu), the link, and Copy
  link. The link for the role picked is made as the dialog opens and shown in its field, and kept for the next
  openings while it surely works (an hour at most, and never past a minute before the invite expires; one whose expiry
  the server's token doesn't say is made anew); "Anyone with this link can join and edit." Links expire; none can be
  made offline, and it says so.
  **Join** from the Dashboard: a "Join a shared project" tile beside "New project" (Carton on only) opens a dialog with
  the invite link, "You'll join as Leo. Change" (or your name, the first time), and one button, Join and open: the
  project arrives in the library with its history, opens in a tab of its own, and the dialog closes; its clips play
  from the host. If the tab can't open, the dialog says the project is in your library, with Open to try again. An
  empty library (a new user's first screen, "Make your first video") has a "Join a shared project" button beside
  "Start a blank project" instead. The dialog lives through the library's first project arriving (it used to close by
  itself there), and joining the first project keeps the home page where you were (it jumped back to the Dashboard's
  top as the library's empty view gave way to the grid) and brings the new tile into view.
- **Live**: each save goes to the host change by change. A teammate's change appears in your editor without an undo
  step and without dropping your unsaved edit, and two people changing different fields of one clip both keep theirs.
  The Share dialog shows the status and who is in the project, with what they are doing. On a cut of your own (one
  that isn't shared: `cb cut switch`, the cuts menu), the status beside the title and the title bar's dot are the
  shared cut's, which stays connected; a plain line says "You're on “Vikas's cut”, which isn't shared. Your edits
  there stay on this computer, and teammates don't see you until you're back on “Main cut”.", and You read "Vikas · on
  “Vikas's cut”", without the ring of someone here (switching to it takes you out of the shared cut's presence).
  Before, Share kept "Up to date" from before the switch, or turned amber "Offline" and stayed so while the shared cut
  was up to date. The title bar shows it too,
  with nothing open: a dot on the Share icon (amber offline, white
  while edits are sending) and the people here as small avatars, the words in its tooltip; a chip over the preview
  says "Offline · 3 changes not sent yet" (or "Sending 2 changes") while changes wait (a click opens Share). Someone with the project open but idle stays
  listed, faded. In a narrow window the title bar keeps only the History icon (Share is in the History panel's head),
  with the dot on it. Offline you keep working; your changes go out when the host is back. When sync can't go on, the
  dialog says why instead of "Syncing" for ever: a host older than the app ("it needs an update", the host's own
  message in the tooltip), access refused, the host out of reach.
- **Cardboard's background work never undoes a teammate's change.** An import's waveform and album art, the
  thumbnails Cardboard makes again, a transcript's status and a relinked file's new date are written into `project.json`
  after the edit that caused them. They change nothing Carton versions, and Carton recorded no version for them, so
  the next time the file was read it looked like another program's save: it was imported over the newest version,
  and a teammate's change that had arrived meanwhile was deleted for everyone (in the demo rehearsals, a title added
  right after a sound was dropped on the timeline, 11 of 12 times). Each such write is now known for what it is. Its
  waveform and art stay in the file, and a real save by another program is still taken as one: as what it changed
  against the version the file showed before (merged with what reached the project meanwhile; before, its whole
  document went over the newest version, and a teammate's change on its way into the file was taken out), also
  when the program kept the file's own rev (the file is that version only while what Carton keeps of it is that
  version's), and when that version still had edits waiting for the sharing server: the file Carton wrote for such a
  version is kept as written (a hard link in the project's `.carton\bases` folder, not a copy), so a restart doesn't
  lose it. An outside save is taken at once, never held; one whose kept file is gone (only past the newest 512) is
  taken against that version's confirmed state, and a clash with an edit made since is the person's conflict card.
  Offline, a second change of the same thing (moving a clip twice) stays too: it was made on the first, still unsent,
  as if on the state before it, clashed with it ("You" vs "You"), and the clip went back to the first. An outside save
  Carton can't take at all (it rejects the document) is kept as it is in the project's `.carton\outside` folder and
  said in the app's log, and the project goes on showing the newest version. Carton knows its
  own `project.json` by the bytes it wrote (their hash), never by a file's size and date alone. None
  of this costs a save: in an independent check of this branch with six alternating pairs of 120 saves at 200 items,
  the gap after subtracting the Carton-off control's had a median of −0.565 ms.
- **Who made it**: your edits in the editor show as yours ("You" in History) on your computer and under the name you
  chose when sharing or joining on your teammates', in History, credits and presence, including the edits you made
  before you shared. (Cardboard records every editor save as "the person"; Carton tells each one by the computer that
  made it, which the host knows, so nothing in the history is rewritten.)
- **A teammate's clips** play from the host by range (each 1 MiB verified against its content id, cached in app data)
  through Cardboard's own `cardboard-media://`, even while the proxy is still uploading. A teammate's new sound or
  still plays as soon as their app has sent it: the editor's first ask for its clip, which can come before the file is
  on its way, is answered once it is (for up to 12 s after the clip arrived, however slow the sharing server is to
  answer meanwhile) instead of with "Source file missing", and the app that adds a
  sound or a still sends it at once, while its person goes on editing (a video still goes once editing pauses for 2 s,
  so its preview can be made from Cardboard's own). Before, the sound played 2 to 4 s after it could have, and the
  editor was first told it was missing. The agent's ffmpeg tools
  (`grab_frame`, `filmstrip`, `probe_media`…) read it from a loopback URL. Each clip's content id and shared record go
  into the project itself, as a version by whoever shared it.
- **Opening a project you joined**: its clips were never on your computer, so 1.4.0's loader would stop at "Missing
  Media Files", whose only way on is a red "Remove and Open" (which, live, would remove the clips for everyone). With
  Carton on, the loader asks the library worker about each clip it found no file for: a teammate's clip whose preview
  is on the host plays from it; one not sent yet shows as Cardboard's own "Offline" placeholder and is never offered for
  removal; a notice over the preview says so in a title line ("2 clips are still on their way from your teammate"),
  then which ones, by name ("“interview-b.mp4” and “broll-03.mp4” show as Offline until they arrive. Nothing was
  removed."), and later that they have arrived. The dialog still
  appears for footage that was on this computer and is gone (moved, a drive unplugged). If the worker can't tell whose
  a clip is (it fails, or doesn't answer within 6 s), the clips go Offline too, never to the dialog, and the notice says
  to reopen the project to check again.
- **Agents**: `cb` on a shared project hands its edit to the app's library worker, which holds the project's sync
  connection. With the app closed, `cb` starts a headless helper that syncs for a minute after its last call. In `cb`'s
  cloud mode (`CARDBOARD_CLOUD_PROJECTS=1`) a shared project is pulled through Carton before each tool call (the helper
  catches up and the newest state goes into `project.json`) and is never PUT as a whole file afterwards.
- **An agent's edit and yours at once**: an agent edits its own view of the timeline (`.scratch\views\`). When its
  save clashes with an edit you made meanwhile, your value is kept, the rest of its edit goes in, and you both get a
  conflict card. The agent's is in `cb conflicts` (and its view's `.status`). Yours is in History, open now or opened
  later, naming the agent: "Keep yours" changes nothing; "Keep Director's" makes the agent's value a version of yours.
  An agent Carton knows only by its environment (Claude Code run from a terminal with no Carton hook, Codex, Gemini)
  is still named in History and on the card ("Claude Code"), never "You".
  Choosing on either side closes the card on both: your choice removes the agent's, and the agent's `cb resolve`
  removes yours (a pick you make before it goes still holds). Whatever the agent leaves unresolved when its turn ends
  stays in History for you.
- **"Bring in their changes"**: opening a `.cbproj` of a project you already have, with history, merges their versions
  in instead of 1.4.0's "This project ID already exists". Where you both changed the same thing, theirs goes in and
  yours is kept on a conflict card (`cb conflicts`; `cb resolve <n> --keep mine` puts yours back; the History panel).
  Clips they added come with their files. Opening one of a project you don't have starts its history from theirs
  (its `timeline.tsx`, printed under their version, opens as that version: the same state starts your history); their
  cuts show as read-only, and as "<name> (their copy)" where one would share a name with yours; whatever Carton opens in Cardboard's staged copy is closed before Cardboard moves it into the library (Windows can't
  move or remove an open file). A `.carton\` folder or Carton's view files inside a `.cbproj` are never kept: Open
  Project removes them, even with Carton off, and keeps anything else in `.scratch\views\` (see "[Saves on Windows](windows-port.md#saves-on-windows-scriptsrename-retryjs)",
  With Carton off). **Include history**:
  Cardboard's Save As dialog has no switch for it, so set `CARTON_CBPROJ_HISTORY=1` in the environment of the app or
  of `cb` before saving. The file then also carries every version, with its author and name, and whoever opens it sees
  them on a read-only cut. History never includes your local data (pins, notices, sync settings). Saved while edits to
  a shared project are still waiting to sync (offline; Carton counts them for whichever process saves, the app or
  `cb`), the file has no Carton history at all, only what you see (as in 1.4.0), and the log says so. Save again once
  synced. An agent's or a teammate's edit arriving during a Save As can't break it: the files Carton rewrites
  (`timeline.tsx`, `project.json`, the views) go into the file as they were when the save began. (Cardboard's zip
  writer reads a file only when its turn comes; a file rewritten before then stopped the library worker.)

Where it lives: `scripts\carton\sync\` (bundled into `carton-node.cjs` and `carton-ui.js`; `factory.js`, the helper's
engine, is copied beside them) and `scripts\patch-carton-sync.js`, which runs after `patch-carton.js` and applies
`scripts\carton\sync\patches\*.js`: presence in the editor (`ui.js`; Share opens from the title bar), `cardboard-media://` for clips
that live on the host (`media.js`), the agent's media tools (`tools.js`), `cb`'s cloud mode (`cloud.js`) and `.cbproj`
(`cbproj.js`). Sessions and tokens are in app data (`%LOCALAPPDATA%\Carton\sync\`, owner-only), never in the project.

Tests (Linux, Cardboard's own bundles; two libraries, each with its own app data and its own real library worker,
syncing through a real host on 127.0.0.1): share with history, invite and join, concurrent edits, who made each edit
(each side's GUI edits under their name at the other's, before and after the share, "You" for your own), presence, media by
range, by URL and through the agent's `grab_frame`, media while it uploads, offline and rejoin, `cb` with the app open
(from a print one version behind), and with it closed in cloud mode, another program's save and an offline restore
with the app closed, a host too old for the app; `.cbproj` Save As, Open and "Bring in their changes" in both copies,
with history, and saved offline (`cbproj-offline.test.js`); which files in `.scratch\views\` are Carton's, against
the files Carton's own materializer writes (`views.test.js`); the save path's merges, and the hand-over of the
`project.json` a GUI save wrote (`facade.test.js`); an agent's
view-save cards on both sides, through the worker's History panel (`view-cards.test.js`, needs no Cardboard bundles);
the panel's words when sync fails (`ui.test.js`); and what a GUI save costs the worker, counted rather than timed so
a busy machine can't hide it: no print of `timeline.tsx` made and thrown away, the editor's save projection run only
for the items that changed, a bound on file system calls per save (each one a trip through NTFS on Windows), no
second read of `project.json` to print `timeline.tsx` (the facade hands Carton the file the save just wrote), and
Ctrl+Z showing in `timeline.tsx` at once (`save-cost.test.js`); Cardboard's background writes (an import's derive, the
derive main asks for) followed by a teammate's change, which stays, and another program's save, still taken as one
(`derive-race.test.js`); a teammate's new sound, its clip asked for the moment it arrives, and sent while its person
goes on editing (`teammate-sound.test.js`); Share on a cut of your own, with the sharing server gone and back
(`share-own-cut.test.js`); `cb restore --clip --remove` on a shared cut (`restore-remove-shared.test.js`); a fold
that keeps a track out while a teammate adds to it (`fold-kept-out.test.js`). The timings are `save-bench.js`'s, a measurement and
not a test: a GUI save's round trip to the worker and how soon `timeline.tsx` shows it, Carton off and on alternated
round by round (run it alone, on a quiet machine, on mains power).

```sh
set CARDBOARD_PRISTINE=C:\cb-pristine
node --test --test-concurrency=1 scripts/carton/test/sync/live.test.js scripts/carton/test/sync/cbproj.test.js scripts/carton/test/sync/cbproj-offline.test.js scripts/carton/test/sync/views.test.js scripts/carton/test/sync/facade.test.js scripts/carton/test/sync/view-cards.test.js scripts/carton/test/sync/ui.test.js scripts/carton/test/sync/save-cost.test.js scripts/carton/test/sync/derive-race.test.js scripts/carton/test/sync/teammate-sound.test.js scripts/carton/test/sync/share-own-cut.test.js scripts/carton/test/sync/restore-remove-shared.test.js scripts/carton/test/sync/fold-kept-out.test.js
```

Still to check on the Windows laptop: the Share panel in the real editor, a teammate's clip playing in the preview
(Electron's protocol handler and the media element), NVENC/QSV/AMF proxies, the helper under named pipes, and renames
under Defender.
