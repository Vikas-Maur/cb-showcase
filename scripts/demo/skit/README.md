# The skit: two Claudes in one Cardboard project

The user's script, recorded in the real Cardboard on the Windows laptop:

- **Claude 1**, the local Claude: the real Claude Code that Cardboard runs as the person's own agent (the chat panel's
  "Claude Code", Cardboard's provider `claude`), doing everyday work on a promo. Its model is **scripted**: a stand-in
  for the Anthropic Messages API (`scripts/demo/actor/actor.js`) answers Claude Code with this scene's thinking rows,
  chat lines and tool calls. Everything else is real: Claude Code, the chat panel, the tool runs (Cardboard's own `cb`),
  History, the cuts.
- **Claude 2**, the remote Claude: a participant from the EC2 box (`scripts/demo/peer`), joined as "Claude", talking
  with titles and Piper voices on the timeline (`claude2-cues.yaml`).
- The human is never shown.

Everything happens in the editor; the project is made in Cardboard itself (titles and code graphics, no footage).

## Files

| File | What |
|---|---|
| `promo.tsx` | the 24 s "Morning Brew" promo: 5 titles, 4 code graphics (applied with `cb source apply`), and the conversation's 3 tracks, empty, at the top |
| `build-skit.js` | the user's script (verbatim, one change below), Claude 2's voices, the layout, and the two files below |
| `claude1-scene.json` | Claude 1's scene for the stand-in (generated) |
| `claude2-cues.yaml` | Claude 2's cue sheet (generated) |
| `layout.md` | where each line sits on the timeline, and its voice file (generated) |
| `rehearse-skit.js` | the whole skit on the Linux box (below) |
| `laptop/*.ps1` | the laptop's side: the demo profile's paths, the project, the stand-in, the demo Cardboard |

`node build-skit.js` makes them again (after a change to the lines or the voice). Piper isn't deterministic, so the
voices are made once and the cue sheet names the exact files (`~/gfv-scratch/carton/demo/tts/skit-voices/`).

## The scene

1. The person's prompt (typed in the chat panel): **`Everyday work: tidy up the promo`**. The naming calls Cardboard
   makes through the same Claude Code ("Name this conversation…", Carton's "Title this change…") get "Everyday work"
   from the stand-in, so the chat and the History turn are named that.
2. Claude 1 prints its view, reads it and makes 4 everyday edits (the tagline, the offer, the hours, the address: one
   History row "Changed the text of 4 titles"), then `cb verify` ("All checks passed").
3. Claude 2 waits for the 4th edit, then says its first line: the line's sound imported and shared, its title named
   "Hello?" (History shows the name, not the words), then the sound's clip. Claude 1's stand-in holds until that title
   is in `cb history`, then: thinking, "Wait! Where did this clip come from, I didn't add it.", `cb app seek 25` (the
   playhead on the title: it shows in the preview), thinking, "Could it be belonging to the user, lemme check.", and
   once the clip is on the timeline: `cb app play`, a hold until the app has played the line (`cb app context` says
   "playing", then the sound's length and 0.5 s), `cb app pause`.
4. And so on, each side waiting for the other's edit (never for a fixed time): Claude 1's titles ("Who are you? I am
   claude", "Wait a second…", "I'm sorry but I can't do that.", "Fine! But I won't do anything suspicious or harmful.")
   each through a fresh print of its view; Claude 2's lines each heard the same way (seek when the title lands, play
   once the clip is there). Before each seek and each play the stand-in waits until the app's editor has the line
   (`cb app context`): History shows a change before the editor does, and a seek past the editor's end stops there.
5. The hide: `cb cut new "Morning Brew promo" "Edit v2" --from <the version before Claude 2's first change>` (it holds
   the everyday work and none of the chat: no fold, nothing to leak; the conversation's tracks are there, empty),
   `cb cut switch … "Edit v2"`, `cb app seek 1.5` (the headline in the preview), one small real edit there (the
   headline 150 → 144 px), then the human leaves (the operator's cue, else 6 s), `cb cut switch … "Main cut"`, the
   title "He's gone.", and `cb app seek 73.2` (the playhead on it) once the app has it.
6. The turn stays open (the chat panel shows Claude Code working) until the operator's end cue; then Claude 1's last
   message, to its person: "All done: a warmer tagline, the offer at 25% off, opening from 6:30am, and the full address
   in the outro. The headline is a touch smaller in Edit v2." The panel then folds the turn into "Worked for …".

The conversation's tracks are made by `promo.tsx`, empty, at the top of the timeline, so they are in view (a track
added later goes below the others: on the laptop only the first 4 tracks show), with names that give nothing away:
**Callouts** (Claude 1's titles), **Overlays** (Claude 2's titles), **Voiceover** (Claude 2's voice).

Play and pause (FINDINGS.md §6.3): a sound that has just arrived can load for seconds before Play plays ("Loading
audio…", 6 s for the first one on the laptop), and a `cb app pause` sent during that is lost (Cardboard's own
`player.pause`): playback starts when the load ends and runs on. So Claude 2 shares a line's sound before its titles
(the laptop's editor loads a project's new sounds as they arrive, while Claude 1 reads), Claude 1 seeks only while
nothing plays, and pauses only once the app says it plays.

Pacing: each side waits for the other's edit, never for a fixed time. After each of Claude 1's titles, Claude 2's line
takes an import, a share, its titles, and the rest of a 2.3 s wait before its clips go on, so the app can stream the
sound the moment the clip lands (FINDINGS.md §6.2). Claude 1's turn ran about two minutes in the last rehearsal on this
box (one run, not checked independently; the laptop's own take is the measure).

## On the laptop (the recording)

Rehearsed on the laptop (2026-11-07, Cardboard 013ca5c3, muted, Claude 2 from EC2). What Windows needed:
- `Cardboard.exe` is a Windows (GUI) program: PowerShell waits for it, and shows what it prints, only when its output
  goes down a pipe. The scripts pipe it (unpiped, `cb project create` returned at once and raced `cb source apply`, and
  the stand-in returned with no output).
- cb finds the running app by `CARDBOARD_SOCKET` only (`CARDBOARD_USER_DATA` means nothing to it): `demo-env.ps1` sets it
  to the demo profile's, else cb here (and the stand-in's waits) would reach the user's own Cardboard when it runs.
- A voice that has just arrived can load for seconds before `cb app play` starts playback (6 s for the first one on the
  laptop); a fixed pause then sent `cb app pause` too early, it was lost, and playback ran on through the next lines. The
  scene now waits until the app has played the line (`{wait: {played}}`, `cb app context`) before it pauses.

0. **Once:** set the paths in `laptop\demo-env.ps1` (the installed build, a demo folder). The demo profile's Claude Code
   is the build's own (`resources\director\claude.exe`), with its own config folder: the user's Claude sign-in is never
   read. It signs in with the placeholder key (`claude auth status`: `"loggedIn": true`, `"apiKeySource":
   "ANTHROPIC_API_KEY"`), which Cardboard reads as signed in.
1. **The project:** `powershell -ExecutionPolicy Bypass -File scripts\demo\skit\laptop\make-project.ps1` (with the demo
   Cardboard closed). A new take needs a fresh project (a new library folder in `demo-env.ps1`, or delete this one):
   the scene makes a cut named "Edit v2" and expects the promo as `promo.tsx` makes it.
2. **The stand-in:** `powershell -ExecutionPolicy Bypass -File scripts\demo\skit\laptop\start-actor.ps1` (it runs on
   Cardboard's own Node: no Node install). Leave it open. It answers on `127.0.0.1:8787` only, never forwards anything,
   and never reads, logs or keeps request headers.
3. **The demo Cardboard:** `powershell -ExecutionPolicy Bypass -File scripts\demo\skit\laptop\start-cardboard.ps1`
   (`-Mute` for a rehearsal, `-DebugPort <n>` to drive it over DevTools). It removes every `CLAUDE*`/`ANTHROPIC*`
   variable, then sets, for this Cardboard only (`$AppEnv` in `demo-env.ps1`): `CARDBOARD_USER_DATA`, `CARDBOARD_HOME`,
   `CARDBOARD_SOCKET`, `CARDBOARD_CLAUDE_PATH` (the build's Claude
   Code), `CLAUDE_CONFIG_DIR` (fresh), `ANTHROPIC_BASE_URL=http://127.0.0.1:8787`, `ANTHROPIC_API_KEY=sk-mock`,
   `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_AUTOUPDATER=1`. Cardboard hands its whole environment to the
   person's own Claude Code (`lV`), and strips every `ANTHROPIC_*`/`CLAUDE_*` from the Director's, so only Claude Code
   talks to the stand-in.
4. **Share:** open "Morning Brew promo", Share (`cardboard-showcase.vikasmaur10.workers.dev`), Copy link, send it to
   the EC2 box.
5. **Claude 2, on the EC2 box** (its own folder, `demo-live`, reserved for the real session):
   ```sh
   export DEMO_DIR=~/gfv-scratch/carton/demo-live
   scripts/demo/peer setup                          # once
   scripts/demo/peer join "<the link>" --name Claude
   scripts/demo/peer run scripts/demo/skit/claude2-cues.yaml --peer Claude
   ```
   It shows as "Claude · Here now · editing" in the laptop's Share and title bar, and waits.
6. **Record:** OBS, a Window Capture of Cardboard (Windows Graphics Capture) and an Application Audio Capture of
   `Cardboard.exe` (the voices play in the app). Start recording.
7. **Go:** in the chat panel, pick Claude Code (not the Director), and send `Everyday work: tidy up the promo`.
8. **The human leaves** (step 5 of the scene): `Invoke-WebRequest http://127.0.0.1:8787/cue/gone`, or let it go by
   itself after 6 s.
9. "He's gone." goes on the timeline and the playhead onto it. The chat panel still shows Claude Code working: it
   waits for you.
10. **The end:** `Invoke-WebRequest http://127.0.0.1:8787/cue/end`. Claude 1's last message comes, and the turn ends
    ("Worked for …"). (Not sent within 280 s, it ends by itself.)
11. Stop recording.

### Driving it on the laptop (a rehearsal, or a take run from a terminal)

The laptop's own tooling in `laptop\`, for a run while someone uses the laptop (all DevTools page input; nothing is sent
to the OS; paths from `demo-env.ps1`):

| File | What |
|---|---|
| `launch-demo.ps1` | the demo Cardboard with `start-cardboard.ps1`'s environment, started unseen on desktop 2 (`unseen\start-unseen.ps1`, never activated), muted unless `-Sound`, DevTools on `-DebugPort` (9420); prints `pid=… hwnd=…` |
| `share.js <port> <project id>` | first-run screens, the project's tab, Share as "Vikas" on the default server; prints `LINK <url>` (read from the dialog: Copy link would overwrite the clipboard) |
| `cap-run.ps1 -Hwnd <hwnd> -Out <file.mkv>` | records that window only (Windows Graphics Capture → Quick Sync → Matroska) until its stop file appears |
| `go.js <port> <project id>` | History open, the Library panel closed, a Claude Code row picked, the prompt sent; shoots the key moments, sends the gone cue 3 s after the stand-in waits for it (`--gone-after`) and the end cue 4 s after (`--end-after`), then stops the capture and the taskbar flash |
| `unseen\` | the launcher, its Win32 calls, and `flashstop.ps1` |
| `lib\` | DevTools helpers (over `scripts/cdp.js`), the first-run screens, opening a project's tab, `demo-env.ps1`'s paths for Node |

A rehearsal: `make-project.ps1`, `start-actor.ps1`, `launch-demo.ps1`, `node share.js 9420 <id>` (send the link), then
`cap-run.ps1` with the printed hwnd and `-Out <demo>\runs\<run>\rehearsal.mkv`, and on "go" `node go.js 9420 <id>
<demo>\runs\<run>` (the same run folder: its `cap.stop` ends the capture). Windows Graphics Capture gives a frame only
when the window changes, and an ffmpeg that never got one can crash on `q` and leave an empty file.

## Rehearsing on Linux

```sh
DEMO_DIR=~/gfv-scratch/carton/demo-skit node scripts/demo/skit/rehearse-skit.js [--gone-after 3] [--end-after 3] \
  [--media-delay 4000] [--no-shots] [--setup-only]
```

A local sharing server, Vikas (the laptop's app, played by a participant: the promo shared), Claude 2 joined as
"Claude", the stand-in on the scene, and the real Claude Code CLI (`~/.local/bin/claude`) in Vikas's project with
Cardboard's real `cb` on its PATH and the app's actor name (`CARDBOARD_ACTOR=claude-code/…`, which the app's hooks
give its Claude Code). Claude 2's cue sheet runs beside it. Vikas's editor runs in headless Chromium for `cb app`
(`../app-player.js`): Claude 1's seek, play and pause run Cardboard's own playback there, "Loading audio…" included
(`--media-delay`: each sound's first fetch held back that long, as the laptop downloads it), and every playback state
goes to the run's `app.log`. Then the app side's editor, History and Share in Chromium (`shots.js`). The run's folder
(`$DEMO_DIR/skit-runs/<time>/`) has `chat.txt` (what the chat panel would show, timed), `timeline.txt` (the chat, the
stand-in, Claude 2 and the app's playback together), `chat.jsonl` (Claude Code's own stream), the logs and `shots/`.
`--setup-only` makes the shared project, Claude 2 in it and `$DEMO_DIR/bin/cb`, and stops.

What only the laptop shows: the chat panel itself (its thinking rows and partial text, from Claude Code's stream), the
voices heard (headless Chromium plays them to no speaker), the audio waking at each Play (the playhead's jump back),
the History row's arrival colour, and Cardboard's own naming calls.
