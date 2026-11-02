// Cardboard timeline for "Sample". Regenerated on every save; a saved edit applies to the project.
// Comments are not kept. Attribute values are literals. `cb docs source` has the element reference.
// `pending` marks a placeholder item whose src/codeComposition is not written yet; filling it keeps its id.
// cardboard:rev 1793425009835
//
// 16:9 · 4.0s · 6 tracks · 9 items
//
// media (src takes the name, or the id when a name repeats):
//   clip.mp4  2.0s     64x64      24fps   video  proxy none  01844285-467f-4af0-af48-43658c21f256
//   tone.mp3  3.0s                        audio  7ceeea7f-680c-4cb7-9be0-78f477f57d8a
//   logo.png           64x64              image  edd23e4e-bd57-4a04-b886-a3d039d48862
//
// diagnostics: none

export default (
  <timeline aspect="16:9">
    <track id="b5035ff0-36f4-4dc2-b46c-3a8aee2efa54" kind="caption" name="Captions">
      <caption
        id="d50fc979-3a18-4d7f-8649-6119a9704f95"
        name="Fixture captions"
        start={0}
        end={3}
        in={0}
        out={3}
        captionPosition="bottom"
        captionSegments={[
          {
            id: "seg-1",
            text: "Carton",
            startTime: 0,
            endTime: 0.6,
            wordTimings: [{ word: "Carton", start: 0, end: 0.6 }],
          },
          {
            id: "seg-2",
            text: "fixture",
            startTime: 0.6,
            endTime: 1.4,
            wordTimings: [{ word: "fixture", start: 0.6, end: 1.4 }],
          },
        ]}
        captionText="Carton fixture"
        captionWordTimings={[{ word: "Carton", start: 0, end: 0.6 }, { word: "fixture", start: 0.6, end: 1.4 }]}
      />
    </track>
    <track id="60abc765-a938-4a7f-8031-944fda60fff4" name="Titles">
      <text
        id="30ff46b4-c367-44a3-ac22-505b9777a940"
        name="Title"
        start={0.5}
        end={2.5}
        in={0}
        out={2}
        color="#f3eee6"
        fontSize={96}
        keyframeTracks={[
          {
            property: "opacity",
            keyframes: [{ time: 0, value: 0 }, { time: 0.3, value: 1 }],
            easing: "ease-in-out",
          },
        ]}
        textAnimation={{ preset: "fade-up", duration: 0.4 }}
        textContent="Carton fixture"
        transitionIn={{ type: "fade", duration: 0.25 }}
      />
      <code
        id="468e7563-9f1f-41c1-af54-250e579bd927"
        name="Fixture badge"
        start={2.5}
        end={4}
        in={0}
        out={1.5}
        codeComposition={{
          width: 320,
          height: 180,
          source: "export default function Badge({ time }) {\n  return <div style={{ opacity: Math.min(1, time) }}>Carton</div>;\n}\n",
        }}
      />
      <text name="End card" start={4} end={5} textContent="Carton end card" fontSize={64} color="#ffffff" />
    </track>
    <track id="4b939f67-48cb-4d33-8019-1e065e11b58e" kind="adjustment" name="Grade">
      <adjustment
        id="c52c2e81-ec41-4608-8883-97f5a81279f5"
        name="Warm grade"
        start={0}
        end={4}
        in={0}
        out={4}
        colorGrade={{
          wheels: { lift: { r: 0.02, b: -0.02 }, gamma: { y: 0.05 } },
          curves: { master: [[0, 0], [0.5, 0.55], [1, 1]] },
          saturation: 1.1,
        }}
        colorGrading={{
          brightness: 0,
          contrast: 0,
          saturation: 0,
          exposure: 0.2,
          highlights: 0,
          shadows: 0,
          temperature: 15,
          tint: 0,
          vibrance: 0,
          gamma: 1,
        }}
      />
    </track>
    <track id="c4a266fc-3302-475f-8cd2-9c4da2b71d60" name="FX">
      <shader
        id="88136724-4d53-4c1b-a40e-c57b7cc51439"
        name="Fixture wash"
        start={1}
        end={2}
        in={0}
        out={1}
        shaderComposition={{
          source: "void main() {\n  fragColor = mix(texture(u_input, v_uv), vec4(1.0), strength);\n}",
          params: { strength: 0.2 },
          controls: { strength: { label: "Strength", min: 0, max: 1, step: 0.01 } },
          fadeIn: 0.2,
        }}
      />
    </track>
    <track id="d90f4643-a27d-4c14-9596-c1e1d49f64a9" name="V1">
      <clip
        id="ea445e63-36cc-4cba-a675-0babce7390cb"
        name="Clip A"
        src="clip.mp4"
        start={0}
        end={1.5}
        in={0.25}
        out={1.75}
        crop={{ top: 0, right: 5, bottom: 0, left: 5 }}
        effects={[{ id: "fx-blur-1", type: "blur", radius: 4 }]}
        opacity={0.9}
        transform={{ x: 10, y: -5, scale: 1.2, rotation: 3 }}
        transitionOut={{ type: "crossfade", duration: 0.2 }}
        volume={80}
      />
      <image
        id="e37d3bde-543a-4837-9bbc-d16aefb9d7ab"
        name="Logo"
        src="logo.png"
        start={2.75}
        end={4}
        in={0.25}
        out={1.5}
        transform={{ x: 0, y: 0, scale: 0.5, rotation: 0, flipX: true }}
        zIndex={2}
      />
    </track>
    <track id="d5cabb9a-af50-4753-bad5-e58343cedc3c" kind="audio" name="Music">
      <audio
        id="beb8874f-a8e4-4ebc-8cba-1d5a74195d87"
        name="Tone"
        src="tone.mp3"
        start={0.5}
        end={3.5}
        in={0}
        out={3}
        audioFadeIn={{ duration: 0.5, easing: "ease-in" }}
        audioFadeOut={{ duration: 1 }}
        volume={60}
      />
    </track>
  </timeline>
);
