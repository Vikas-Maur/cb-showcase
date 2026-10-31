<img src="assets/icon.svg" width="64" height="64" alt="">

# cardboard-showcase

Created in [T3 Code](https://t3.codes).

## Cardboard 1.4.0 (macOS) on Windows

Cardboard only ships an Apple Silicon Mac build. This folder repackages that build's app code
(`app.asar`) onto the Windows build of the same Electron version (43.7.0), with Windows
replacements for its bundled macOS binaries.

![Cardboard running on Windows](assets/screenshot-windows.png)

Run it from the `Cardboard` shortcut (Desktop or Start Menu), or `Cardboard-win\Cardboard.exe`.
If you launch it from a terminal that has `ELECTRON_RUN_AS_NODE=1` set (some Electron-based IDEs
set this), unset that variable first.

Only `scripts\`, `tools\package*.json`, `README.md` and `assets\` are tracked by git. The app,
the downloads and Cardboard's unpacked code are ignored (see `.gitignore`): they are large, and
they are Cardboard's software, not ours to redistribute.

### Layout

- `Cardboard-win\` — the runnable app. Only this folder is needed to run Cardboard.
  - `resources\app.asar` — Cardboard's code, with the patches below.
  - `resources\bin\` — ffmpeg, ffprobe 8.1 (BtbN win64 gpl build), uv 0.13.6. Stay on 8.1:
    the 9.0 and nightly builds need NVIDIA driver 610+ for NVENC, and this laptop has 581.
  - `resources\director\claude.exe` — Claude Code 2.1.309 for win32-x64, the version the Mac build bundles.
  - `resources\cli\` — the `cardboard`/`cb` CLI, patched.
- `dl\`, `extracted\`, `asar-src\` — downloads and unpacked sources, kept for rebuilding.
- `main.orig.js`, `library-worker.orig.js`, `cardboard.orig.mjs`, `tabs.orig.js`, `index.orig.js`, `EditorRoute.orig.js`, `installErrorTelemetry.orig.js` — unpatched bundles the patch scripts start from.
- `scripts\` — patch and helper scripts.
- `tools\` — 7-Zip, `@electron/asar`, rcedit and the generated `Cardboard.ico`.

### Patches

`scripts\patch-main.js` (applied to `asar-src\dist\main.js`):
1. Use `.exe` names for the bundled ffmpeg, ffprobe, uv and claude.
2. Allow Desktop Director (the local Claude Code agent) on Windows; it was gated to darwin-arm64.
3. Replace the Director's tool setup (symlinks and `/bin/sh` wrappers) with shims that work
   from Git Bash, cmd and PowerShell. Python 3.12 with numpy, OpenCV, Pillow and SciPy goes in
   `%APPDATA%\ai.cardboard.desktop\director-python`. The folder with the real `ffmpeg.exe` and
   `ffprobe.exe` (`resources\bin`, which also has `uv.exe`) goes on the agent's PATH after the shims.
   Windows starts a bare `ffmpeg` only as an `.exe`, so agent code such as Python's
   `subprocess.run(["ffmpeg", …])` failed with "file not found". On macOS the shims are symlinks to the
   binaries, so the same code works there.
4. Run the control socket on a named pipe, since Windows can't listen on a socket file.
5. "Install agent tools" writes `cardboard`/`cb` shims to `%USERPROFILE%\.local\bin` and adds that folder to the user PATH.
   The `.cmd` shims keep `ELECTRON_RUN_AS_NODE` to themselves (`setlocal`). Before, one `cb` command left it
   set in the console, and every Electron app started from there (Cardboard, VS Code…) then ran as plain
   Node, with no window. On start, shims an earlier build installed for this exe are brought up to date
   (not while a `cb` command runs, since cmd would go on reading the batch file it is in the middle of).
   The folder goes on the user Path in the registry as it is: `%USERPROFILE%\…` entries stay unexpanded and
   the value stays `REG_EXPAND_SZ`. `[Environment]::SetEnvironmentVariable`, used before, wrote it back
   expanded, as a plain string. Paths with non-ASCII characters (`C:\Users\José\…`) are written into
   `.cmd` files as `%LOCALAPPDATA%`, `%APPDATA%` or `%USERPROFILE%` plus the rest, since cmd reads a batch
   file in the console's code page, not UTF-8. That goes for the Director's tool shims (patch 3) too.
   Cardboard also writes `cb`/`cardboard` shims for your own agents (Settings → Agents) in
   `%APPDATA%\ai.cardboard.desktop\agent-bin`, first on their PATH. On Windows it wrote only `.cmd` files,
   which Git Bash (Claude Code's shell) can't run by name, so unless agent tools were installed, Claude Code
   got `cb: command not found`. Now that folder gets the sh shim too, as on macOS.
6. Find your own Claude Code and Codex (Settings → Agents). On Windows Cardboard only looked for
   `claude.cmd`/`codex.cmd` on PATH, so it missed `codex.exe`. It also failed to start an npm
   `claude.cmd`, because Node won't run a `.cmd` directly. Now it takes `.exe` files on PATH,
   follows npm `.cmd` shims to the `.exe` they run, and also checks `%USERPROFILE%\.local\bin\claude.exe`
   and `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe`. npm's shim for a JavaScript package runs
   the `node.exe` next to it when there is one (nvm-windows, fnm, a prefix in Node's folder). That is
   Node, not the agent, and it passes the `--version` check, so those shims are skipped.
   It also fixes the environment agents are found and started with. Cardboard copied it and read
   `PATH`, but started from the Start Menu or Explorer, Windows names that variable `Path`. So the
   PATH search found nothing, and agents were started with only Cardboard's own shim folder on PATH.
7. Make notifications show (for example when an agent asks you something while the window is in
   the background). Windows only shows notifications from an app with an AppUserModelID that
   its Start Menu shortcut also carries. Cardboard set none. On start it now sets
   `ai.cardboard.desktop` and writes that ID into the Cardboard shortcuts (Start Menu, Desktop,
   taskbar pin) that point to this exe. It also creates the Start Menu one if it's missing. It
   flashes the taskbar button where macOS bounces the Dock icon.
8. Fewer animations in Cardboard only. Cardboard has no setting for this. It follows the system's
   reduced-motion preference, and the `force-prefers-reduced-motion` switch turns that on for
   Cardboard alone, leaving Windows' "Animation effects" setting as it is. Some fades remain. To
   bring the animations back, delete this replacement and rebuild.
9. Cardboard's tab strip is the title bar, as on macOS. The window asked for macOS's `hiddenInset`
   title bar, which Windows ignores, so Windows drew its own title bar and a File/Edit/… menu bar
   above the strip. Now the window has no native title bar. Minimize, maximize and close stay native
   (Snap Layouts, the red close hover), drawn over the strip's right end on a clear background with
   neutral-400 glyphs. The empty parts of the strip drag the window, double-click maximizes and
   right-click opens the window menu. The app menu moves into the strip (see `patch-strip.js`): main
   describes `Menu.getApplicationMenu()` to the strip and runs the item picked, so the strip's menu
   is always the real one, and the menu's shortcuts still work. Alt pressed and released on its own,
   or F10, opens the menu from anywhere in the window, as a menu bar would. A click or another key
   while Alt is down cancels that (Alt+drag duplicates clips, Shift+F10 opens the timeline's context
   menu). So does Alt pressed with a mouse button held: Alt in the middle of a drag, let go after the
   drop, even with a scroll or another button on the way. And so does any key let go while Alt is down,
   even one whose press Windows keeps for itself (Alt+PrintScreen). The About window loses its title bar and menu bar too: its page already has a drag region,
   and its fixed size had cut off the copyright line under them.
10. File → Import Folder… (Ctrl+Shift+I) imports the video, audio and image files in a folder and its
    subfolders into the open project, in path order (`clip 2` before `clip 10`). The folder picker runs
    in the editor, which gets the files through the event its own Import button uses, so the usual
    checks and progress apply. A folder with no media says so. File pickers only open from a user
    gesture, which a menu click doesn't give the page, so this one runs with a gesture. Import Media…
    from a menu now does too: it pressed Cardboard's own Ctrl+I in the page, whose picker only opened
    if the editor had been clicked in the last few seconds. Dropped folders are `patch-renderer.js`.
11. An activity log, for looking back at how an editing session went (see [Activity log](#activity-log)).
    Main writes it. Menu items say whether they ran from the strip's menu or their accelerator, agent
    answers say how long their question waited, Ctrl+Tab (which main handles itself) and Alt/F10 are
    logged, and main's own warnings and errors and the library worker's output go in too. Before, those
    only reached a console nobody sees when Cardboard starts from the Start Menu. It also says which GPU
    draws the app, and when a GPU or page process dies.
12. Windows wording where main names the Mac: "this PC" for "this Mac" in the sign-out and quit dialogs
    and when an agent isn't installed, and File Explorer for Finder in the agent's reveal step.
13. On a laptop with two GPUs, Cardboard draws on the fast one when the PC is plugged in. Windows gives
    an app the power-saving GPU unless the app asks for the other, so on a laptop with an RTX 3050
    everything Cardboard draws (preview, timeline, graphics) and its own video decoding ran on the
    integrated Intel GPU, which borrows system RAM, while the RTX sat idle. Started on battery it stays on
    the default GPU: the RTX, powered off otherwise, draws 3.3 W while Cardboard idles on it and about 9 W
    while a graphic plays. The choice is made when Cardboard starts, from the
    power state then; plugging in or out while it runs takes effect at the next start. An NVIDIA
    GPU is powered off when idle, and waiting for it to power up made startup slower, so `nvidia-smi -L`
    (installed with the driver) starts waking it as Cardboard starts. To keep Cardboard on the
    power-saving GPU, choose "Power saving" for it in Windows Settings → System → Display → Graphics;
    that wins over Cardboard's request (checked). Left out of `--baseline`. Measured in
    [Benchmarks](#benchmarks).
14. The "[telemetry] sentry delivery failed" warning says why: Cardboard's own message for the failed upload,
    an HTTP status or a network error ("Telemetry relay failed (429)", "fetch failed"). Cardboard reports
    its own problems, and a failed analytics upload is one, to cardboard.ai; when that report can't be sent
    either, main warned without the reason (145 times in an hour of test exports, from both builds and from
    a normal session, so not from these changes).

`scripts\patch-worker.js` (applied to `asar-src\dist\library-worker.js`) uses the NVIDIA GPU
(NVENC) for converting imported media and making preview copies, where macOS uses VideoToolbox.
It test-encodes a few frames once to check that NVENC works. If NVENC fails on that test or on a
particular file, Cardboard's existing fallback re-encodes in software (libx264/libx265).

It also makes imports finish much sooner. After a drop, Cardboard makes a timeline filmstrip and a
waveform for every clip, and a proxy for anything over 1920 px. It decoded every frame on the CPU for
both, so a 4K HEVC clip took about as long as it runs, twice. Now:
- Proxies decode on the GPU (NVDEC) and scale there (`scale_cuda`). Rotated sources (phone footage)
  decode on the GPU and scale on the CPU, since ffmpeg only applies the rotation to frames in system
  memory. If the GPU run fails, the NVENC run with CPU decoding follows, then libx264.
- Proxies are encoded at constant quality (NVENC CQ 30, capped at Cardboard's 12 Mb/s) and scaled with
  lanczos. Cardboard asks for a fixed 12 Mb/s, which VideoToolbox needs, and `scale_cuda`'s default
  scaler is softer than the CPU's. With both, proxies were 5 to 14 times the size of the CPU path's and
  looked worse. Scored against the 4K source (each proxy scaled back up, VMAF 4K model):

  | Proxy of | CPU path, libx264 CRF 20 (stock) | NVENC 12 Mb/s (before) | NVENC CQ 30, lanczos (now) |
  | --- | --- | --- | --- |
  | 40 s 4K HEVC phone clip | 10.7 MB, VMAF 92.4, 17.3 s | 54.8 MB, VMAF 85.5, 6.8 s | **5.8 MB, VMAF 95.3, 4.7 s** |
  | 20 s 4K60 H.264 clip | 1.9 MB, VMAF 91.1, 9.4 s | 27.7 MB, VMAF 82.8, 8.6 s | **1.6 MB, VMAF 94.9, 6.9 s** |
- Filmstrips decode only keyframes when, in the first 30 s, they come at least every 2 s. Otherwise
  every frame is decoded, on the GPU when there is one. ffmpeg's `fps` filter fills each slot with the
  last frame nearest to it, so even decoding every frame, Cardboard's thumbnails were up to half a slot
  late (0.25 s for half-second slots, 0.5 s for one-second slots). From keyframes about 1 s apart they
  land up to 0.57 s off for half-second slots and 0.07 s for one-second slots (measured on three
  clips). `eof_action=pass` keeps the last keyframe, which the filter otherwise dropped at the end.

Four clips from a 4K HEVC and phone footage folder (54 s and 9 s 4K, 20 s and 78 s 1080p) went from
73.5 s to 11.9 s until every filmstrip, waveform and proxy was ready. The clips themselves show up in
under a second either way.

It also fixes Cardboard staying alive with no window. Main waits for every import to be done before it
quits, and the worker said an import was done only if all of its background work succeeded. When one
background save failed (see [Saves on Windows](#saves-on-windows-scriptsrename-retryjs)), the worker never
said so, and main waited forever: closing the window left the process running with no window, until it
was ended in Task Manager. Now a clip whose background work fails gets Cardboard's usual "Could not import"
for that clip, and the import counts as done either way. The CLI's copy has the same change; there the
failure ended a recipe install with an unhandled rejection.

It also fixes clips left without a filmstrip when Cardboard quits during an import. Cardboard writes a
clip's poster first and, on reopening a project, counted any thumbnail as a finished filmstrip. Now a
video needs its filmstrip thumbnails to count as done.

The helpers both media patches add are in `scripts\media-helpers.js`. In the app's library worker they
also note in the activity log whether NVENC and CUDA work, and every fall back from the GPU to the CPU,
which was silent before. The CLI's copy stays quiet, since the agent reads what it prints.

`scripts\patch-strip.js` (applied to `asar-src\dist\renderer\assets\tabs-DV5oCzuF.js`, the tab strip)
finishes the title bar from patch 9. Cardboard's logomark sits at the strip's leading edge, where macOS
has its traffic lights, and opens the app menu: File, Edit, Playback, View, Window and Help, each with
its items in a submenu. The menu is drawn the way Cardboard draws its own menus (the timeline's context
menu): the same raised surface, 30 px rows, separators, shortcut keycaps (`Ctrl+Shift+E`, as Cardboard
writes shortcuts on Windows) and open animation, using classes already in Cardboard's stylesheet. It
works from the keyboard: arrows, Enter, Escape, and a letter to jump to an item. While it is open, a
click outside it only closes it, and closing it returns the keyboard to the editor. The strip also
leaves room for the window controls on the right, except in full screen, where Windows hides them, as
macOS's strip does for the traffic lights on the left. The menu's code is in `scripts\strip-titlebar.js`.

`scripts\patch-renderer.js` (applied to `asar-src\dist\renderer\assets\index-DufLJgUU.js`, the renderer's
main bundle, `EditorRoute-CuIqwZKP.js`, the editor's, and `installErrorTelemetry-DxKId8tA.js`, which holds
the editor's state) does the rest of the renderer's changes.

It imports the media in a dropped folder and its subfolders: dropped on the editor (the media panel or
anywhere else) it goes into the project, and dropped on the Dashboard (its prompt box, or anywhere else
on it) its media is attached to the prompt, as dropped files are. The prompt box has its own drop target,
which took a dropped folder as one attachment named after the folder. Checked with real drags from File
Explorer. Dropping a
folder imported nothing. Chromium lists a dropped folder as one file with no type, which the media filter
threw away. Cardboard has a folder walker, but read the drop's folders only after an `await`, when
Chromium has already emptied them. Now they are read while the drop is still being handled. Non-media
files in the folder are skipped, files already in the project too, and plain file drops work as before.
On the Dashboard a folder without media still gets the "files were not added" note. The Report an Issue
attachments and other drop targets don't take folders.

It also fixes the keyboard on Windows, found by pressing every shortcut in the running app
(`scripts\test-shortcuts.js`, below):
- Recording a shortcut in Settings → Shortcuts stored Ctrl as `ctrl`, while every built-in Ctrl shortcut
  is stored as `meta` (Cardboard's Cmd/Ctrl). The conflict check told the two apart, so Ctrl+D for Split
  at Playhead was saved without a word although Duplicate has Ctrl+D, and Ctrl+D then split with nothing
  selected and duplicated with clips selected. Now Ctrl is recorded as `meta`, and shortcuts recorded
  before are compared as `meta` too. On a Mac the same recording said "already used by Duplicate".
- The Shortcuts page drew a Mac keyboard: ⌃ ⌥ ⌘ along the bottom, ⇧, ⌫, Return, and ⇧/⌘/⇧⌘ layers. Now
  it draws Ctrl, Win, Alt, Shift, Backspace and Enter, and Ctrl, Shift and Ctrl+Shift layers.
- Ctrl+Y redoes, as everywhere on Windows (Ctrl+Shift+Z still does). Only while Redo keeps its default
  and nothing else is set to Ctrl+Y.
- Answering the agent from the keyboard: Enter on a question's option that is already picked sends the
  answer. Clicking an option leaves the keyboard on it, and Enter clicked it again, which un-picked it,
  so "click an option, press Enter" sent nothing. Enter on an option not picked yet still picks it
  (Enter, Enter from the keyboard), and Space still toggles. A generation ("Generate this sound effect?
  0.27 credits") is approved with Ctrl+Enter and skipped with Esc, as the card's keycaps say, from the
  reply box or anywhere else; plain Enter doesn't spend credits. That is Cardboard's design (⌘↵ on a Mac)
  and is unchanged.
- The pages' part of the activity log: shortcuts, keys nothing handled, how each agent question was
  answered (a key or a click), page errors and error toasts.

The timeline and playback, found by playing real projects in a separate copy of the app and measuring:
- Previous/next frame (← →) keep the playhead in view. Jump to start/end scrolled the timeline to the
  playhead; the frame steps did not, so holding ← walked it off the edge, out of sight.
- Dragging the playhead, or scrubbing the ruler, past the edge of the timeline scrolls it, faster the
  further out, as in other editors. It only followed the pointer within the visible part, so a point off
  screen could only be reached by scrolling first. Rightward it stops once the project's end is in view.
- The timeline redraws when the GPU hands its canvases back. The ruler and the tracks are drawn on opaque
  canvases; when the GPU drops them (a driver reset, the GPU process restarting, memory running short)
  Chromium gives them back blank, which shows as black, and says so with a `contextrestored` event nothing
  listened to. They stayed black until something else redrew them: still 99% black 10 s after the GPU
  process restarted, against redrawn within 1.5 s now.
- Play waits only for audio that will be heard. After a seek, Play holds ("Loading audio...", up to 8 s)
  until the sound of the clips ahead is loaded, and that included clips on muted tracks and muted,
  hidden or reversed clips, which are never played. With a slow disk (every extracted-audio read 3 s
  late): Play with the B-roll track muted started in 0.18–0.22 s, against 4.0–4.1 s.
- A second Play while it says "Loading audio..." plays at once, the sound joining as it loads (as after
  the 8 s limit). Pressing again did nothing, so it looked like Space didn't work: 0.82–0.83 s to playing
  with a second press at 0.6 s, against 3.9–4.1 s. Each audio load is numbered, and only the newest one
  may start playback when it ends, so a load overtaken by a pause, a seek and another Play can't start
  playback before the new spot's audio is in.
- A graphic (a `<code>` clip) is rebuilt only when its page stops answering. The preview asked a graphic's
  page for a frame with a 10 s timer that also covered fetching the frames of the videos inside it, so a
  slow video decode made Cardboard rebuild the page, which stays invisible until it draws: the preview
  went black for as long as that took. The page's timer now starts when the frame is sent. A slow fetch
  is waited for and its frame used when it comes; only one that hasn't answered in 30 s gets the old
  rebuild, so a hung decode still ends in Cardboard's "couldn't render" note.
- While playing, a graphic draws with the newest frame of its videos that is ready instead of waiting for
  the frame of that exact moment. Every frame of a graphic waited for its videos' frames, even with the
  video off screen, before the next could start, so a graphic with a video inside played at 26–41 frames/s
  on the test laptop (4–14 while it was busy) and froze for seconds when a decode was slow. Paused, scrubbing, and the first frame after Play still
  wait for the exact frame. Left out of `--baseline`.
- An open editor no longer wakes up on every screen refresh while nothing moves. Everything drawn over the
  preview (selection handles, a playing graphic, background removal, pending generations) is placed from where
  the preview's canvas is on screen, and Cardboard measured that on every refresh (up to 144 times a second on
  a 144 Hz screen) for as long as a project was open. Background project tabs did it too: they're stacked
  behind the front one, not hidden. Now it measures when something could have moved the canvas (the window or
  a panel resizing, a divider dragged, the preview zoomed, panned or given another aspect ratio, a scroll or
  transition around it, the pointer pressed or dragged), keeps measuring every frame while the canvas moves,
  and rests half a second after it stops. A check once a second catches anything else. On the test laptop an
  idle editor took about a fifth of a CPU core with one project open and about two thirds with four; now about
  1% and 2% (see "An idle editor" under Benchmarks). Left out of `--baseline`.
- The activity log notes the waits: Play waiting on audio over half a second, a second press forcing it,
  slow video frames for a graphic, graphics rebuilt, canvases given back.
- Clicking the timeline, or a clip in the preview, takes the keyboard from the agent's prompt box (or any other
  field outside them), as a click anywhere else in the editor already did. Both cancel the click's default
  action so a drag doesn't select text, and that also left the keyboard where it was: with the prompt box
  focused, Space after clicking a clip typed a space into the prompt instead of playing, and Delete, S and the
  arrows edited the prompt instead of the timeline. Checked by clicking the ruler, a clip, empty track space,
  a track header and a selected clip in the preview: before, Space typed into the prompt box after each of the
  five; now it plays after each. A click on the tracks, the ruler or the track headers also takes the keyboard
  from the timeline's own controls: after the zoom slider was used, → and ← zoomed the timeline as well as
  stepping the playhead, and now they only step it. The preview's text editing keeps its own behaviour.
- The editor's left rail (Library, Layout, Audio, Captions, Text, Transitions, Effects) shows each icon's name
  in a tooltip. Cardboard wraps every icon in its tooltip, but the rail's button dropped what the tooltip
  hands it (its hover and focus handlers), so none ever opened.

Badges in the agent's prompt box (a clip or media file mentioned with @, an attached file, a pasted link, a
skill) are one unit, and a click on one opens it. A badge is text in the box with a chip drawn over it, and
the caret could go inside it: a click on a badge put the caret between its letters (or, on its icon, between
the two spaces it starts with), and typing there broke the badge into loose text (`clip-a.mxp4`). Now a click
on a badge opens what it stands for, the way a link does, and the caret and the text stay as they were, also
while the button is down:
- a clip: selected on the timeline, the playhead at its start and the timeline scrolled to it, as a click on
  the clip there would; the keyboard goes to the editor, so Space plays it;
- a media file: Cardboard's own Media preview of it (the one its tile's Preview opens in the Library), found by
  the file's id, so it works for a file scrolled out of the Library, hidden by a Library search, or sharing its
  name with another. What the left panel shows stays as it is (a collapsed panel opens), and a selected clip
  stays selected;
- a sound effect from Audio, which the Library doesn't list: its clip on the timeline, or the Audio panel;
- an attached file or a skill: its file, in the app that opens it (Cardboard's Preview for attachments);
- a link: the browser.

A clip deleted since it was mentioned says it isn't on the timeline anymore. Escape closes a Media preview
opened this way and nothing else (it also cleared the timeline's selection, and with it a selected clip's
reference in the prompt). Over a badge the pointer is a
hand. From the keyboard a badge is one character wide: ← and → step over it, Shift+←/→ select it whole,
Ctrl+← and Ctrl+→ (Option on a Mac) take it as one word, ↑ and ↓ stop at its edge, and the caret never passes
through it on the way (the word moves went into it before being put right); a drag that ends on it takes it
whole, and Ctrl+Backspace and Ctrl+Delete (Option on a Mac) remove it whole as
Backspace and Delete already did, where they used to leave part of its name behind. The same goes for the link
badges in Report an Issue, whose Backspace took a link apart a letter at a time. Typing anywhere else, and the
arrows and deletes in plain text, work as before. On a caret move by the mouse or another
key only the characters around the caret are looked at; the prompt's badges are found when the caret is next
to one, and on a word move, or ↑ ↓ with badges in the prompt.

And Windows wording where Cardboard names the Mac: "this PC" for "this Mac" (Settings → Library, Agents,
the plans note, the library drive error) and File Explorer for Finder (Show in File Explorer, the project's reveal button, the
agent's reveal step). Cardboard words some text per platform already ("Show in Folder", Ctrl for ⌘); these
it missed. Each text is chosen when it's shown, so the same bundle still reads right on a Mac.

`scripts\patch-cli.js` (applied to `resources\cli\cardboard.mjs`) connects the CLI to that named pipe.

### Saves on Windows (`scripts\rename-retry.js`)

Imports lost clips on Windows. Cardboard saves `project.json` by writing a temp file and renaming it over
the old one. Windows refuses to replace a file that anything has open (`EPERM`), where macOS just replaces
it. Cardboard's library worker reads `project.json` back after every save, to tell its own writes from
outside edits. During an import the worker saves in bursts, so a save often landed while the previous one
was being read, and that clip's import failed. The clip got no filmstrip or waveform, or a "Could not
import" dialog appeared, or after reopening, a "Missing Media Files" prompt asked for a file that was still
in place. The faster imports made it more likely: 3 of 5 nine-file imports lost one or two clips. The `cb`
CLI, the Director, antivirus, the search indexer or cloud sync reading `project.json` can cause the same.

Main retries its own writes on Windows (4 tries, 50 ms apart); the library worker and the CLI didn't.
Now the rename behind every save in the worker and the CLI retries on `EPERM`, `EBUSY` and `EACCES` for up
to about 1.3 s (10, 20, 40 … 320 ms), as graceful-fs does. It goes into the library worker
(`patch-worker.js`) and the CLI (`patch-cli.js`). The CLI imports `rename` as an ES module binding,
which only follows the change once `syncBuiltinESMExports()` runs. Main is left as it is, since the retry
would multiply its own.

`scripts\patch-cli-media.js` (applied to `resources\cli\chunks\chunk-LL26E55H.mjs`) makes the same
media changes in the CLI's own copy of Cardboard's media code. `cb media add`, `cb media proxy` and
the Director's imports run that copy in the CLI process, not in the app. Unpatched, it encoded
proxies in software (libx264), since its hardware check only knew VideoToolbox. The same four clips
took 57.7 s with `cb media add` before, 16.4 s after.

`scripts\mac-scan.js` lists the macOS-specific calls in a bundle, for checking a new Cardboard version.

### Activity log

`%APPDATA%\ai.cardboard.desktop\logs\activity-<date>.jsonl`, one JSON object per line, kept 14 days. It
holds what the Director's transcripts (`<project>.cardboard\agent\chats\*.jsonl`) don't, and never text
typed into a field. Every line has `t` (local time) and `ev`; lines from a project have `project`.

| `ev` | What | Fields |
| --- | --- | --- |
| `app.start`, `app.quit` | Cardboard started or quit | `version`, `electron`, `os`, `displays` |
| `shortcut` | A shortcut ran | `id` (`split-at-playhead`, `next-tab`…), `combo`, `n` when pressed again and again |
| `menu` | A menu item ran | `item` (`File > New Project`), `via` (`accelerator` or `strip`), `combo` |
| `menu.open` | Alt or F10 opened the menu | `via` |
| `key` | A key with Ctrl/Alt/Win anywhere, or any key outside a text field, that ran no shortcut or menu item | `combo`, `handled` (`false`: nothing took it; `native`: it pressed a focused button, named in `on`), `field` (see below) |
| `director.answer` | An agent question was answered | `kind` (`generation`, `question`, `clone`), `outcome` (`approved`, `skipped`, `replied`, `answered`), `waitMs`, `via` (`key:Ctrl+Enter`, `pointer`…), `credits` |
| `toast` | An error or warning toast | `kind`, `msg`, `detail` |
| `error` | An uncaught error in a page | `msg`, `src`, `rejection` |
| `main.warn`, `main.error` | Main's warnings and errors (`[desktop] …`) | `msg` |
| `worker` | The library worker's output, with `[media]` notes on NVENC, CUDA and CPU fallbacks | `msg` |
| `gpu` | Which GPU draws the app, 15 s after start | `vendor` (PCI id: `0x10de` NVIDIA, `0x8086` Intel, `0x1002` AMD), `device`, `gpus` (how many), `asked` (`high-performance` or `default`, see patch 13) |
| `process.gone` | A GPU, utility or page process died | `type`, `reason`, `exitCode` |
| `canvas.restored` | The GPU gave the timeline's canvases back blank and they were redrawn | `what` (`ruler`, `tracks`) |
| `playback.wait` | Play waited over half a second for audio | `ms`, `timedOut` (the 8 s limit), `started` |
| `playback.forced` | A second Play started playback without waiting for audio | |
| `preview.slow` | A graphic's video frames took over a second (at most one line per 10 s) | `kind`, `ms` |
| `preview.rebuild` | A graphic's page stopped answering and was rebuilt | `reason` |
| `badge.open` | A badge in a prompt box was clicked open | `kind` (`item`, `media`, `attachment`, `skill`, `link`) |

`on` and `field` name a control by one of the fixed labels written into Cardboard's code ("Play", "Add media
files"), else by its analytics id (`director-question-option`), else by its role or tag (`button`,
`textarea`). They never use its text or a label made at run time, since those can hold what the user typed
("Steer the turn with: <the prompt>", "Rename <project>").

Each kind is capped at 120 lines a minute (`log.dropped` counts the rest). Lines are written in batches
once a second, off the main thread. The page's key listener costs 0.3 to 0.5 µs a keystroke (measured in
the editor), plus a 0.7 µs `setTimeout` for the keys it checks after the page has handled them.

### Testing the keyboard

`scripts\test-shortcuts.js` presses the shortcuts in a running Cardboard and checks each one did what it
should: the playhead, panels, dialogs and tabs over the DevTools protocol (`scripts\cdp.js`), edits in the
saved timeline through the CLI. Run it against a throwaway profile and library, not your own:

```sh
set CARDBOARD_USER_DATA=%TEMP%\cb-kbtest\userdata
set CARDBOARD_HOME=%TEMP%\cb-kbtest\home
Cardboard-win\Cardboard.exe --remote-debugging-port=9334
:: open a project whose timeline has two clips on one track, as the second tab, then:
node scripts/test-shortcuts.js <project-id> <that timeline as a .tsx file>
node scripts/test-shortcuts.js <project-id> <timeline.tsx> --os
```

Keys sent over DevTools go through Electron's `before-input-event` and the page as a keyboard's do, but
not the window menu's accelerators. Those tests (`--os`) press real keys with `scripts\sendkeys.ps1`,
which brings the window to the front and stops if another window takes it. On the build before the
keyboard changes, 20 of the 25 page tests passed. The five failures were Ctrl+Y, the Mac keyboard, the
missed Ctrl+D conflict, and the activity log, which didn't exist yet. With them, all 25 pass, and all 9
accelerator tests.

### Benchmarks

`scripts\bench\` measures builds against each other on one machine, the way someone uses Cardboard. It runs the real
app with a fresh profile and library each run, drives it over DevTools, and times the `cb` CLI that agents use.

To show what this port's speed changes do, it compares two builds:
- **baseline**: Cardboard's own pipeline, as it runs on a Mac. It has only what Windows needs to run it, and leaves
  out the speed changes in the media patches. `build-windows.js --baseline` builds it (`CB_BASELINE=1`). In it:
  - decoding happens on the CPU;
  - filmstrips decode every frame;
  - proxies are made one at a time, by the hardware encoder at Cardboard's fixed 12 Mb/s, as VideoToolbox makes them
    on a Mac.
- **ours**: the normal build.

The workflow publishes both: `Cardboard-1.4.0-windows-x64-baseline.exe` unpacks into `Cardboard-baseline\`. The
bugs the patches fix stay fixed in both.

```sh
node scripts/bench/media.js bench-media --ffmpeg Cardboard\resources\bin\ffmpeg.exe
node scripts/bench/run.js --build baseline=Cardboard-baseline --build ours=Cardboard
```

`media.js` makes six clips. They're synthetic, but they have what decides how much work an import is:
- 4K HEVC 10-bit from a phone, in landscape and in portrait (rotated);
- 4K60 H.264 from an action camera;
- a 1080p screen recording with a keyframe every 10 s;
- 1080p HEVC 10-bit;
- a WAV.

`run.js` runs 5 counted runs per build after a warm-up, alternating between the builds. It writes every run and the
medians to `bench-results\<date>\results.md` and `results.json`, together with the machine and the clips.
- **import** drops the clips on a new project, through the event the editor's Import Media sends. It waits until
  nothing has been written to the bundle's `media\`, `cache\`, `proxies\` and `converted\` folders for 15 s. It
  reports when the clips were listed, when the first thumbnail and the last file were written, and what was made.
  What was made must be the same for both builds.
- **cli** times `cb --help`, `project create`, `project list`, `source print` and `source apply` with the app closed.
- **cli-import** imports the same clips through `cb media add`. That runs the CLI's own copy of the import pipeline,
  patched as the app's is, and exits once every thumbnail, waveform and proxy is made. It needs no window and no
  sign-in.

Nothing the benchmarks do spends credits: no generation, transcription, captions, voices, mattes or footage search.
Every profile shares the stored sign-in (`%APPDATA%\ai.cardboard\account.json`), so sign in to Cardboard once
beforehand. Close Cardboard and plug the laptop in first: on battery, Windows slows the CPU and GPU.

#### Playback, the timeline and the GPU

Measured on one laptop (i5-12450HX, Intel UHD + RTX 3050 6 GB, Windows 11, on mains), the build before these
changes against the build after, each run in its own isolated instance, alternating builds, every run listed.
The graphic is a 20 s `<code>` clip with a video inside it (a real project's), played from the start for 19 s.

| | Before | After |
| --- | --- | --- |
| Graphic, frames drawn per second | 29.8, 37.2, 26.2 | 87.7, 77.7, 80.7 |
| Its wait for video frames, median per frame | 24, 20, 25 ms | 5, 4, 5 ms |
| Editor frames, slowest 5% | 27.7, 20.8, 20.9 ms | 7.6, 7.3, 7.6 ms |
| Editor frames over 50 ms (19 s) | 20, 20, 17 | 6, 6, 4 |
| Black preview frames | 0, 0, 0 | 0, 0, 0 |
| Memory (working set, all processes) | 3113, 3153, 3708 MB | 2800, 2796, 2842 MB |
| System RAM taken as GPU memory | 902, 603, 1031 MB | 36 MB (the RTX's own ~870 MB) |
| CPU while playing | 1.37, 1.56, 1.87 cores | 2.20, 2.23, 2.26 cores |

The CPU goes into drawing about 2.7 times as many frames: per frame drawn it is about 55% less. Split, with the
after build kept on the Intel GPU (Windows' per-app "Power saving"): the graphic alone went from 41.3, 39.8 to
72.4, 74.2 frames/s (+0.15 core), the editor's frame times did not change. The RTX gives the editor's smoothness
and the memory.

- Timeline after the GPU process restarts: 99.4% black at 1.5, 4 and 10 s before; redrawn by 1.5 s after.
- ← / → across the edge of the view and dragging the playhead past either edge: the playhead left the view in
  all four before; stays in view in all four after.
- Play right after a seek into a clip whose sound is extracted audio, every such read answered 3 s late: one press
  3.9–4.2 s before, 4.0–4.3 s after (the audio must load); a second press at 0.6 s, 3.9–4.1 s before, 0.81–0.83 s
  after; the clip's track muted, 4.0–4.1 s before, 0.18–0.22 s after. Without the delay, about 0.2 s in both.
- A pause, a seek and Play again while an earlier audio load still runs (reads 6 s late): without the load
  numbering playback started 1.5 s before the new spot's audio was in, with it after.
- Startup to the Dashboard on mains, 7 launches each, medians: first paint 2505 → 2589 ms, prompt box ready
  2354 → 2310 ms, largest paint 2891 → 3081 ms, working set 1123 → 1082 MB, private 810 → 1013 MB (the NVIDIA
  driver), idle CPU the same. The slowest launches were 0.6–0.8 s slower, when the RTX wakes late. Without the
  early wake, first paint was 260 ms slower at the median.
- Export at 1080p, on mains: the 60 s media timeline (4K HEVC and H.264 clips) took 159.2, 164.5, 160.8,
  158.4 s before and 156.4, 155.1, 150.7 s after, plus one run of 357.0 s while Windows Update installed a
  Windows Security platform update (in the System log at the same minutes). The 20 s graphic: 81.4, 117.5 s
  before, 68.0, 135.7 s after (as noisy in both). Outputs the same size and length.
- The 25 page tests of `scripts\test-shortcuts.js` pass on the after build.

#### An idle editor

The same laptop on mains, with a 144 Hz screen. The build before the preview's position loop rested is compared with
the build after, alternating, 5 runs each. Each run is a fresh isolated instance with fresh two-clip projects. It is
left untouched for 20 s, then measured for 60 s. CPU is the instance's processes together, as a share of one core.

| | Before | After |
| --- | --- | --- |
| One project tab: frame callbacks per second | 144.2, 144.2, 144.2, 144.2, 144.4 | 0 in every run |
| One project tab: CPU | 11.2, 21.5, 21.2, 19.0, 20.3% (median 20.3%) | 0.9, 0.4, 0.7, 1.1, 0.7% (median 0.7%) |
| … of which the GPU process | 3.0, 6.3, 5.9, 5.9, 6.5% | 0.2, 0.1, 0.3, 0.2, 0.2% |
| Four project tabs: frame callbacks per second | 578.8, 581.4, 538.2, 536.0, 542.8 | 0 in every run |
| Four project tabs: CPU | 68.7, 64.8, 66.4, 53.0, 52.5% (median 64.8%) | 1.6, 0.9, 2.9, 2.0, 3.2% (median 2.0%) |

A separate re-run measured with a Chromium trace and Windows' CPU counters instead, with the window pinned in
front, 3 runs per build, and got the same medians:
- one tab: 144.1 → 0 callbacks per second, 19.9% → 0.9% of a core;
- four tabs: 576.3 → 0 callbacks per second, 68.3% → 1.6% of a core.

Playing the 56 s timeline with the window in front, nothing changed: 143.5, 143.3, 143.3, 142.8 frames/s and
1.13, 1.13, 1.14, 1.12 cores before, against 143.1, 143.2, 136.7, 142.3 frames/s and 1.10, 1.14, 1.13, 1.11 cores
after. After the change, the position loop ran 0 times during playback.

These figures are for a window that is on screen. Normally Windows Chromium treats a completely covered window as
hidden, and a hidden window gets no frame callbacks, in either build. The runs above turn that detection off, so
that a window left behind others still counts as visible.

### Not ported

- The auto-updater (Squirrel.Mac) is still macOS-only, so updates won't install themselves.
- Gemini Argon downloads a macOS-only harness, so it stays unavailable.
- Cardboard's own Install button for Claude Code and Codex runs their macOS/Linux install scripts.
  Install them yourself on Windows, then click "Check again" in Settings → Agents.

### Rebuild

The patches match strings in minified code, so a new Cardboard version probably needs them
updated. Each `replace()` fails loudly if its target is missing.

From scratch, on Windows: `cd tools && npm ci`, then `node scripts/build-windows.js`. It downloads into
`dl\` what the app is made from, from where each is published: Cardboard 1.4.0 for Mac
(`assets.cardboard.ai`), Electron 43.7.0 for Windows, ffmpeg 8.1 (BtbN's win64 GPL build), uv 0.13.6 and
Claude Code 2.1.309 for Windows (npm). It then builds `out\Cardboard-win` and checks the versions of what it
bundles. It needs 7-Zip. The result is byte for byte the same as the `Cardboard-win\` built step by step, plus a
`build-info.json` that says which build it is (`--baseline` builds the benchmarks' baseline, see
[Benchmarks](#benchmarks)).
On GitHub, the same build runs by hand: Actions → Build Windows app → Run workflow
(`.github/workflows/build-windows.yml`). It publishes the app as the release `windows-latest`, replacing the
previous build: `Cardboard-1.4.0-windows-x64.exe` (with the baseline beside it), about 306 MB, which unpacks the app into a folder on
Windows 10 or 11 with nothing installed (7-Zip's LZMA2 behind its self-extractor; a zip would be about
500 MB). It isn't code-signed, so Windows may warn before running it.

Step by step, into the `Cardboard-win\` that is already there:

```sh
node scripts/patch-main.js asar-src/dist/main.js
node scripts/patch-worker.js asar-src/dist/library-worker.js
node scripts/patch-strip.js asar-src/dist/renderer/assets/tabs-DV5oCzuF.js
node scripts/patch-renderer.js asar-src/dist/renderer/assets/index-DufLJgUU.js asar-src/dist/renderer/assets/EditorRoute-CuIqwZKP.js asar-src/dist/renderer/assets/installErrorTelemetry-DxKId8tA.js
node tools/node_modules/@electron/asar/bin/asar.mjs pack asar-src Cardboard-win/resources/app.asar
node scripts/patch-cli.js Cardboard-win/resources/cli/cardboard.mjs cardboard.orig.mjs
node scripts/patch-cli-media.js Cardboard-win/resources/cli/chunks/chunk-LL26E55H.mjs cli-media.orig.mjs
```
