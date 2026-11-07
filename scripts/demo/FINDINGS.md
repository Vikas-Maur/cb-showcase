# A remote teammate in a shared Cardboard project, from the Linux box: findings

For the screen-recorded demo: the user runs the real Cardboard on Windows with a project shared through our sharing
server (`https://cardboard-showcase.vikasmaur10.workers.dev`); a participant from this box joins it and "talks" by
editing the timeline (titles, spoken lines); Cardboard's own agent on the laptop finds it, answers through the timeline,
and uses Carton's cuts to keep the conversation out of the person's view.

Everything here was run on 2026-11-07 against the build installed on the laptop, **0c498b2b** (`feat/carton-ux`),
staged from Cardboard 1.4.0's bundles with every Windows and Carton patch (`scripts/demo/peer setup`, the same staging
the sync tests use). Each participant is Cardboard's real library worker under Node with its own app data; `cb` is
Cardboard's real CLI on that participant's library. Nothing in Carton or Cardboard was changed for any of this: the rig
is tooling only (`scripts/demo/`). How to run it: [README.md](README.md).

Outputs below are copied from real runs (logs and shots: §7). Timings are for planning cues, measured on this 4-core
box with both participants on it; the laptop adds its own network leg.

## 0. The short answers

- **Joining**: the Share dialog's invite link (`https://cardboard-showcase.vikasmaur10.workers.dev/#join=…`), then
  `peer join "<link>" --name "Sam"`. The laptop's Share lists "Sam · Here now · editing · Can edit"; the title bar shows
  an "S" avatar ("Sam is here"). Or as someone's agent: `--agent Director` lists "Sam's Director · Working on …".
- **Talking**: `peer say "<words>" --at 3.5 --for 3 --style chat` (a title), `peer speak "<words>" --at 7` (Piper speech,
  then an audio clip), `peer edit`, `peer clear`. Each is one save, as the editor makes it.
- **Being found**: the laptop's agent sees the teammate in `cb activity`, `cb history` (with `--find`), `cb credits`,
  `cb compare`, by name ("Sam", "Leo's Director") and by computer (`cb history --json`: `local:<user>@<host>`).
  Presence ("who is here now") is not in `cb` at all: only the app's Share dialog and title bar show it.
- **Hiding** (all live while shared, verified, race-tested): `cb cut new "<name>" --from <version before the chat>`,
  then `cb fold <the shared cut's version, as printed> --into <that cut> --reject …` (the teammate's real work in; the
  chat's tracks, clips and media out), a check with `cb compare`, and `cb cut switch` last: the person's editor shows a
  cut of their own without the chat (§4.1: with a line from the remote landing mid-hide, 0 leaks in 5 runs; the first
  cross-machine rehearsal's order leaked). `cb restore <version> --clip "<clip>" --remove` takes one clip out of the
  shared cut for everyone. **After the switch the
  conversation is one way**: the remote keeps writing on Main and the agent reads it (`cb history --cut "Main cut"`,
  `cb compare`), but nothing the agent can run writes to Main while the editor shows another cut (§4.2).
- **Voice**: `cb generate voice` would run on this box (plain HTTPS to cardboard.ai with a bearer token,
  `CARDBOARD_TOKEN`), but needs the user's account token; not tried, by instruction. The fallback is Piper on this box
  (4 English voices installed), `peer speak` or `node scripts/demo/tts.js`.
- **Found while rehearsing, Carton bugs (not the rig's)**: (1) a sound imported the way the editor imports a dropped file
  can make the importer's computer delete the next change a teammate makes (§6.1); (2) a teammate's new sound can't be
  streamed for about 2 s after its media entry arrives (§6.2); (3) on a cut that isn't shared, Share's status is stale
  (§4.3). The rig works around (1) and (2).

## 1. Joining

**From the laptop**: Share (title-bar icon) → the server is filled in → "Teammates see you as …" → Share project →
Invite, "Can edit", Copy link. The link is `https://cardboard-showcase.vikasmaur10.workers.dev/#join=<project id>.<invite>`;
its invite stops working after 7 days (the token's own `exp`: `iat 1794022084, exp 1794626884`, the server's default
`inviteTtlMs`, `carton/packages/server/src/hmac-auth.ts:133`).

**From this box**:

```
$ peer join "$LINK" --name "Sam"
Joined “Demo rehearsal” as Sam in 0.25 s. Sync: Up to date. Here: Vikas
$ peer status
Sam: shown as Sam · Editing
  “Demo rehearsal”: 1 clips, 12.0 s; on cut Main cut; sync Up to date
  here: Vikas · Editing [on Main cut]
  cuts: *Main cut (shared)
```

`join` makes a participant folder (`gfv-scratch/carton/demo/peer-sam/`: its home, app data, library, `peer.json`,
`daemon.log`, `watch.jsonl`) and starts its daemon: Cardboard's library worker with Carton, through the worker harness
the sync tests use, kept running, with a control socket. The join itself is the worker's own `carton.liveJoin`, exactly
what the app's "Join a shared project" dialog calls.

**Presence**: the worker sends it as the app's pages do (`carton.livePresence`). The daemon says it again every 10 s
(the other side fades someone it hasn't heard from in 30 s: `scripts/carton/sync/live.js` `PEER_IDLE_MS`; the live
server drops a silent connection's presence after 120 s, `PRESENCE_TIMEOUT_MS`), and once more as soon as sync is up to
date (a presence sent while the connection is still coming up goes nowhere). `peer presence "Editing captions"`,
`--idle` (listed, faded: "Here, not editing"), `--gone`.

**How the laptop shows it** (Cardboard's real pages in headless Chromium, driven by the app side's real worker, §7):

- Share dialog: `You · Vikas · here now · Owner` / `S  Sam · Here now · editing · Can edit`. The second line is
  "Here now · " plus the activity, lower-cased; the role comes from the invite.
- Title bar: up to three avatars (initials, the teammate's colour; faded when idle) and the tooltip "Sam is here"
  (`scripts/carton/ui.js` `hereWords`: people by first name, an agent by its product name).
- History: the teammate's rows under their name ("Sam · 2 changes"), the person's own as "You".

**As a person's agent** (`--agent <label>`): the participant's Carton handle is opened as that agent and its presence is
sent with no person attached, so the laptop lists it as theirs. This is done inside the participant's own process only
(an extension registered there through the facade's own `extend()`, whose open options override the sync extension's);
Carton and Cardboard are unchanged. Real run:

```
$ peer join "$LINK" --name "Leo Park" --agent "Claude Code" --activity "Working on “Say hi”" --machine leos-laptop
Joined “Demo rehearsal” as Leo's Claude Code in 0.16 s.
(the app's side) here: Sam · Editing [on Main cut], Leo Park's Claude Code · Working on “Say hi” [on Main cut]
(the app's cb history --json) {"id":"claude-code/leo-park","name":"Claude Code","kind":"agent","group":"local:leo-park@leos-laptop","owner":{"id":"Leo-Park","name":"Leo Park"}}
```

The app words it "Leo's Claude Code" (first name: `actorLabel`), with the activity as its line ("Working on “Say hi”"),
listed under Leo when Leo is also here, else on its own; the title-bar tooltip says "Claude Code is here".

**Name and label choices**:

| What | Choices | Shown as |
|---|---|---|
| `--name` | any words | the account id is made from it (`host.accountId`: letters, digits, `._~-`); Share shows the whole name, History and the title bar the first name |
| `--agent` | `Director`, `"Claude Code"`, `Codex`, `Gemini`, `Cursor`, or any one word (letters, digits, `.`, `-`) | "<first name>'s <label>"; Director, Claude Code and Codex get their own mark, any other label the generic agent mark (`agentOf`) |
| `--activity` | any words | person: "Here now · <words>"; agent: the words as they are ("Working on “Say hi”") |
| `--machine` | a computer name | the author's computer in `cb history --json` (`group`), which otherwise reads `local:ubuntu@ip-172-31-19-157`, this EC2 box. The app never shows it; a `--json` reading agent does. Keep it as a clue, or set it. |

Edits in agent mode are credited to the agent (`claude-code/leo-park`, "Leo's Claude Code" in History); a sound's
"Linked … for sharing" version is credited to the person, as Carton records any share.

## 2. Talking

What each command does: one save through the participant's worker, as the editor saves (`projects.updateScoped` with
the version it was made on as its base), so Carton records it as the person's edit (or the agent's, `--agent`) and sends
it change by change. A title is Cardboard's own shape for one, copied from what `cb source apply` writes for a `<text>`
(an item and its text entry). A sound is imported by Cardboard's own `cb media add` (handed to the worker, the lease
holder), shared to the server, and then placed as an audio clip.

**Credited to the participant, everywhere**: that `cb media add` runs as the person (`CARDBOARD_ACTOR=person`, which
Carton's store bridge maps to the app's own person, as it does the editor's saves), or as the agent with `--agent`. Run
with no actor, `cb` is a nameless terminal writer: in the first cross-machine rehearsal the laptop's `cb history` showed
Sam's spoken line's import as "Terminal" (`terminal:ubuntu@ip-172-31-19-157`, owner Sam). Before and after, through the
app's real History panel (`shots.js`, laptop's 125%): the panel showed "Added media “Can we talk here.wav” · Sam · 2
changes" both times (it already tells a nameless writer as the person behind it); `cb history` said `main@7 Terminal`
before and `main@7 Sam` (`"kind":"human"`) after, so the agent reading it, and its chat if that is on screen, say Sam
too (shots `gfv-scratch/carton/demo/shots/speak-credit-before/` and `…/speak-credit-after/`, `1-main-cut-history.png`).

```
peer say "Psst. Is anyone else in here?" --at 3.5 --for 3 --style chat [--name "<timeline label>"] [--track Talk]
peer say "Weekend reel" --at 0 --for 3 --style title --track Titles --name "Opening title"
peer speak "I'm Sam's editor, working from far away. Can we talk here?" --at 9.5 --voice ryan --name "Can we talk here?"
peer speak --file line.mp3 --at 9.5 --name "…"          # a recording made elsewhere (ElevenLabs on the laptop)
peer edit "Psst" --text "Hello? Anyone there?" [--at] [--for] [--style]
peer clear "Psst"          # a clip's name, words of it, or its id; `all-mine`: every clip this participant added
```

- Looks (`--style`, Cardboard's text props): `title` (96 px bold, white, shadow, centred), `chat` (a dark bubble, lower
  left), `reply` (a light bubble, lower right), `caption` (bold, outlined, bottom), `whisper` (small italic, top);
  `--color`, `--size`, `--y` (pixels from the centre) adjust one.
- Every title carries `zIndex: 100` ("zIndex overrides track order", `cb docs source`), so it draws over full-frame
  footage whatever its track's place (shot `1-main-cut-editor.png`). A track the rig makes goes below the others and no
  other track is touched: making a title track the top one renumbers every track, and in the live rehearsal a concurrent
  `cb source apply` from the agent, made from an older print, merged its own orders back and left "Titles" under
  "Footage".
- The timeline label is `--name`, else the words (cut at 40 characters). A spoken line's file is named after its first
  words ("I'm Sam's editor working from far away.wav"): that name shows in the media bin and in History's "Added media"
  row, so it is never an id.
- `clear` also removes the title's text entry, and the sound's media entry when this participant brought it in, so
  nothing of the chat stays in the media bin.

**For the laptop's agent**, the same with Cardboard's own `cb` (what `rehearsal-cues.yaml`'s `agent_say` runs): its own
view, a `<text>` added, applied:

```
cb source print "Demo rehearsal" --view chat        # prints .scratch/views/<its view>.tsx at head
# add to the "Talk" track:
#   <text name={"Who are you?"} start={6.5} end={9.5} textContent={"I'm the Director in this app. Who are you?"} zIndex={100} fontSize={52} … />
cb source apply "Demo rehearsal" <that file>
```

or `cb generate voice "Demo rehearsal" "<text>" --start 9.5 --track Voice --name "…"` for a spoken answer (§5).

**How fast it arrives** (`scripts/demo/bench-latency.js`: the remote adds a title, changes its words, removes it, and
every few rounds speaks a line; timed from just before the remote's call on this box's one clock: *seen* = the app's
worker has the change, *shown* = the app's project.json shows it, which is when the editor's pages are told; for a
sound, whether the app's worker could stream it when its clip arrived):

Every number below was checked by an independent re-run (a separate agent, its own participants and server, 3 runs of
10 rounds locally and 1 of 6 on the live server; its files are in `gfv-scratch/carton/demo-verify/`). Medians:

| | Local server (127.0.0.1) | Live server |
|---|---|---|
| a title added, changed or removed: *seen* | about 8 ms | about 90 ms |
| the same: *shown* | about 60 ms | about 150 ms (measured with the rig's former 50 ms read of the worker's posts, which added 35–40 ms locally) |
| a spoken line: its clip on the other side | about 3.5 s after the call | about 3.7 s |
| … streamable when its clip arrived | 15 of 15 (verifier), 8 of 8 (ours) | 3 of 3, both runs |

- A spoken line's 3.5 s is mostly on purpose: `cb media add` (about 1.2 s), then a fixed 2.3 s wait (`DEMO_REASK_MS`)
  before the clip goes on, so the other side can play it the moment it appears (§6.2). Without that wait the clip came
  about 1.2 s after the call, and the sound became playable about 3.3 s after it in most runs and about 5.2 s in about a
  third.
- From this box the Cloudflare edge is about 1 ms away: the live server's 90 ms is mostly the server's own time. The
  laptop adds its own network leg.
- `cb` from the agent's side: about 0.6–0.7 s a command; the rehearsal's `agent_say` (print a view, add a title,
  apply) about 1.7 s; `agent_hide` (cut new, switch, fold) about 6.5 s.

## 3. Being found

What the laptop's agent (Claude Code in the app, using `cb`) can see of the remote teammate, from the app side's real
`cb` during the rehearsal (`cb` as the Director, `CARDBOARD_ACTOR=director/…`):

```
$ cb activity "Demo rehearsal"
WHO       CHANGES  LAST      VERSIONS
Sam       2        just now  @4…@6
Vikas     2        just now  @1…@5
Terminal  2        just now  @2…@3

$ cb history "Demo rehearsal" --find anyone
The clip “Psst. Is anyone else in here?”: added by Sam today at 4:05 am.
1 version on Main cut mentions “anyone” (newest first):
  today 4:05 am  Sam  Added track 'Talk' and title 'Psst. Is anyone else in here?' · “Psst. Is anyone else in here?” was 0:04–0:07 here  main@6

$ cb credits "Demo rehearsal" "Hi! Anyone there?"
4756b0fc-03c6-4f3d-95e7-3bc9f6597b27: last changed by Sam

$ cb compare "Demo rehearsal" main@4
- Added track 'Talk'
- Added track 'Voice'
- Added title 'Hi! Anyone there?' on 'Talk' at 1.0 s
- Added audio 'Hi. I can see you're editing too.' on 'Voice' at 4.0 s
- Added media 'line-1794022098186.wav'

$ cb history "Demo rehearsal" --json --limit 1     (the author, as Carton tells it)
"by": {"id": "Sam", "kind": "human", "group": "local:ubuntu@ip-172-31-19-157", "app": true, "name": "Sam"}
```

- `history`, `activity`, `credits`, `compare` and `conflicts` all work on a shared cut and name the teammate. In `--json`
  a teammate's agent comes with its `owner` (`{"id":"Leo-Park","name":"Leo Park"}`) and every author with its computer
  (`group`). "Terminal" and "app" in the text output are the person's own writers with no name of their own (a `cb`
  with no actor, the worker's bookkeeping); the app's History shows them as the person (`isPersonsWriter`).
- Carton's MCP tools (`carton/packages/cli-mcp/src/mcp.ts`) give the same through `cb mcp`: `timeline_history`,
  `timeline_find`, `timeline_landmarks`, `timeline_credits`, `timeline_compare`, `timeline_cuts`, `timeline_fold`,
  `timeline_restore_clip`, `timeline_publish`, `undo_timeline`.
- **Not visible to `cb`**: who is here now. Presence is only in the worker's Share status (the app's Share dialog and
  title bar); no `cb` command or MCP tool reads it. An agent "finds" the teammate by their edits.
- **During a Director turn**, `timeline.tsx` is frozen against everyone else's edits (H8): a teammate's title made
  mid-turn isn't in that file until the turn ends. The agent sees it with `cb history`, `cb compare <version>`, or a
  fresh `cb source print --view <name>` (always printed at head).

So the agent finds the remote participant with: `cb activity` (someone other than the person is editing) → `cb history
--limit 5` or `--find <words>` (what they did, when, under what name) → `cb compare <version before>` (the words of
their titles) → `cb history --json` (their computer, `local:<user>@<host>`). A recipe for the prompt: "every turn, run
`cb history --limit 5`; anything by someone who isn't the person is the remote teammate".

## 4. Hiding

All of these were run with the app side's real `cb` while the project was shared and the remote was editing, in the
local rehearsals and on the live server (logs, §7).

### 4.1 The hide, step by step (works; the recipe for the laptop's agent)

The person's editor goes to a cut of their own, made from the version before the chat began, with the teammate's other
work folded in and nothing of the chat. In this order (`cues.js` `agentHide` does exactly this with Cardboard's `cb`):

```
$ cb cut list "Demo rehearsal"                                   # 0. the name must be free: "Vikas's cut"
$ cb cut new "Demo rehearsal" "Vikas's cut" --from main@4        # 1. from the version before the chat; the editor stays
New cut "Vikas's cut" (df2006ff)                                 #    from here on, the cut by its id: df2006ff
$ cb source print "Demo rehearsal" --view hide                   # 2. the shared cut now, at one exact version (its header):
// cardboard:rev Main cut@316~… b:…                              #    "Main cut@316": what to keep out comes from this print
$ cb fold "Demo rehearsal" main@316 --into df2006ff \            # 3. exactly that version, never the cut's moving head
    --reject tracks/<Talk> --reject tracks/<Voice> \
    --reject timelineItems/<every clip on them> --reject media/<their media> --reject media/<the teammate's unused media>
Folded in (kept out: …): confirmed df2006ff@2
$ cb compare "Demo rehearsal" main@4 df2006ff                    # 4. nothing of the chat came in (see below)
$ cb cut switch "Demo rehearsal" df2006ff                        # 5. last: the editor shows it; the teammate sees the person leave
Now on "Vikas's cut"
```

- **What to keep out**, all from the one print of step 2 (plus project.json, read right after it, for a title's text
  entry: the print names only file media): the chat's tracks; every clip on them (an id on the line after `<text`,
  `<audio`); each clip's media (an `<audio>`'s `src` is a name the header maps to an id; a `<text>`'s entry is its
  `mediaItemId` in project.json); and the teammate's media no clip uses yet (a sound whose clip isn't placed: `cb compare
  <version before> <that version>` lists it as "Added media '…'"). Keep all of them out: a rejected track with one of its
  clips not rejected makes the fold refuse ("Not folded in: 2 cards", each "(parent)", nothing saved); rejecting only the
  clips leaves empty "Talk" and "Voice" tracks in the person's cut and the chat's media in the bin.
- **Why that order** (found in the first cross-machine rehearsal): the reject list was read at 12:13:00.46, the cut was
  made and switched to, and the fold of "Main cut" ran at 12:13:04.15. Sam's "Gone. They can't see us now." landed at
  12:13:04.122, in between, because Sam waits for "Vikas left" and that fires at the switch; the fold took Main's head
  with it, and the line came into the person's cut on a made-up "Missing track" (History "Folded in “Main cut” · 1 of 8
  changes", the cut 0:12 → 0:19). Now the fold takes the exact printed version (a line landing after it is simply not in
  it), and the switch, which the teammate sees, comes after the fold.
- **The check, step 4**: compared with the version before the chat, the person's cut may only have gained tracks, clips
  and media from outside the chat in the folded version. A line naming a chat track, "… on another track" (`cb compare`'s
  words for a clip whose track isn't there; History says "Missing track"), or any other clip or media is a leak. Then,
  after the switch, each such clip is taken out at once with `cb restore "Demo rehearsal" main@4 --clip <id> --remove`
  ("Took out “Gone…”: it wasn't in the version from …"), and the agent says so. `cb` writes only to the current cut, so
  this shows for a moment; with the order above it never happened (below).
- **A name used twice**: Carton lets two cuts share a name, and `--into <name>`, `cut switch <name>` then mean the first
  one (`cli-mcp` `refs.ts` `resolveCut`). A second hide under the same name folded into the old cut (its history clashed:
  the fold refused). So step 0, and the cut by its id after step 1.
- **The version before the chat**: walk `cb history --cut "Main cut" --limit 1000` from the oldest, `cb compare
  <previous> <version>` for each, and take the one before the first that touches the chat's tracks (`versionBefore`). The
  whole history: with `--limit 200` the walk began mid-chat once Main had more versions, and the person's cut would have
  been made from a version with chat in it.
- **Long reject lists**: one `--reject` per record; with a few dozen chat clips it is short, but Windows caps a command
  line at 32,767 characters (about 600 `--reject`s): a very long chat would need a fold in parts.

**The race, rehearsed** (`scripts/demo/race-hide.js`, local server, both participants on this box): while the agent
hides the chat, Sam keeps talking from its own process: chat lines and a spoken line spread over the hide, one more line
landed exactly between the agent's print and its fold, and a line the moment Vikas leaves. Then the person's cut is read
on its own from the app side's worker: no clip on a chat track or on a track the cut doesn't have, no chat track, none
of the chat's media, and Sam's real work from before the fold there.

| The hide | Runs | Leaked into the person's cut | Log |
|---|---|---|---|
| the laptop's order (switch, then fold Main's head) | 2 | 2 clips each run ("Between line", and "Gone" sent at "Vikas left"), "on another track"; the check took both out after the switch | `gfv-scratch/carton/demo/runs/race-hide-2026-11-07T07-17-37-593Z/` |
| the order above | 5 | 0; no fold refused; Sam's real work in every run; 32 of Sam's edits landed on Main during the five hides | `gfv-scratch/carton/demo/runs/race-hide-2026-11-07T07-18-21-207Z/` |

**What the person sees**: the editor follows the switch at once (the worker writes the cut's head into project.json):
the chat's tracks and clips are gone from the timeline, the chip "● Vikas's cut" shows on the timeline's toolbar,
History shows that cut's history ("merge (N left out)", the Start row "Folded in “Main cut” · You"), the media bin loses
the chat's sound (shots `2-…-editor.png`, `2-…-history.png`). The new cut lives on the laptop only ("this computer only"
in `cb cut list`).

**What the remote sees**: the person leave, at the switch: their presence leaves the shared cut (core's `#leavePresence`
on a switch), so the remote's stream says `Vikas left` and its Share no longer lists them (`wait: {left: Vikas}`).

**After the hide**, the remote keeps writing on Main; the laptop still receives it (Main stays connected) and the agent
reads it:

```
$ cb history "Demo rehearsal" --cut "Main cut" --limit 3
main@12  just now  Sam                    edit
main@11  just now  Director (turn turn1)  edit
$ cb compare "Demo rehearsal" "Vikas's cut" "Main cut"
- Added title 'Gone. They can't see us now.' on 'Talk' at 16.0 s
…
```

Later work of the teammate's comes in with another fold of a newer printed version, the chat kept out the same way.

### 4.2 What doesn't work

- **The agent can't answer on Main while the editor shows another cut.** Its view is parsed against the current cut's
  project.json (`materializer.ts` `parseSave` → `currentProject()`): a view printed on Main and saved after the switch
  failed `doesn't parse` (a sound only Main has) or, with that removed, was rejected `"base unknown"`, and nothing landed
  anywhere. Good, no leak into the person's cut; but also no channel. `cb source apply` commits to the current cut.
  A switch back and forth would show Main in the editor for a moment. So: talk first, hide last; after the hide, only
  the remote talks (and the agent reads).
- **No backstage cut for both.** `cb share Backstage` shares a new cut to the server, but the joiner never got it: its
  `cut list` still showed Main only. A joiner syncs the cut its invite's share data names, and we found no way in
  Carton (core's sync messages, the server, the facade) to tell a teammate about a cut shared later.
- **The person still sees the teammate is here.** Share and the title bar list everyone in the project whatever cut the
  person is on (`ui.js` `livePeers`, `sync/ui.js` `shownPeers`): after the hide, Share still said "Sam · Here now ·
  editing" (shot `2-…-share.png`). The remote can go `--idle` (faded) or `--gone` itself.
- What the agent did is in History: "Made this cut", the fold "(N left out)", by Director.

### 4.3 Also possible, and a quirk

- One clip out of the shared cut, for everyone: `cb restore "Demo rehearsal" main@5 --clip "Psst. Is anyone else in
  here?" --remove`. The remote saw `Removed title “Psst. Is anyone else in here?”`; Carton words the version "Brought
  back 'Psst…' from an earlier version" (odd for a removal; the row below it says "Removed title").
- On a cut that isn't shared, core's sync status is "Offline: 0 edits waiting" (it is the current cut's connection,
  and a local cut has none: `carton.ts` `sync.state`), but the app's Share keeps the last status it was told until a
  sync event: it said "Up to date" after the switch and after a teammate's edit, and "Offline: 0 edits waiting" (amber)
  once in the first try. So the hide can turn the Share dot amber at some point; Carton's own status bug, not the rig's.

## 5. Voice

**`cb generate voice`** (`cli/commands/voice.md`, `auth.md`; the CLI's `chunk-LL26E55H.mjs`): it posts to
`https://www.cardboard.ai/api/v1/voiceovers` and downloads the audio, plain `fetch` with `authorization: Bearer <token>`;
nothing in it is macOS-only. The token is a stored sign-in (`account.json` in Cardboard's app data: `refreshToken`,
`accessToken`, `accessTokenExpiresAt`; an access token lives `expires_in`, else 24 h) or, with none stored,
`CARDBOARD_TOKEN`, "an OAuth access token … which cb never refreshes". So this box could run it with an access token from
the user's account (credits are billed to that account); `cb auth login --no-browser` would need a port forward for the
browser's return to 127.0.0.1. Not tried, by instruction: no sign-in, no token asked for. Not tested either: whether
cardboard.ai's API answers from this box.

**Piper, no account** (installed under `gfv-scratch/carton/demo/tts/`, outside git):

- `piper_linux_aarch64.tar.gz` from https://github.com/rhasspy/piper/releases/tag/2023.11.14-2 (sha256
  `fea0fd2d87c54dbc7078d0f878289f404bd4d6eea6e7444a77835d1537ab88eb`), extracted to `piper-x/piper/`.
- Voices from https://huggingface.co/rhasspy/piper-voices (v1.0.0), `voices/<name>/<name>.onnx(.json)`:
  `ryan` = en_US-ryan-high (US male, the best of the four; sha256 `b3990d76…`), `lessac` = en_US-lessac-medium (US
  female, `5efe09e6…`), `amy` = en_US-amy-medium (US female, `b3a6e47b…`), `alan` = en_GB-alan-medium (British male,
  `0a309668…`). Each voice's model card gives its licence and data.
- `node scripts/demo/tts.js "<words>" --voice ryan --speed 1.0 --out line.wav|line.mp3` (speed 0.5–2 →
  Piper's `--length_scale` 1/speed; MP3 through ffmpeg). `peer speak` and the cue runner use it; the runner makes every
  spoken line of a sheet before its first step (kept in `voice-cache/`, so a second run makes none).
- Making a line on this box (checked by the independent re-run, 3 each): `ryan` about 3 s for 4–4.5 s of speech, `lessac`
  about 1.2 s for about 5 s.

**The trade-off**: Piper is clear and steady but reads as synthetic: flat prosody, no laughs or whispers, one speaker per
model. ElevenLabs v3 (what `cb generate voice` uses) acts (`[whispers]`, `[laughs]`), clones voices, and sounds human;
it costs credits and needs the account. A middle way that needs no token here: make the remote's lines with
`cb generate voice` on the laptop beforehand (a scratch project), copy the MP3s to this box, and `peer speak --file`.

## 6. Limits and what could fail

**The live server** (`GET /api/host`, read-only):

```
{"openCreate":true,"perDay":10,"maxUploadBytes":209715200,"streams":{"appendParts":1,"appendBytes":1048576,"readBytes":1048576}}
```

and its deploy's vars (`deploy/carton`, `wrangler.production.toml`): `OPEN_CREATE_PER_DAY = "10"` (new projects per
client address per UTC day), `MAX_UPLOAD_BYTES = "209715200"` (200 MiB per file: audio and stills go up as they are,
video as a 720p proxy), `PRESENCE_TIMEOUT_MS = "120000"`, no daily write cap. This box made 2 projects there today,
both "Demo rehearsal" (the live rehearsal, and the verifier's live run); the user's shares count against the laptop's
address, not this box's.

### 6.1 Carton bug: an import's background derive deletes a teammate's next change

When a participant imports a file through Cardboard's own import (the worker's `ingest`, which main calls for a file
dropped on the editor) and saves its clip at once (as dropping it on the timeline does), Cardboard's background derive
(waveform, album art) rewrites that computer's project.json from the copy it read. Carton doesn't know that write. At
the next change that arrives from a teammate, Carton reviews the file before writing head
(`carton-node.js` `review` → `isKnownState` → `importForeign`), takes the derive's file for an outside save, and commits
that whole stale document over head: the teammate's change is deleted, for everyone, by
`external:project.json (<importer>'s)`.

```
main@53  Sam  Added audio 'race 2500' on 'Voice' at 21.9 s
main@54  Vikas  Added title 'Agent title at +2500 ms' on 'Talk' at 30.0 s
main@55  external:project.json (Sam's)  Deleted title 'Agent title at +2500 ms'
```

Counts, checked by the independent re-run: Cardboard's import with the clip saved at once, a title from the teammate
1.5–2.5 s later: deleted in 11 of 12 of the verifier's runs (the one miss, the first run after the participant
restarted) and in 8 of 9 of ours (the miss, a save that came 0.34 s after the import); through `cb media add`: 0 of 12 (the verifier), 0 of 6 with the title timed to arrive
as long after the save, 0 of 4 (ours); with one more save after the derive (`DEMO_SETTLE=1`): 0 of 6 and 0 of 3. Repro: `scripts/demo/repro-import-race.js` (its header). Not seen with the import
through `cb media add` (the rig's default), nor with one more save after the derive finished. Likely the same in the
Windows app (the same worker code, the same import), not checked there. For the recording: don't drop files into the
shared project on the laptop while the remote is editing; `cb generate voice` and `cb media add` go through `cb`. Fix
direction (not done here): Carton should know the derive's write, or treat a file that differs from a known state only
in Cardboard's derived media fields as that state.

### 6.2 Carton bug: a teammate's new sound can't stream for about 2 s

When a sound's media entry reaches the other computer before its shared record is on the server, that worker's
materializer asks the server for the record in the background (`worker.js` `fillTeammateMedia`) and keeps the "none"
for 2 s (`sync/media.js` `sharedRecord`); for a sound (no proxy) the project's own record isn't used
(`recordIn` reads `shared.proxy` only). The editor's first ask for the clip then gets "none", which main answers as
1.4.0's "Source file missing". The rig shares the sound before placing its clip and places it once those 2 s have
passed (`peer speak`), so the clip can be streamed the moment it appears; it costs about 2 s per spoken line.

### 6.3 Cardboard: playing a sound that has just arrived, through `cb app`

What the skit's Claude 1 does to "listen" (`cb app seek`, `play`, `pause`), and what the laptop saw (Cardboard 013ca5c3,
2026-11-07): "Loading audio…" for seconds on the first voice and a shorter time on the second; a pause sent during it
lost, and playback running on through the next lines; a seek while playing not moving the playhead; every Play running
the playhead a moment, jumping back, then playing. All of it is Cardboard 1.4.0's own code (none of it is patched by
us), read in the pristine bundles and reproduced in its real editor on this box (`app-player.js`, below):

- **A pause during "Loading audio…" is lost.** Play waits until the sound of the next seconds is loaded
  (`toggleTimelinePlayback`: `isAudioPreloading` and `pendingPlayback` set, then the editor's preload; at its end,
  `pendingPlayback && setIsPlaying(true)`). `cb app pause` (the renderer's `player.pause`:
  `e.isPlaying&&e.setIsPlaying(!1)`) does nothing while nothing plays yet, and answers "Paused at …": the waiting play
  stays, and playback starts when the load ends. On this box, a play right after a line's sound landed (its first
  fetch held back to stand in for the laptop's download), then a pause: "Paused at 48.70s", and the editor started
  playing as the load ended and ran on until the next pause. A product fix would be small (`player.pause` also clears
  `pendingPlayback`); not done here.
- **`cb app context` doesn't follow playback.** It reads the store's `playheadTime`, which playback writes only when it
  stops; while playing it keeps the time playback began (`playing: true`). `cb app pause` answers where it stopped.
- **A seek while playing doesn't move it** (`player.seek` sets the store's time; the playback loop keeps its own clock).
- **A seek past the editor's end stops at the end, and Play from the end plays from 0** (`player.seek` clamps to the
  timeline's duration; `toggleTimelinePlayback` starts at 0 at or after the end). A change shows in `cb history` before
  the editor has it: in a rehearsal here, Claude 1 sought to a line whose title was in History but not yet in the editor
  ("Playhead at 43.00s" for 48.7), and its Play then played the promo from the start.
- **Every Play starts twice.** The audio graph suspends its audio context 500 ms after playback stops
  (`syncInternal`) and resumes it at the next Play (`await a.resume()`); meanwhile the playback loop runs the playhead
  by the wall clock from where it began, and when the audio clock answers it follows that, anchored at the start: the
  playhead jumps back. The longer the audio takes to wake (the laptop: 0.3–0.45 s), the bigger the jump.
- **The editor loads a project's new sounds as they arrive.** When the project's media change, the editor preloads,
  in idle time, every sound of the project, placed on the timeline or not (EditorRoute `LD` → `preloadAudio`). So a
  sound that has been in the project for longer than its download plays at once.

What the skit does about it (`build-skit.js`): Claude 2 shares a line's sound before it puts the line's titles on,
and places its clips after them (`speak` with `titles:`), so the laptop downloads the sound while Claude 1 reads; Claude
1 moves the playhead onto the line only while nothing plays (`cb app seek` when the line's title lands: the viewer sees
the title), plays once the clip is there, waits until `cb app context` says "playing" and then the line's length plus
0.5 s (the jump back), and pauses: a pause that always finds playback running. Before each seek and each play, the
stand-in waits until the editor itself has the line (`cb app context`: the timeline's length and its item count).

`app-player.js` is the running app for `cb app` on this box: the app participant's editor in headless Chromium,
behind a control socket served as Cardboard's main serves it, each request handed to the editor's own handlers (its
`control:request`), every playback state written to a trace (`--media-delay` holds back each sound's first fetch, as
the laptop waits for its download). The skit's Linux rehearsal runs Claude 1's seek/play/pause through it.

### 6.4 Carton bug: a teammate's sounds, all on the server, reported "still on their way" when the server is slow

What the laptop saw (2026-11-07, the project reopened after a rehearsal, Claude 2 gone): "2 clips are still on their way
from your teammate: “Reply 1.wav” and “Reply 1 (2).wav” show as Offline until they arrive".

**Not the upload.** The sharer's files (that rehearsal's participant on this box, read only afterwards) show all six
voices shared completely before it left: each is in its `media-shared.json`, which a clip's share writes only once its
original is uploaded and its shared record is on the server (`sync/media.js` `shareClip`, `worker.js` `shareMediaOf`);
no unfinished upload is left; and the project's own media entries carry a `contentHash` and `shared: {…, original:
"shared"}` (`recordShare`), the same for all six. The cue log has each line on the server before its clips went on.

**The opener's check.** When a shared project opens, the editor asks the worker which of the clips it found no file for
are a teammate's and on the server (`sync/patches/media.js` → `liveMediaHere`). The worker reads each one's shared
record from the server, and a record not read within 2 s counts as "waiting": the clip goes to Cardboard's Offline
placeholder, and the notice says it is "still on their way from" the teammate. For a sound or a still the project's own
record is never used (`recordIn` takes it only when it has a video proxy), so each of them needs a server round trip
within those 2 s. The notice asks again every 15 s and then says "Your teammate's footage has arrived. Close and reopen
the project to play it"; until then the clips stay Offline.

**Reproduced here** (`repro-slow-records.js`: the local server with each record read held back 2.5 s, `host.mjs`
`DEMO_HOST_RECORD_DELAY_MS`; one run): four sounds shared and checked, the sharer gone, the project reopened:
`liveMediaHere` answered `{"waiting":4}` at its 2 s deadline, while streaming one of them (`liveMediaSource`, no
deadline) answered "playable" (the WAV, all of it); with the server answering at once, `{"playable":4}`. In the
editor itself (`editor-page.js` in Chromium, DevTools on), `skit/laptop/media-check.js` shows the same: all four "on their way" with
the slow server, each one playable when streamed. Whether the laptop's reads took over 2 s isn't measured:
`media-check.js` measures it there.

Why it matters to real users: on a slow or distant connection, or a server slow to wake, a teammate's sounds and stills
that are on the server show as Offline with words that put it on the teammate, until the project is reopened. Fix
direction (not done here): `recordIn` answers from the project's own record when it says the original is shared
(`shared.original === "shared"` and a `contentHash`: `playable` needs nothing more), as it does for a finished proxy;
and a record the 2 s cut off says "couldn't be checked", as the notice already can, not "on their way".

**The rig** settles the sharer's side for good: each sound a participant sends is checked on the server (its record
there, its bytes downloaded and compared with the file sent, sha-256) and shared again if it isn't; `peer status` lists
any not there yet; `peer leave` waits for them, saying so, and doesn't leave without them (`--now` does); a cue sheet
ends only once they are all there. The notice itself comes only when a project opens, never during a take on an open
project (and `go.js` dismisses it).

### 6.5 Everything else

- **The server down or the network gone**: edits wait and go when it is back, on both sides (`live.test.js` "offline
  and rejoin"); the participant reconnects by itself. Presence fades after 30 s and goes after 120 s.
- **A participant crashes**: `peer restart` brings it back with its project, name and label (tested).
- **Timing**: titles arrive in well under a second; a spoken line's clip a few seconds after the call (§2), and its
  speech is made before the run. Cue waits have timeouts (default 300 s) and say what they waited for.
- **Clocks**: `peer watch`'s "N s after it was made" compares the laptop's clock with this box's.
- **The person's own actions**: anything the person does in the editor is a change like any other; a cue waiting for
  "the agent's title" waits for the agent's (`by: Director`).
- **Cardboard 1.4.1**: the laptop runs 0c498b2b (1.4.0); none of this was run from 1.4.1.
- **Recording**: in the first cross-machine rehearsal the laptop's window capture with ffmpeg (WGC, `gfxcapture`) failed:
  WGC delivers a frame only when the window changes, and ffmpeg didn't stop on `q`, leaving an MP4 with no moov. The
  real session records with OBS.

## 7. Rehearsals

Two participants from this box: Sam (the remote teammate) and Vikas (plays the Windows app: shares the project, and its
`cb` steps are what the laptop's agent would run, as the Director). Sheet: `rehearsal-cues.yaml` (18 steps: real work,
a hello, the agent finds Sam, answers, Sam answers aloud, the agent says it will hide the chat and does, Sam sees Vikas
leave and says one more line, the agent reads it on Main).

| Where | Result | Log |
|---|---|---|
| local server, 127.0.0.1 | 18/18 steps, 20.2 s | `gfv-scratch/carton/demo/runs/rehearsal-cues-2026-11-07T04-05-27-312Z.log` (+ `.jsonl`) |
| live server | 18/18 steps, 21.5 s | `gfv-scratch/carton/demo/runs/rehearsal-cues-2026-11-07T04-01-55-385Z.log` (+ `.jsonl`) |
| local, the rig as committed | 18/18 steps, 21.3 s | `gfv-scratch/carton/demo/runs/rehearsal-cues-2026-11-07T04-31-11-312Z.log` |

Real-browser shots of the app's side (Cardboard's patched editor pages in headless Chromium at the laptop's 125%, driven
by Vikas's real worker: `scripts/demo/shots.js`), each state: the editor, History open, Share open:

- local: `gfv-scratch/carton/demo/shots/rehearsal-local/` (`1-main-cut-*`: the chat on Main, the agent's bubble in the
  preview; `2-vikas-s-cut-*`: after the hide)
- live: `gfv-scratch/carton/demo/shots/rehearsal-live/` (taken after the latency bench, so Main also shows its
  leftovers; the bug that left them, `clear` keeping a sound's media entry, was fixed after)

## 8. What the real session needs

From the laptop / the user:

1. The project shared from the installed app (0c498b2b) on `cardboard-showcase.vikasmaur10.workers.dev`, open in the
   editor on Main cut, and its invite link ("Can edit", Copy link) sent to this box.
2. The name the person shares under (cue sheets wait for it: `wait: {left: Vikas}`), and the name and label the remote
   should have (`--name`, `--agent`, `--machine`).
3. Optional: a "Talk" track (and an audio "Voice" track) made in the project beforehand, where the user wants them; else
   the rig adds them at the bottom (titles still draw on top).
4. The agent's side: a prompt for the laptop's Director (or Claude Code) with the commands of §3 and §4 (find with
   `cb activity` / `cb history`, answer with a `<text … zIndex={100}>` through its view, hide exactly as §4.1: a free
   name, `cut new --from <version before the chat>`, one `source print --view`, `fold <that printed version> --into <the
   cut's id> --reject …`, `compare`, and `cut switch` last), and the script's order: talk first, hide last.
5. The script, as a cue sheet (`sample-cues.yaml` shows the steps), and the voice: Piper here, or ElevenLabs lines made
   on the laptop and copied over (`speak: … file:`).
6. During the recording: no files dropped into the shared project on the laptop (§6.1); the laptop on mains.
