# Carton, re-imagined: the design

Design only. Nothing here is built yet. `PLAN.md` says how to build it, and `AUDIT.md` covers what is there today.
Every mockup is an HTML/CSS prototype in Cardboard's skin (`mockups/`), rendered to PNG (`after/`) at the panel's real
widths: 384 px (the default) and 300 px (the minimum). Full-editor mockups are 1522 × 810 CSS px. That is the laptop's
1920 × 1020 window at 125 %, plus the title bar.

A second designer critiqued a first draft independently (`CRITIQUE.md`). §12 lists what changed because of it and
what didn't, and why.

## 0. What this answers

The person who uses it said three things:

1. *"I don't like the history panel at all for the viewing diff portion. This doesn't feel intuitive to me at all."*
   Watch the changes shows coloured blocks, a Before/After switch, "10 unchanged shots", "Section 1 of 1" and "Shown in
   the player, read-only". It never says in words **what changed** or **where**.
2. *"I don't want banners like read only banner unnecessarily."* The "Previewing … · Read-only · Return to current to
   edit" card sits over the video. It appears whenever the editor shows anything but the person's edit, and often after
   a click that never asked for that: a row opened in History, a side in Watch, a conflict card's Preview.
3. *"The user must always know which cut they're on"*, and what they're looking at relative to their own work. Today
   the cut's name is only inside the History panel.

The redesign makes one change of stance. **Reading what changed happens in words, inside the panel, and never takes
over the editor. Showing another version on the stage is a deliberate step ("Play", "See it"). It is marked quietly,
where the eyes already are, and never with a lock that surprises.**

## 1. The mental model, for a video editor

> **Every change is kept.** Each change you or an agent makes is saved as a version, like an undo history that never
> runs out, with who made it. **Your project has cuts**: parallel versions of the edit, like "Main cut" and "30s cut".
> You're always working on one, and its name is always at the top of the window. Agents work on the cut you're on.
> **You can look back** at any version and play what changed, without losing your place: Esc brings you straight back to
> your edit. **Nothing is lost**: restoring an old version adds it as your newest version, and Ctrl+Z undoes that too.
> When an agent or a teammate changed the same thing you did, **a card asks which one to keep.**

## 2. Five rules the design keeps

1. **Your edit is home.**
   - The editor shows your edit of the current cut unless you asked to see something else ("viewing").
   - While viewing, three things say so, all with one label: the title-bar chip, a thin blue frame round the stage and
     the timeline, and the row in History.
   - Esc, or any ✕ on those, brings you back.
   - Closing History brings you back too.
2. **Read first, play second.** "What changed" is a list of sentences in the panel: the clip by its name, where it is
   in the edit (0:12), and who did it. Playing it on the stage is a button (▶, Play all, See it), never a side effect of
   another click.
3. **Every button says what will happen.** "Fold in 3 changes", "Keep Claude Code's", "Restore this version…".
   Anything that changes your edit is either undoable and confirmed by a toast with Undo, or explained in one line
   before you press it.
4. **One way to show a change, everywhere.** History's version card, the Changes view, the Fold dialog, conflict cards
   and toasts use the same change row: *time in the edit · the kind of clip · what happened · who*. They also use the
   same sentences, from one `describe` table.
5. **Plain words, and two kinds of time.**
   - Authors are You, a teammate's name, Director, Claude Code or Codex. A model's name only goes in a tooltip.
   - There are never ids, hashes, tool or system names, "shots", "sections", "read-only" or "checkpoint".
   - **Positions in the edit** are timecodes (`0:06`). **Moments in the day** always carry am/pm (`12:20 pm`), or
     "yesterday at 4:10 pm". A bare `12:20` beside a `0:06` reads as twelve minutes twenty.
   - A version is named by what it is: its name ("Sent to client"), an agent's prompt ("Director's “Add captions…”"),
     or "your edit from 12:41 pm".
   - Things are counted in **changes**. "Version" is used only for a day's count when the day is folded.

## 3. Where things live (information architecture)

| Place | What lives there | Role |
|---|---|---|
| **Title bar** (Cardboard's tab strip, our existing hook) | **Cut chip** `✂ Main cut ⌄`, on every project tab; another cut has its own colour dot. It opens the cuts menu. While viewing it grows a second part, `👁 Director's “Add captions…” ✕`. Then the **History** icon (stack of layers, Ctrl+Shift+H) and the **Share** icon, with the people here as small avatars and a status dot when offline or sending | Primary: where you are |
| **Side panel** (beside the chat, as today) | Two tabs, **History** and **Comments**. History holds the cut bar (cut and filter), the version list, each version's card (what it changed, and how far your edit has moved on since), and the **Changes** view in place of the list | Primary: looking back |
| **Stage layer** (over the preview, as today) | The viewing **frame** (2 px, blue; its label tab appears only when History's list isn't on screen). Also the **conflict card** (one at a time, bottom-right), **toasts** with Undo (bottom-centre), **Offline · N changes not sent yet** (bottom-left, only while true), and **footage still arriving** (top-left, closable) | Secondary: only when it matters |
| **Dialogs** (Cardboard's dialog look) | **Fold in changes** (from a cut, into a cut). **Share** (from the Share icon). **Join a shared project** (on the Dashboard, as today) | On demand |

What goes away:
- the Share **tab** (it becomes the dialog);
- the Compare card (it becomes the Changes view, and each old version's "since this" line);
- Watch the changes' strips, Before/After switch, section counter and step buttons (they become ▶ on each change,
  Play all, and hold-to-see Before);
- the preview banner (it becomes the chip, the frame and the row mark);
- the All / Named / Agent turns bar (it becomes a filter menu, with a removable chip while it's on);
- the "Checkpoint" badge.

![default](after/editor-default.png)
*The editor with History open: the cut in the title bar, the newest version marked **Now**, and Claude Code's turn open
to show its 4 changes. Its Play all runs on your own edit, so nothing is "viewed".*

## 4. Always knowing where you are

### 4.1 The cut chip

- It sits in the title bar, before Cardboard's `16:9 ⌄`, in the same chip style, with a hairline border.
  - Main cut shows the scissors.
  - Every other cut shows its own colour dot, which also marks it in the cuts menu and the History cut bar. A glance
    tells "Main cut" from "30s cut".
  - A long name is cut off at 220 px (150 px below 1180 px) and shown whole in its tooltip.
- A click opens the **cuts menu** under it. It lists every cut with who changed it last and when, and teammates' cuts
  under **From teammates**, marked **View only**. Then *New cut from your edit*, *Fold in changes from a cut…*,
  *Rename*, *Open History*, and one quiet line: **"Agents work on the cut you're on."** That line is the one fact
  about cuts that surprises people.
- It shows on every project tab with Carton on, even with one cut. It costs 120 px, and it teaches that cuts exist where
  people look for project settings, next to the aspect ratio.
- **Optional, behind the same new timeline hook as the frame:** the cut's name and dot at the right of the timeline's
  toolbar, next to the work (`after/editor-other-cut.png`).

![title bar](after/titlebar-default.png)
![other cut](after/titlebar-other-cut.png)
![cuts menu](after/titlebar-cuts-menu.png)

### 4.2 Viewing: one state, one label, three quiet marks

Viewing is the only state in which the editor shows something other than your edit. You get there **only** by one of
these:
- **Play all** or a change's **▶** on a version that isn't the newest;
- holding **Before**;
- a conflict card's **See it**;
- a comment's **See it as it was**;
- picking a **teammate's cut**.

A click on a row, opening its card, and the Changes view never take you there.

| Mark | What it shows | Leaves it |
|---|---|---|
| Title bar chip | Its second part: `👁 Director's “Add captions…” ✕` (or `Before Director's “Add captions…”`, `Leo's Main cut`, `Claude Code's “Interview B”`) | its ✕ |
| Stage and timeline | A 2 px blue frame round both (the timeline's half needs the new hook, PLAN 1.5); the clip colours on the timeline are muted | Esc |
| History row | The row being viewed: a blue edge and `👁 Viewing ✕` in its time column | its ✕ |
| Frame label | **Only when History's list isn't on screen** (a conflict card's See it, Comments' See it as it was, a narrow window): a small tab on the frame's top-left corner with the same label and ✕ | its ✕ |

- The label is built in one place, so the chip, the row and the frame never disagree.
- Esc anywhere in the editor brings you back, unless a menu, a dialog or the editor's own Esc takes it first, as
  today. So do closing the History panel and switching project tab.
- "Back" means the newest version of your cut, with the playhead where it was before you looked. That part works today
  and stays.
- **Play doesn't select clips.** Cardboard's own Esc clears a selection first, so a selected clip would swallow the
  first Esc.

![viewing](after/editor-viewing.png)
*Play all on Director's older turn. The chip, the frame and the row say so with one label; the change being played is
lit, with its progress; nothing sits over the picture.*

### 4.3 An edit tried while viewing gets one line, not a card

Dragging a clip, typing in a title or pressing Delete while viewing changes nothing, and nothing is lost. Instead of
Cardboard's refusal toast ("Previewing an earlier version. Return to current to edit."), the frame pulses once and one
toast line says:

> 👁 You're looking at Director's “Add captions…”. **[Back to my edit]** Esc

There's no Restore in it: a misclick shouldn't be answered with an action that rewrites your edit. It reuses
Cardboard's own refusal path, so every edit path it guards today is still guarded.

![edit attempt](after/editor-edit-attempt.png)

### 4.4 Why not a banner, and why not nothing

The banner's faults:
- where it sat: over the picture;
- what it said: "Read-only", which is negative and a little technical;
- how big it was: two rows, with a white primary button;
- when it came: after clicks that never asked for another version.

It also had a twin in Watch ("Shown in the player, read-only").

Showing nothing would be worse. People watch the video, and a version that isn't theirs must never pass for theirs.
The chip, the frame and the row are the smallest honest signal, and none of them covers the picture.

**Considered and set aside: playing old versions inside the panel** (a mini player or a filmstrip). Cardboard draws
frames only in its own preview, from the editor's store. A second player would run its renderer twice in a 300 px
column: costly, and a second picture that disagrees with the first. Media thumbnails can mark a clip in a list (the
change row's kind chip does that), but they can't show a title's new text or a trim. So the panel shows changes **in
words**, and the editor's own player shows **pictures**, marked as above.

## 5. Looking at changes (replaces Compare and Watch the changes)

### 5.1 The change row: the one way a change is shown

```
0:12  [T+]  Added lower third "Jane Smith, Founder"        ▶
            Claude Code · 12:48 pm
```

- **Time in the edit:** `0:12`, the editor's own time format, where the change is in the newer side. A change with no
  place in the timeline (frame rate, aspect ratio) shows `—`.
- **Kind of clip:** shown in Cardboard's own timeline colours: video blue, title purple, caption violet, audio green,
  image magenta, code pink, project grey. A corner mark shows what happened: green **+** added, red **−** removed, amber
  dot changed or moved.
- **What happened:** one sentence that names the clip by its name or its text, in curly quotes, verb first, in the
  editor's units. Examples: "Trimmed “Intro”, now ends at 0:05", "Moved “Interview B” 2 s later", "Changed caption to
  “in half”". These are listed in §8.
- **Who and when:** shown when the list mixes authors.
- **▶ on hover and on the row being played:** plays that change's spot (§5.3).
- **Clicking the row:** moves the editor's playhead there (on your edit) without playing.
- **Hovering:** lights its tick on the change map.

### 5.2 A version's card: what it did, and how far you've moved on since

A click (or ↑↓ then Enter) on a version **opens its card inline**, under the row, and closes any other. The card holds:

- **On any version but the newest, first:** `Your edit has 7 changes since this · See them`. That answers "relative to
  my work" before anything else. *See them* opens the Changes view (§5.4).
- **The change map:** the edit's length as a slim bar, with a tick per change and the playhead while playing.
- **The first four change rows,** then "and 9 more" (a click shows all).
- **The actions:**
  - Play all;
  - Restore… (or **Undo this turn** on an agent turn: it takes out only that turn's changes);
  - `⋯`: Play its changes, Compare with your edit, Name this version, New cut from this version…, Fold in the rest.

The card's rows are *what this version did*, compared with the one before it. That's the question people ask of a
history ("what did Claude Code just do?").

![expanded](after/history-expanded-384.png) ![expanded 300](after/history-expanded-300.png)
![older](after/history-older-384.png) ![older 300](after/history-older-300.png)

### 5.3 Play and Before

- **▶ on a change** plays its spot with one second either side. **Play all** plays every spot in order and skips the
  rest. Spots that overlap play as one, with all their rows lit. The row being played shows a thin progress line.
  Space pauses. There is no counter and there are no step buttons: the lit row is where you are.
- **On the newest version** (most often: reviewing the agent turn that just finished), Play runs on **your own edit**:
  nothing is viewed, and there is no frame.
- **On an older version,** Play is viewing (§4.2).
- **Before:** **hold** the Before button (or **B** while the list has focus) to see how it was before the change at the
  same moment, and release to come back. A click latches it, for keyboards and screen readers. It replaces the
  Before/After switch and the two strips. The older side is loaded when playing starts, so the flip doesn't wait. PLAN
  4.3 measures it on the laptop before it ships.

![before](after/editor-before.png)
*Before held: "Interview B" is back where it was before Director's turn, at the same moment, and the chip says
"Before Director's “Add captions…”".*

### 5.4 The Changes view: everything between two points

It opens from:
- *See them* on a card;
- *Compare with your edit* (`⋯`);
- Shift+click on a second version.

It replaces the list, with *← History* to go back (Esc works too).

- **The range in words:** "Changes since 12:20 pm", "From Director's “Add captions to the interview” to your edit now",
  "Changes from yesterday at 4:10 pm to 12:20 pm".
- **The rows:** the change map, "7 changes · 0:38", and every change row in timeline order (a virtual list past 50).
- **Who made each change** is resolved for the rows on screen only, so a range of weeks costs no more than a day.
- **At the bottom:** Play all (and Before while playing), and **Restore this version…**.
- **No differences:** "No changes since 12:20 pm. Your edit is the same as Director's “Add captions to the interview”."

![changes](after/changes-384.png) ![changes 300](after/changes-300.png) ![changes playing](after/changes-playing-384.png)

## 6. Every region and state

### 6.1 History

- **Head (40 px):** tabs **History** and **Comments**, and ✕ ("Close (Esc)"). Below 340 px, the tab that isn't open
  shows only its icon. Below 1180 px window width, where the title bar drops Share, a Share icon joins this head.
- **Cut bar:** the cut button (`✂ Main cut ⌄`, the same menu as the chip) and a **filter** icon.
  - The filter menu: *Show: All versions · Named versions · Agent turns · Your changes*. When exactly one clip is
    selected on the timeline it adds *Only “Interview B”*.
  - An active filter shows as a removable chip under the cut bar, so a filtered list never passes for the whole
    history.
  - *Only “clip”* puts the clip's **credits** at the top ("Added by You on Oct 30 · trimmed by Director · moved by You
    at 12:41 pm"). That is how credits finally reach the app.
- **Rows (56 px):** avatar · title · time at the right (always with am/pm), then who · how many changes. The newest row's
  time reads **Now**.
  - **Agent turn:** the agent's own mark (Director: Cardboard's; Claude Code: Claude's; Codex: its own), the prompt as
    the title in quotes, and "Claude Code · 4 changes". A subagent is its agent; its type and the model are in the
    tooltip.
  - **Your changes in a row:** consecutive versions by the same person, no gap over 10 minutes and nothing named between
    them, form one row. It shows the newest sentence, then "You · 6 changes ›". The chevron lists each one, indented,
    in 32 px rows.
  - **Named version:** a yellow bookmark, the name in bold, and "Named by You · 1 change".
  - **Restore:** "Restored the 11:02 am version". **Fold:** "Folded in “30s cut”" · "2 of 3 changes". **Undoing
    either:** "Undid the restore of the 11:02 am version". **A new cut's first version:** "Made this cut from Main cut
    at 12:20 pm".
  - **The start:** one row at the bottom, "Project created · Oct 28" ("History starts here · Oct 28" for an imported
    project). It has no menu. It replaces "Started the cut", "Started the project's history" and the import row.
  - **Not sent yet** (a shared project offline, or a change still on its way): a small pill. Play and Restore wait for
    it.
- **Days:** sticky headers, "Today", "Yesterday", "Sat, Oct 31". A day that's open shows no count. A folded one shows
  "23 versions · 2 named". Past 150 versions every day but today starts folded, as now, and keeps its named versions and
  agent turns visible.
- **An agent working:** a live row on top, with a green ring on the agent's mark, **Working**, its prompt and "2
  changes so far". Under it, one line: **"Keep editing. Director sees your changes when its turn ends."** That line is
  the whole explanation of turn holds.
- **Empty:** "Your edit's history starts here. Every change, yours or an agent's, is saved as a version. Look back at
  any of them, play what changed, or restore one. Nothing is lost."
- **Loading:** three grey row skeletons, at most 300 ms; never "Loading…" text.
- **Scrolled down:** **↑ Newest** docked at the list's bottom edge, covering no row's text.
- **Errors:** an action that failed says so in its card, in words ("Couldn't restore this version. Try again."), with
  the reason in the tooltip for support.
- **Row menu (`⋯`, right-click, Shift+F10):** Play its changes · Compare with your edit · Name this version
  (Rename…) · New cut from this version… · Restore… ("Go back to this version. Later changes stay in History."). A
  partial fold adds *Fold in the rest*. A menu near the bottom opens upwards (as now).

![default 384](after/history-default-384.png) ![default 300](after/history-default-300.png)
![working](after/history-working-384.png) ![menu](after/history-menu-384.png) ![filter](after/history-filter-384.png)
![clip](after/history-clip-384.png) ![many](after/history-many-384.png) ![empty](after/history-empty-384.png)
![offline](after/history-offline-384.png) ![loading](after/history-loading-384.png)
![viewing](after/history-viewing-384.png) ![viewing 300](after/history-viewing-300.png)

### 6.2 Restore, name, new cut: in the card, with their consequences shown

- **Restore…** turns the card's footer into a confirmation:
  - **"Restore your edit from 12:41 pm?"**
  - "Your edit goes back to how it was then. The 4 changes made since are undone. They stay in History, and Ctrl+Z
    brings them back."
  - `[↺ Restore]` `[Cancel]`, and *See the 4* (the Changes view).
  - After it, the toast reads "Restored your edit from 12:41 pm. Later changes are in History. [Undo]".
- **Undo this turn** (agent turns): it takes out only that turn's changes, and later ones stay; its tooltip says so. If
  a later change touched the same thing, a conflict card asks.
- **Name this version:** an inline field in the row ("Sent to client, Monday"). Enter saves; Esc cancels.
- **New cut from this version…:** an inline field in the card, with "You'll switch to it. Main cut stays as it is."
  and `[Make cut]`. Then the toast "You're on “30s Instagram cut” now. Main cut is unchanged. [Switch back to Main
  cut]". Today this switch happens silently.

![restore](after/history-restore-384.png) ![restore 300](after/history-restore-300.png) ![new cut](after/history-newcut-384.png)

### 6.3 Cuts

- **The menu**, from the chip or the panel, as described in §4.1. The current cut is ticked. Each cut shows "Director ·
  2 h ago", so an agent busy on another cut is visible. More than 8 cuts scroll; more than 12 add a search field at the
  top.
- **Switching** is a click. The editor shows that cut's newest version, and the chip and its dot change. The toast
  reads "You're on “30s Instagram cut” now. [Switch back to Main cut]".
- **Switching while an agent works** doesn't happen silently. The item opens in place: "Claude Code is working on Main
  cut, and agents work on the cut you're on." with **[Switch when it finishes]** (primary: the switch waits for the
  turn's end) and **[Switch now]**. A turn without hooks (Codex) counts as finished a minute after its last change, as
  its hold does today.
- **Rename:** an inline field in the menu (as today), with focus back on the chip after.
- **A teammate's cut** (from someone else's copy) is viewing. The cut bar shows its dot and name with a
  `👁 Viewing ✕` pill. History lists its versions, and the two things you can do with it sit above the list: **Fold
  into Main cut…** and **New cut from it**. It has no Restore.

![cuts menu](after/cuts-menu-384.png) ![cuts menu 300](after/cuts-menu-300.png)
![switch during a turn](after/cuts-menu-turn-384.png) ![teammate cut](after/history-teammate-cut-384.png)
![teammate chip](after/titlebar-teammate-cut.png)

### 6.4 Fold in

The word stays: "fold in" is one of the editor words the user chose for Carton (`words.ts`, PLAN §0.1).

- It is a dialog in Cardboard's look. It opens from the cuts menu ("Fold in changes from a cut…"), a teammate's cut, or
  a partial fold's "Fold in the rest".
- **From `[cut ⌄]` into `[cut ⌄]`:** preset from where you came, into the cut you're on by default. Then one line on what
  happens: "Main cut gets what changed on “30s Instagram cut” since it was made from Main cut at 12:20 pm."
- **The change rows,** each with a tick box, and one link that reads Select all or Select none.
  - A change that can't be left out has a grey lock in place of its box: "Can't be left out: it's a setting for the
    whole project".
  - A change left out earlier carries "Left out on Oct 30". Changes left out together are ticked together.
- **Conflicts inline,** in amber: "Both cuts moved “Interview B”. Pick one:"
  - ○ Main cut's: starts at 0:18 · You
  - ○ 30s Instagram cut's: starts at 0:20 · Director
  - The primary button stays disabled until every pick is made, and says why ("Pick one for “Interview B”").
- **Footer:** what is left out ("1 change is left out. It stays on “30s Instagram cut”, and you can fold it in
  later."), "Ctrl+Z takes the whole fold back.", and a counted primary button: **Fold in 3 changes** (or **Fold in the
  rest**).
- **Nothing to fold:** "Main cut already has everything from “Client review”." `[Close]`.
- **Missing base (§13 of Carton's plan):** the plain text it shows today.
- **A teammate still editing the cut you fold from:** the dialog folds what it listed. Anything they add later comes
  next time ("Left out" doesn't apply to it).
- **After:** the toast "Folded 3 changes from “30s Instagram cut” into Main cut. [Undo]", plus **[Switch to Main cut]**
  if it went into a cut you're not on.

![fold all](after/fold-all.png) ![fold some](after/fold-some.png) ![fold conflict](after/fold-conflict.png)
![fold rest](after/fold-rest.png) ![fold nothing](after/fold-nothing.png)

### 6.5 Conflict cards

One card at a time, bottom-right of the stage, 352 px.

- **Title:** the clip, and what both sides did: **"“Interview B”: you and Claude Code both moved it"**. Lead: "Pick the
  one to keep. Until you pick, yours is in the timeline."
- **Sides as a radio group:** **Yours** · 2 min ago "Moved it to start at 0:18", and **Claude Code's** · just now "Moved
  it to start at 0:20". A third, **Both**, appears when they can live side by side ("Leo's music on a new track under
  yours"). The radios **only pick**; your side is picked to begin with.
- **See it** on each side shows that side on the stage. That is viewing, with the frame's label "Claude Code's move of
  “Interview B”" and the chip. See it again, Esc, or deciding brings you back.
- **One primary button names the pick:** **Keep yours** / **Keep Claude Code's** / **Keep both**. No two buttons read
  alike. Two changes by the same person read "Your earlier change · 10:04 am" and "Your later change · 10:05 am", with
  **Keep earlier** / **Keep later**.
- **On timeline** (◎) selects the clip and moves the playhead there, without viewing.
- **Not now** folds the card into the pill **"⚠ 2 conflicts to pick"**, and the card goes to the back of the queue.
  There's no separate "Set aside" list. **1/2 ›** steps through the cards.
- **During an agent turn,** one more line: "Claude Code is still working. Pick now, or when it's done." If it changes
  the same thing again, the card's sides update, and a pick made on the old values asks again ("Claude Code changed it
  again. Pick again.").
- **After:** the toast "Kept Claude Code's move of “Interview B”. [Undo]".
- **While History is open,** or while you're viewing, the stack starts as the pill (as now). The pill's click brings
  you back to your edit and opens the card.

![card](after/conflict-card.png) ![theirs on stage](after/editor-conflict-theirs.png)
![same person](after/conflict-same-person.png) ![both](after/conflict-keep-both.png) ![during turn](after/conflict-during-turn.png)
![pill](after/conflict-pill.png)

### 6.6 Share and people

- **The Share icon** opens the **Share dialog**, which replaces the Share tab. Beside it, the people here show as up to
  three avatars (as now), with an amber dot when you're offline and a white one while changes are sending.
- **Not shared yet:**
  - "Edit together, live, with the whole history. Teammates get preview copies of your video; the originals stay on
    this computer."
  - **Sharing server** ("The address whoever runs your sharing server gave you."). Once used, it's remembered and shows
    as one line with "Change".
  - **Your name**, asked once.
  - `[Share project]`.
  - **Invite code** appears only when the server asks for one.
- **Shared, as the owner:**
  - The status ("Up to date", "Sending 3 changes", "Offline") sits by the title.
  - **People:** **You** (with your name under it, as teammates see it), then each teammate with their role ("Can edit")
    and "Here now · editing captions" or "Last here yesterday", with their agents under them ("Leo's Director ·
    Working on “Add a title card”").
  - **Invite:** the role menu, the link, **Copy link**, and "Anyone with this link can join and edit."
- **Offline:** an amber line, "You're offline. Keep editing: 3 changes are saved here and are sent when you're back."
  The invite is unavailable and says so.
- **Errors** appear at their field, in words. Today's `shareProblem` words stay.
- **Join** stays on the Dashboard and in the empty library. It's one dialog: Invite link, "You'll join as Leo. Change",
  and **[Join and open]**.
- **A joined project's footage:** the notice "2 clips are still on their way from Leo. “interview-b.mp4” and
  “broll-03.mp4” show as Offline until they arrive. Nothing was removed." It closes, and comes back only if more go
  missing.
- **Offline while editing:** the bottom-left chip "Offline · 3 changes not sent yet", shown only while it's true. A
  click opens Share.

![share first](after/share-first.png) ![share owner](after/share-owner.png) ![offline](after/share-offline.png)
![unreachable](after/share-unreachable.png) ![join](after/join-dialog.png) ![title bar shared](after/titlebar-shared.png)
![title bar offline](after/titlebar-offline.png) ![notice and chip](after/stage-live-media.png)

### 6.7 Toasts

Toasts appear bottom-centre on the stage, one at a time, and go after 6 s (they stay while hovered). Each says what
happened and offers the one useful next step.

| After | Toast |
|---|---|
| Restore | ✓ Restored your edit from 12:41 pm. Later changes are in History. **[Undo]** |
| Fold | ✓ Folded 2 changes from “30s cut” into Main cut. **[Undo]** (+ **[Switch to Main cut]** if elsewhere) |
| New cut / switch | ✓ You're on “30s Instagram cut” now. Main cut is unchanged. **[Switch back to Main cut]** |
| Conflict pick | ✓ Kept Claude Code's move of “Interview B”. **[Undo]** |
| Undo this turn | ✓ Took out Claude Code's “Tighten the intro…” (4 changes). **[Undo]** |
| Ctrl+Z of a restore / fold | ↶ Restore undone. / Fold undone. **[Redo]**: this names the undo, which the toolbar's Undo can't |
| An edit tried while viewing | 👁 You're looking at Director's “Add captions…”. **[Back to my edit]** Esc |
| A save that failed | ⚠ Your last change wasn't saved. Do it again, or reopen the project. (role alert, as now) |

![toasts](after/toasts.png)

### 6.8 Comments

Comments stay as they are, with small fixes:
- The second "Comments" heading goes.
- The box says where the comment will be pinned: "Add a comment at 0:13…", with "At the playhead · 0:13".
- Times are shown as the editor shows them (0:06).
- A comment on the whole video reads "Whole video".
- A comment whose moment has changed since says so: "That moment changed since. **See it as it was**". That is viewing
  the version it was written on. Since History's list isn't on screen, the frame's label names it.

![comments](after/comments-384.png) ![comments 300](after/comments-300.png)

## 7. Interactions and keyboard

| Where | Key | Does |
|---|---|---|
| Anywhere in the editor | **Ctrl+Shift+H** | Open or close History (as now) |
| Anywhere, while viewing | **Esc** | Back to your edit (unless a menu, a dialog or the editor's own Esc takes it first, as now) |
| History list | **↑ ↓ Home End** | Move between rows (day headers included) |
| | **Enter** / **→** | Open the row's card, a day, or a group; **←** closes it |
| | **Space** | Play all (the selected version's changes) / pause |
| | **B** (hold) | Before, while playing. The list has focus, so the editor's own B never sees it |
| | **Shift+↑↓**, **Shift+click** | Pick a second version: the Changes view between the two |
| | **F2** | Name the version |
| | **Shift+F10**, menu key, right-click | The row's menu |
| | **Esc** | Close the card → stop viewing → close the panel (innermost first, as now) |
| Card / Changes view | **↓** into the rows, **Enter** | Play that change |
| | **Esc**, **Backspace** | Back to the card / to History |
| Conflict card | **↑ ↓** | Pick a side |
| | **Space** on See it | Show that side; again to stop |
| | **Enter** | Keep the picked side |
| | **Esc** | Not now |
| Fold / Share / Join dialogs | **Tab**, **Esc** | Focus starts on the dialog itself (as Cardboard's Export); Esc closes; focus goes back to what opened it |

**Screen readers:**
- The list is a `listbox`. The open card is a labelled `region` after its row ("Changes in Director's “Add captions…”"),
  reached with Tab.
- Viewing is announced once, through a polite live region ("Looking at Director's “Add captions…”. Esc to go back."),
  and so is the return ("Back to your edit"). Playback never announces each step: only the change a person moves to
  themselves.
- The conflict sides are a `radiogroup`, and the primary button's name follows the pick.
- The change map is `aria-hidden`; the list carries the same information.

## 8. Every word on screen

Words that stay are in `words.ts` today. Below, *new* words, with the old ones they replace.

| Place | Words |
|---|---|
| Title bar chip | the cut's name · while viewing: "Director's “Add captions…”", "Before Director's “Add captions…”", "Leo's Main cut", "Claude Code's “Interview B”", "“Sent to client”", "Your edit from 12:41 pm" · ✕ tooltip "Back to my edit (Esc)" |
| Title bar icons | "Version history (Ctrl+Shift+H)" · "Share" (+ "Leo and Mia are here", "Offline: 3 changes not sent yet") |
| Cuts menu | "Cuts" · "From teammates" · "View only" · "You · now", "Director · 2 h ago", "Claude Code · working now" · "New cut from your edit" · "Fold in changes from a cut…" · "Rename “Main cut”" · "Open History" · "Agents work on the cut you're on." · "Claude Code is working on Main cut, and agents work on the cut you're on." · "Switch when it finishes" / "Switch now" |
| History head | "History" · "Comments" · filter: "Show" · "All versions" · "Named versions" · "Agent turns" · "Your changes" · "Only “Interview B”" + "The clip selected on the timeline" |
| Rows | "Now" · "Viewing" · "Working" · "N changes" · "2 of 3 changes" · "Named by You" · "Not sent yet" (was "Waiting to sync") · "Restored the 11:02 am version" (was "Restored an earlier version") · "Folded in “30s cut”" · "Undid the restore of the 11:02 am version" · "Made this cut from Main cut at 12:20 pm" · "Project created" / "History starts here" (replace "Started the cut", "Started the project's history", "Imported the project") · *removed:* "Checkpoint" |
| Days | "Today" · "Yesterday" · "Sat, Oct 31" · folded: "23 versions · 2 named" · "Newest" (was "Back to now") |
| Agent working | "Working" · "2 changes so far" · "Keep editing. Director sees your changes when its turn ends." |
| Version card | "Your edit has 7 changes since this" · "See them" · "and 9 more" · "Play all" / "Pause" · "Play this change" (▶ tooltip) · "Before" (tooltip "Hold to see how it was before (or press B)") · "Restore…" · "Undo this turn" (tooltip "Takes out only these 4 changes. Later changes stay.") |
| Restore confirm | "Restore your edit from 12:41 pm?" · "Your edit goes back to how it was then. The 4 changes made since are undone. They stay in History, and Ctrl+Z brings them back." · "Restore" · "Cancel" · "See the 4" |
| Name / new cut | "Name this version" · placeholder "Sent to client, Monday" · "New cut from this version" · placeholder "30s Instagram cut" · "You'll switch to it. Main cut stays as it is." · "Make cut" |
| Changes view | "Changes since 12:20 pm" · "From Director's “Add captions to the interview” to your edit now" · "Changes from yesterday at 4:10 pm to 12:20 pm" · "7 changes · 0:38" · "No changes since 12:20 pm" · "Your edit is the same as Director's “Add captions to the interview”." · "Restore this version…" · *removed:* "Watch the changes", "Play changes", "Section 1 of 1", "N unchanged shots", "Shown in the player, read-only", "Preview not available here", "N shots / X s of Y s differ", "When / Who / Clips / Length" |
| Viewing | frame label: "Claude Code's move of “Interview B”", "Director's “Add captions…”" · edit tried: "You're looking at Director's “Add captions…”." + "Back to my edit" · *removed:* "Previewing …", "Read-only", "Return to current to edit", "This is a preview, so edits don't apply here.", Cardboard's "Previewing an earlier version. Return to current to edit." (with Carton on) |
| Conflict card | "“Interview B”: you and Claude Code both moved it" · "Pick the one to keep. Until you pick, yours is in the timeline." · "Yours" / "Claude Code's" / "Leo's" / "Both" · "Your earlier change" / "Your later change" · "See it" / "Seeing it" · "Keep yours" / "Keep Claude Code's" / "Keep both" / "Keep earlier" / "Keep later" · "On timeline" (tooltip "Show on timeline") · "Not now" · "2 conflicts to pick" · "Claude Code is still working. Pick now, or when it's done." · "Claude Code changed it again. Pick again." · *removed:* "Conflict card" (visible), "Showing now", "Preview", "Set aside (1)", "Show again", "Hide conflicts", "N conflict cards waiting" |
| Fold dialog | "Fold in changes" · "From" / "into" · "you're on it" · "Main cut gets what changed on “30s Instagram cut” since it was made from Main cut at 12:20 pm." · "4 changes" · "Select all" / "Select none" · "Can't be left out: it's a setting for the whole project" · "Left out on Oct 30" · "Both cuts moved “Interview B”. Pick one:" · "Pick one for “Interview B”" · "1 change is left out. It stays on “30s Instagram cut”, and you can fold it in later." · "Ctrl+Z takes the whole fold back." · "Fold in 3 changes" · "Fold in the rest" · "Main cut already has everything from “Client review”." |
| Share | "Share “Weekend reel”" · "Edit together, live, with the whole history. Teammates get preview copies of your video; the originals stay on this computer." · "Sharing server" · "Your name" · "Teammates see this beside your changes." · "Share project" · "People" · "You" · "Owner" / "Can edit" / "Can comment" / "Can watch" · "Here now" · "Last here yesterday" · "Invite" · "Copy link" / "Copied" · "Anyone with this link can join and edit." · "Up to date" / "Sending 3 changes" / "Offline" · "You're offline. Keep editing: 3 changes are saved here and are sent when you're back." |
| Join | "Join a shared project" · "Paste the invite link a teammate sent you. The project comes with its history; its footage arrives as their computer sends it." · "Invite link" · "You'll join as Leo. Change" · "Join and open" |
| Stage | "Offline · 3 changes not sent yet" · "2 clips are still on their way from Leo" + "… show as Offline until they arrive. Nothing was removed." · toasts as §6.7 |
| Comments | "Add a comment at 0:13…" · "At the playhead · 0:13" · "Whole video" · "That moment changed since." · "See it as it was" |

**Change sentences.** They come from core `describe`, through `words`. Each is verb first, names the clip, and uses the
editor's units. There is one sentence per kind of change, the same everywhere.

| Today | New |
|---|---|
| Moved 'W6' 7.0 s → 9.0 s | Moved “W6” 2 s later (now starts at 0:09) |
| Trimmed 'Intro' end 6.0 s → 5.0 s | Trimmed “Intro”, now ends at 0:05 |
| Trimmed 'Intro' start … | Trimmed “Intro”, now starts at 0:01 |
| Changed 'W2' font size 100 → 222 | Made “W2” bigger (font size 100 → 222) |
| Changed 'W1' text "Hello" → "Hello world" | Changed “Hello” to “Hello world” |
| Added track 'Text 1', moved 'W6' | Moved “W6” to a new track |
| Restored an earlier version | Restored the 12:41 pm version |
| Folded 'Client review' into 'Main cut': 2 of 3 changes | Folded in “Client review” · 2 of 3 changes |
| (a conflict side) Moved 5.0 s → 7.0 s | Moved it to start at 0:07 |

## 9. Edge cases

- **Export, Ctrl+Z, or a prompt to the Director while viewing:**
  - Export never exports what you're viewing. Opening Export while viewing brings you back to your edit first, with the
    toast "Back to your edit to export it."
  - Ctrl+Z while viewing gets the same one-line toast as an edit tried (§4.3).
  - A prompt goes to the agent as usual. The agent works on your edit of the current cut; its new version appears at the
    top of History while you keep viewing.
- **Partial folds:**
  - The fold's row reads "2 of 3 changes", and its menu has **Fold in the rest**. That opens the dialog with only the
    left-out rows.
  - Changes left out together come in together, with "These were left out together, so they come in together."
  - The dialog never promises "later" when the engine can't keep it.
- **Your own cut changes while you view** (an agent or a teammate writes): the new version appears with **Now**, and
  back takes you to it. This is the existing *stale* logic.
- **A teammate's cut changes while you view it:** History adds its rows live. The stage keeps what you're viewing until
  you press Play again.
- **An agent starts or ends while you're viewing:** the Working row appears or turns into its version at the top of
  History. The chip is unchanged. Nothing interrupts the person.
- **A conflict during an agent turn:** see §6.5. A conflict while viewing waits as the pill; the pill brings you back
  and opens it.
- **Switching cuts during a turn:** see §6.3. "Switch when it finishes" is the default.
- **Footage missing from an old version** (deleted, or a joined project's clip still arriving): Play shows Cardboard's
  own Offline placeholder for that clip, as the editor does. The change row is unaffected.
- **Play that can't load the version** (a very large project, a slow disk): the Play button shows a spinner after
  300 ms. A failure says "Couldn't load this version. Try again." in the card, and the editor stays on your edit.
- **Offline:**
  - Your rows carry "Not sent yet"; Play and Restore on them wait.
  - Share shows the offline line.
  - Folds and restores work here and are sent later.
  - Comments say "Saved here, sent when you're back".
- **Two people restoring at once:** each restore is a new version on top, and the later one wins, as two edits do. If
  they touched the same clips, a conflict card asks.
- **Restoring a version that is "Not sent yet":** Restore waits until it's sent ("Available once it's sent").
- **Read-only roles** (Can comment / Can watch):
  - The cuts menu has no New cut, Rename or Fold.
  - Cards have Play and Compare only.
  - An edit tried says "You can watch and comment on this project, not edit it.", as a toast, not a banner.
- **A version shorter than the playhead:** viewing starts at its end (as now), and the playhead goes back on return.
- **Long cut names and prompts:** cut off with an ellipsis, with the whole text in the tooltip and for screen readers.
  An agent's prompt wraps to two lines in its open card.
- **Many cuts and teammates:** the cuts menu scrolls past 8 and adds a search past 12. Teammates' cuts are grouped
  under their owner ("Leo's Main cut", "Leo's 30s cut").
- **10k+ versions:** the list stays virtual. Groups and days are computed from the same rows (as day groups are now). A
  card describes its changes only when opened. *Only “clip”* needs a per-version index of the clips each version
  touched, written when the version is saved (PLAN 0.8).
- **Narrow windows:**
  - The panel narrows, then becomes the drawer, as now.
  - Below 1180 px the chip shows up to 150 px of the name, and Share moves into History's head.
  - The chip's viewing part keeps its eye and ✕, and shortens its label first.
  - If the drawer is hidden, the frame label shows.

## 10. Mockups: before and after

The "before" images are of two kinds:
- **real-app screenshots** from the Windows laptop audits, in `before/real/` (older builds, marked in `AUDIT.md`);
- **today's components and composition**, rendered with Cardboard's real CSS on mock data, in `before/gallery/`.

The "after" images are in `after/`.

| Region | Before | After |
|---|---|---|
| Watch the changes | `before/real/user-watch-the-changes.png`, `before/gallery/window-watch-384.png`, `before/gallery/watch-initial-300.png` | `after/history-older-384.png`, `after/history-viewing-384.png`, `after/editor-viewing.png`, `after/editor-before.png`, `after/changes-playing-384.png` |
| Preview banner | `before/real/user-preview-card.png`, `before/gallery/window-preview-384.png`, `before/real/p3-preview.png` | `after/editor-viewing.png`, `after/editor-edit-attempt.png`, `after/titlebar-viewing.png` |
| Compare card | `before/real/p3-compare.png`, `before/gallery/history-compare-384.png` | `after/changes-384.png`, `after/changes-300.png`, `after/history-older-300.png` |
| History list | `before/real/w-01-history-open.png`, `before/gallery/history-few-384.png`, `before/gallery/history-few-300.png` | `after/history-default-384.png`, `after/history-default-300.png` |
| Version detail | `before/gallery/history-few-expanded-384.png`, `before/real/i6-show-the-change.png` | `after/history-expanded-384.png`, `after/history-expanded-300.png` |
| Long history | `before/real/44-long-history-top.png`, `before/gallery/history-many-384.png` | `after/history-many-384.png` |
| Row menu, restore | `before/real/03-row-menu.png`, `before/gallery/history-menu-384.png` | `after/history-menu-384.png`, `after/history-restore-384.png`, `after/history-restore-300.png` |
| Filters | `before/real/05-filter-director.png`, `before/gallery/history-filter-turns-empty-384.png` | `after/history-filter-384.png`, `after/history-clip-384.png` |
| New cut | `before/gallery/history-naming-cut-384.png` | `after/history-newcut-384.png` |
| Offline rows | `before/gallery/history-provisional-384.png` | `after/history-offline-384.png` |
| Empty | `before/gallery/history-start-384.png` | `after/history-empty-384.png`, `after/history-empty-300.png` |
| Cuts | `before/real/09-cut-menu-2cuts.png`, `before/gallery/cuts-open-several-384.png` | `after/cuts-menu-384.png`, `after/cuts-menu-300.png`, `after/cuts-menu-turn-384.png`, `after/titlebar-cuts-menu.png` |
| Teammate's cut | `before/gallery/cuts-open-several-300.png` | `after/history-teammate-cut-384.png`, `after/titlebar-teammate-cut.png` |
| Where am I | `before/gallery/titlebar-normal.png`, `before/real/00-tabs.png` | `after/titlebar-default.png`, `after/titlebar-other-cut.png`, `after/editor-other-cut.png`, `after/titlebar-narrow.png` |
| Conflict card | `before/gallery/stage-conflict-one.png`, `before/real/41-card-preview-after.png`, `before/gallery/stage-conflict-self.png` | `after/conflict-card.png`, `after/editor-conflict-theirs.png`, `after/conflict-same-person.png`, `after/conflict-keep-both.png`, `after/conflict-pill.png` |
| Fold in | `before/real/11-fold-dialog-after.png`, `before/gallery/fold-some-384.png`, `before/gallery/fold-conflict-384.png`, `before/gallery/fold-leftout-384.png` | `after/fold-all.png`, `after/fold-some.png`, `after/fold-conflict.png`, `after/fold-rest.png`, `after/fold-nothing.png` |
| Share | `before/gallery/share-empty-384.png`, `before/gallery/share-owner-invite-384.png`, `before/gallery/share-offline-384.png`, `before/gallery/share-unreachable-384.png` | `after/share-first.png`, `after/share-owner.png`, `after/share-offline.png`, `after/share-unreachable.png` |
| Join | `before/gallery/join-form.png`, `before/gallery/join-joined.png` | `after/join-dialog.png` |
| Agent working | none: nothing is shown today | `after/history-working-384.png`, `after/conflict-during-turn.png` |
| Toasts | `before/gallery/stage-toast-restore.png`, `before/gallery/stage-toast-confirm.png` | `after/toasts.png`, `after/editor-toast-offline.png` |
| Stage status | `before/gallery/stage-live-offline.png`, `before/gallery/stage-media-waiting-many.png` | `after/stage-live-media.png` |
| Comments | `before/gallery/comments-some-384.png`, `before/gallery/comments-empty-300.png` | `after/comments-384.png`, `after/comments-300.png` |
| Title bar | `before/gallery/titlebar-peers.png`, `before/gallery/titlebar-offline.png` | `after/titlebar-shared.png`, `after/titlebar-offline.png` |

## 11. What the design needs underneath

- **Structured changes** (`ui.changes(a, b)`): one entry per change, with `{ text, kind, clip, itemId?, at?, end?,
  author?, when? }`. Today `compare()` returns only strings. Authors across a long range are resolved lazily, for the
  rows on screen.
- **One sentence table** in core `describe` for every kind of change (§8).
- **Grouping** of a person's consecutive changes in `history-groups.ts`, next to the day groups.
- **A per-version index of the clips touched**, written at save time. It is needed for *Only “clip”* at 10k versions.
  Without it, ship the clip filter for the last day only.
- **Two new hooks:**
  1. **The cut chip in the tab strip.** `strip-buttons.js` already renders our icons there; the chip needs the cut and
     viewing label in the panel report. The title bar is a separate page from the editor, so its menu is drawn by the
     editor's page under the title bar, and focus and keys stay in that page. **Version 1:** the chip's click opens
     History with its cuts menu open. The popover under the chip comes second, after a prototype.
  2. **A `data-carton-viewing` attribute on the timeline's wrapper,** for the frame and the muted clips, and optionally
     the cut label. If its anchor breaks in a later Cardboard, the stage frame and the chip still carry the state.
- **The edit-attempt toast** reuses Cardboard's own refusal path (the `Tm` guard and its message). Only the words and
  the place change, so every edit path it guards today is still guarded.

## 12. The independent critique: what changed, and what didn't

`CRITIQUE.md` (a second designer, from the first draft) scored the draft at 5–7.5 per region.

**Taken:**
- Clock times with am/pm, and versions named by name or prompt.
- Viewing down to three marks with one label. The panel's viewing bar is gone, and the frame label shows only when
  History's list isn't visible.
- The edit-attempt card became a one-line toast, without Restore.
- "Your edit has N changes since this" on older versions.
- ▶ per change and Play all, with no counter and no step buttons.
- Before as hold-to-peek, loaded ahead and measured.
- Conflict radios only pick; See it per side.
- One counting noun ("changes") and one sentence table.
- A colour dot for every cut but Main, and the optional timeline label.
- Filter chip, and "Newest" docked at the bottom.
- The lock for changes that can't be left out.
- "Switch when it finishes" as the default during a turn.
- Export, Ctrl+Z and prompts while viewing; missing footage; Play loading and failing; many cuts; announcements.
- "Not sent yet"; "You" in Share.
- The cuts menu built across two pages ships as version 1 (open History's menu) before the popover.

**Not taken, and why:**
- **"Fold in" → "Bring in changes".** "Fold in" is one of the words the user chose for Carton (`words.ts` says so).
  Changing it is the user's call, not a designer's. It's raised in the report.
- **Play on an old version opening the comparison with your edit.** Playing what a version did is the question the
  card answers. "Your edit has N changes since this · See them" now answers the other one on the same card, one click
  away.
- **Anchoring the conflict card over the timeline near its clip.** The stage layer is our only layer there. Drawing
  over the timeline means a new overlay hook, with time→x mapping, on a minified anchor. The card stays in the stage's
  corner, compact. "On timeline" does the pointing.
- **Labelling agent turns in the chat with their cut.** The chat is Cardboard's own bundle. It's worth doing, but as its
  own change, after this one.
