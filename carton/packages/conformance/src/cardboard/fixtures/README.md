# Cardboard 1.4.0 fixtures

What Cardboard's own `cb` CLI (version 1.4.0) wrote and printed for **our own sample project**. The media were
generated with ffmpeg (a test pattern, sine tones and a flat colour), and the text is ours ("Carton fixture"). There is
no Cardboard code here. The `timeline.tsx` files are the CLI's printer output for our project, including the
explanatory comment header that the printer puts on every file.

`../make-fixtures.ts` builds them. `../cli-codec.test.ts` checks them against the real CLI: a fresh print of
`sample/project.json` must equal `sample/timeline.tsx`, and replaying each edit case must give its committed
`apply.json` and `project.after.json`.

## Files

| Path | What it is |
|---|---|
| `sample/project.json` | project.json of the sample after `media add` and one `source apply` of our timeline |
| `sample/timeline.tsx` | the `timeline.tsx` the CLI wrote next to it, equal to `cb source print` |
| `edit-<case>/before.tsx` | the text the agent read: the sample's print (rev R1 on line 4) |
| `edit-<case>/after.tsx` | the agent's edit of it; the header is unchanged, so it still names R1 |
| `edit-<case>/project.before.json` | the project when the agent applied |
| `edit-<case>/project.after.json` | the project after `cb source apply <bundle> - --json < after.tsx` |
| `edit-<case>/apply.json` | that command's stdout, byte for byte |
| `edit-nested-concurrent/base.rev.json` | `.revs/<R1>.json`, the snapshot the CLI wrote for R1: the merge base of this case |

**One substitution.** project.json stores media paths as absolute paths (`media[].nativePath`). The scratch library
root in them is replaced by `/FIXTURE`, so `/FIXTURE/Sample.cardboard/media/<id>.mp4`. Nothing else is changed: no
field is dropped, re-ordered or re-formatted, and nothing is trimmed. The thumbnail lists are short (a 2 s clip). The
`.tsx` and `apply.json` files hold no paths. The fixtures were made on Linux; on Windows the remainder of each path
would keep its backslashes.

Ids, timestamps and revs are random or wall-clock, so every run of `make-fixtures.ts` rewrites every file.

## How they were made

Node 24.21, ffmpeg 8.0.1 (Ubuntu), Cardboard 1.4.0's `Contents/Resources/cli/cardboard.mjs` from the macOS app, run
by Node on Linux. Every CLI call runs as `node $CLI --root <library> …`. Its environment has `CARDBOARD_FFMPEG` and
`CARDBOARD_FFPROBE` set to the system ffmpeg, no other `CARDBOARD_*` variable, and HOME (and the Windows/XDG
equivalents) pointed into the scratch folder, so nothing reads or writes a real Cardboard profile or library.

```sh
# media (each also gets -hide_banner -loglevel error -y)
ffmpeg -f lavfi -i testsrc=size=64x64:rate=24:duration=2 -f lavfi -i sine=frequency=440:duration=2 -c:v libx264 \
  -pix_fmt yuv420p -c:a aac -shortest -flags:v +bitexact -flags:a +bitexact -fflags +bitexact -map_metadata -1 clip.mp4
ffmpeg -f lavfi -i sine=frequency=220:duration=3 -c:a libmp3lame -b:a 32k -flags:a +bitexact -fflags +bitexact \
  -map_metadata -1 tone.mp3
ffmpeg -f lavfi -i color=c=0x3366cc:size=64x64 -frames:v 1 -flags:v +bitexact -fflags +bitexact -map_metadata -1 logo.png

# the sample (LIB = <scratch>/make-fixtures/carton-cb-*/lib)
node $CLI --root $LIB --version                                     # 1.4.0, or the script stops
node $CLI --root $LIB project create Sample
node $CLI --root $LIB media add Sample clip.mp4 tone.mp3 logo.png --json
node $CLI --root $LIB source apply $LIB/Sample.cardboard - --json < sample.tsx   # SAMPLE_TSX in make-fixtures.ts
node $CLI --root $LIB source print $LIB/Sample.cardboard            # must equal Sample.cardboard/timeline.tsx

# each case: a copy of Sample.cardboard (with its .revs) in a library of its own, CASE = <scratch>/…/cases/<case>
node $CLI --root $CASE source apply $CASE/Sample.cardboard - --json < editor.tsx  # nested-concurrent only
node $CLI --root $CASE source apply $CASE/Sample.cardboard - --json < after.tsx   # → apply.json
```

To replay a case: write `project.before.json` as `<lib>/<Name>.cardboard/project.json`, alone in its library (1.4.0
refuses to read a bundle when another bundle in the same library shares a project or media id). For
`edit-nested-concurrent`, also write `base.rev.json` as `.revs/<its rev>.json`. Then apply `after.tsx`.

## What the sample covers

Six tracks (caption, two video tracks, adjustment, the video track the shader sits on, audio) and nine items: caption,
text, code, adjustment, shader, two video clips, image, audio. Between them they use:

- the time fields: `startTime`, `endTime`, `trimStart`, `trimEnd` (`in`/`out` in the text), and `playbackSpeed: 2`;
- `transform` (with `flipX`), `crop`, `opacity`, `zIndex`, `volume`, `audioFadeIn`/`audioFadeOut`;
- `colorGrading` and `colorGrade`, with nested `wheels`, `curves` and `saturation`;
- `transitionIn`/`transitionOut`, `textAnimation`, `effects[]` with ids, `keyframeTracks[]`;
- `captionSegments[]` with `wordTimings`, and `captionWordTimings`;
- a code item, whose source lives in `media[].data.code.source`;
- a shader item with `params`, `controls` and `fadeIn`.

What the apply added beyond what we wrote:

- `colorGrading` is filled out to all ten keys, with neutral values for the ones we left out.
- `Clip A fast` gained `autoReframe: true`. The editor's framing does this for a clip added with no `transform` and no
  x/y/scale keyframes.
- Text and code items gained a `mediaItemId`, pointing at a media item synthesized for them. For text that is
  `data.content`; for code it is `data.code` with the source. The print does not show this id.
- In project.json, the code item's `codeComposition` has no `source`. In `.revs` (`base.rev.json`) it is inlined.

What the print does to the text:

- Every item gets `in`/`out`.
- Attributes are printed in this order: `id`, `name`, `src`, `start`, `end`, `in`, `out`, then the rest alphabetically.
- Every element spans several lines, even ones we wrote on one line.

## Edit cases

**`edit-trim-move-add-remove`**: one agent edit to disjoint items. The project before is the sample, and nothing changed
in the app since the print.

- It trims the Logo's start by 0.25 s (`start`, `in`), moves Tone 0.5 s later (`start`, `end`), adds a text item with
  no id after the badge, and removes `Clip A fast`.
- `apply.json` has four ops:
  - `addItem`: a new id and a synthesized `mediaItemId`; a text media item is appended to `project.media`;
  - `updateItem` Logo `{startTime, trimStart}`;
  - `updateItem` Tone `{startTime, endTime}`;
  - `removeItems`.
- **A side effect that no op shows:** `Clip A` lost its `transitionOut`, although `after.tsx` still has it unchanged.
  `Clip A` ends at 1.5 s, where `Clip A fast` started, and removing an item clears the transitions of neighbours that
  touch it.

**`edit-nested-concurrent`**: a 3-way merge.

- The agent read the print at R1. Since then the app changed the Title's `fontSize` 96 → 120 and saved, as rev R2. A
  CLI apply stands in for the GUI save here; `project.before.json` is R2.
- The agent's file changes one wheel inside the adjustment's `colorGrade`, the `radius` inside `Clip A`'s
  `effects[0]`, and the Title's `color`.
- The result has three `updateItem` ops, and `conflicts: [{kind: "item", id: <Title>}]`.
  - `colorGrade` and `effects` are sent and replaced whole, not as the changed key.
  - The Title keeps the app's `fontSize: 120` and takes the agent's colour. Fields apply one by one; conflicts are
    reported per item.

## Header contract probe

What 1.4.0 does when Carton's header takes the place of Cardboard's rev line:

```
// cardboard:rev main@57~3f9a1c0e b:1a2b3c4d p:9f8e7d6c by director/c/t1
```

`cli-codec.test.ts` runs the probe ("header contract probe", one test per row).

**Method.** The state is `edit-nested-concurrent`'s:

- The bundle holds the sample project with `.revs/<R1>.json` (`base.rev.json`).
- The CLI then applies the app's fontSize change, so it records R2 itself and `.revs` holds R1 and R2.
- The agent's file is `edit-nested-concurrent/after.tsx` with its rev line changed as below. It is applied with
  `source apply - --json` to a fresh copy of that bundle for each variant.

The outcome shows which base the apply used:

- **three-way**: the base is R1. The app's `fontSize: 120` survives, and the Title is reported as a conflict.
- **two-way**: no base. The file is diffed against the current timeline, so its stale `fontSize: 96` overwrites the
  app's 120 (the Title's op is `{fontSize: 96, color}`), and no conflict is reported.

In every variant the file parsed and applied (`applied: true`), with no diagnostic or warning about the header, and the
agent's own change (the colour) landed.

| Rev line(s) in the agent's file | Result |
|---|---|
| `// cardboard:rev R1` on line 4 (control) | three-way |
| **Carton's header on line 4** | **two-way** |
| no rev line at all | two-way |
| Carton's header on line 4, `// cardboard:rev R1` on line 5 | three-way |
| `// cardboard:rev R1` on line 1, Carton's header on line 4 | three-way |
| Carton's header on line 4, `// cardboard:rev R1` just above `export default (` | three-way |
| Carton's header on line 4, `// cardboard:rev R1` after the closing `);` | three-way |
| Carton's header on line 4, `// cardboard:rev R1` indented between the attributes of a `<caption` tag | three-way |
| `//cardboard:rev R1` (no space after `//`) | three-way |
| the whole file with CRLF line ends | three-way |
| `// cardboard:rev R1 main@57~3f9a1c0e` (more text after the digits) | two-way |
| `/* cardboard:rev R1 */` | two-way |
| `// cardboard:rev 1` (older than every snapshot) | two-way |
| `// cardboard:rev 1` on line 4, then `// cardboard:rev R1` on line 5 | two-way: the first rev line wins |
| `// cardboard:rev 9999999999999` (newer than every snapshot) | two-way* |

\* The base becomes the newest snapshot, which is the current timeline, so the result is the same as having no base.

**What 1.4.0 does:**

1. **It still parses and applies.** A Carton header on line 4 is just a comment to the parser. The apply succeeds with
   no warning, and nothing in the result says the rev was not found.
2. **The rev becomes undefined, and the apply is 2-way against the current timeline.** Whatever the app changed since
   the print, on any item the file also prints, is silently reverted to the file's stale values, and `conflicts` is
   empty. This is the same as a file with no rev line, or one whose base has been pruned from `.revs` (the newest 20
   are kept).
3. **The rev line may sit anywhere.** 1.4.0 takes the first line, anywhere in the file, that holds only `//`, optional
   spaces, `cardboard:rev`, spaces and digits. Leading indentation and trailing whitespace (a CR) are fine. Line 1,
   line 5, just above `export default`, after `);` at the end, and between the attributes of a JSX tag all worked.
   Text after the digits on the same line, or a block comment, is not a rev line. With two rev lines, the first wins.
4. **`apply.json`'s `rev` is the project's new rev after the apply, not the base.** No field reports which base was
   used: it shows only through `conflicts` and the ops.

**For Carton's header:** keep Cardboard's `// cardboard:rev <ms>` as a line of its own, the first of its kind in the
file. Put Carton's identity on a separate comment line that does not match the pattern. The proposed
`// cardboard:rev main@…` line does not match (letters follow `rev`), so it is harmless next to the numeric line. A
prefix of Carton's own (`// carton: …`) would say the same without looking like Cardboard's.

A Carton line written into the bundle's own `timeline.tsx` does not outlive the next apply. I checked once by hand
(`cb source apply <bundle> --json`, no file argument, Carton's header on line 4 and the rev on line 5). After an apply
with one op, and again after one with no ops, the CLI had re-printed the file with only its own header, and Carton's
line was gone.
