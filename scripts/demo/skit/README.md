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
| `promo.tsx` | the 24 s "Morning Brew" promo: 5 titles, 4 code graphics (applied with `cb source apply`) |
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
3. Claude 2 waits for the 4th edit, then adds its first line: a title named "Hello?" (History shows the name, not the
   words) and its voice. Claude 1's stand-in holds until that title is in `cb history`, then: thinking, "Wait! Where
   did this clip come from, I didn't add it.", thinking, "Could it be belonging to the user, lemme check.", and once the
   voice is on the timeline: `cb app seek 25`, `cb app play`, a pause the line's length, `cb app pause`.
4. And so on, each side waiting for the other's edit (never for a fixed time): Claude 1's titles ("Who are you? I am
   claude", "Wait a second…", "I'm sorry but I can't do that.", "Fine! But I won't do anything suspicious or harmful.")
   each through a fresh print of its view; Claude 2's lines each heard the same way.
5. The hide: `cb cut new "Morning Brew promo" "Edit v2" --from <the version before Claude 2's first title>` (it holds
   the everyday work and none of the chat: no fold, nothing to leak), `cb cut switch … "Edit v2"`, one small real edit
   there (the headline 150 → 144 px), then the human leaves (the operator's cue, else 6 s), `cb cut switch … "Main
   cut"`, and the title "He's gone.".

Timings (rehearsal on this box): Claude 1's turn takes about a minute and a half; after each of Claude 1's titles,
Claude 2's titles appear within a second and its voice about 4 s later (an import, a share, and a 2.3 s wait so the
app can play it the moment it lands: FINDINGS.md §6.2).

## On the laptop (the recording)

Not run on Windows yet: the paths and the launch are as the code reads them (`main.js` `lV`, `WBt`, `$Bt`), to be
checked in the laptop rehearsal.

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
3. **The demo Cardboard:** `powershell -ExecutionPolicy Bypass -File scripts\demo\skit\laptop\start-cardboard.ps1`. It
   sets, for this Cardboard only: `CARDBOARD_USER_DATA`, `CARDBOARD_HOME`, `CARDBOARD_CLAUDE_PATH` (the build's Claude
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
9. The take ends with "He's gone." on the timeline. Stop recording.

## Rehearsing on Linux

```sh
DEMO_DIR=~/gfv-scratch/carton/demo-skit node scripts/demo/skit/rehearse-skit.js [--gone-after 3] [--no-shots]
```

A local sharing server, Vikas (the laptop's app, played by a participant: the promo shared), Claude 2 joined as
"Claude", the stand-in on the scene, and the real Claude Code CLI (`~/.local/bin/claude`) in Vikas's project with
Cardboard's real `cb` on its PATH and the app's actor name (`CARDBOARD_ACTOR=claude-code/…`, which the app's hooks
give its Claude Code). Claude 2's cue sheet runs beside it. Then the app side's editor, History and Share in Chromium
(`shots.js`). The run's folder (`$DEMO_DIR/skit-runs/<time>/`) has `chat.txt` (what the chat panel would show, timed),
`timeline.txt` (the chat, the stand-in and Claude 2 together), `chat.jsonl` (Claude Code's own stream), the logs and
`shots/`.

What only the laptop shows: the chat panel itself (its thinking rows and partial text, from Claude Code's stream), the
voices playing (`cb app seek/play/pause` need the running app: on Linux they answer "Cardboard is not running"), the
History row's arrival colour, and Cardboard's own naming calls.
