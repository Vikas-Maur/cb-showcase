// Cardboard timeline for "Launch Teaser". Regenerated on every save; a saved edit applies to the project.
// Comments are not kept. Attribute values are literals. `cb docs source` has the element reference.
// `pending` marks a placeholder item whose src/codeComposition is not written yet; filling it keeps its id.
// cardboard:rev 1793102345118
//
// 9:16 · 24.0s · 4 tracks · 9 items (1 pending)
//
// media (src takes the name, or the id when a name repeats):
//   founder-talk.mp4    96.4s    1920x1080  29.97fps  video  proxy ready    med_7Hc2kQ
//   desk-broll.mov      18.2s    3840x2160  23.98fps  video  proxy ready    med_9xLpA1
//   product-shot.png              2048x2048          image                  med_P0x8Zr
//   lofi-beat.mp3       142.0s                       audio                  med_m3Qa7T
//
// cast (@Name in cb generate video prompts): Priya (cast_4kd9)
//
// diagnostics: none

// Dummy example written by hand for study. The header follows the format of
// Cardboard 1.4.0's printer; attribute order inside elements is approximate.

export default (
  <timeline aspect="9:16">
    <track id="trk_titles" kind="video" name="Titles">
      <text id="itm_title" name="Hook title" start={0.5} end={3} textContent="We cut editing time by 10x" fontFamily="Geist" fontSize={88} color="#FFFFFF" textAnimation="pop" />
      <code id="itm_stat" name="Stat counter" start={12} end={16} pending />
    </track>
    <track id="trk_broll" kind="video" name="B-roll">
      <clip id="itm_broll1" name="Desk wide" src="desk-broll.mov" start={6} end={9.5} in={2} out={5.5} opacity={1} transitionIn={{ type: "dissolve", duration: 0.3 }} />
      <image id="itm_product" name="Product" src="product-shot.png" start={16} end={19} transform={{ x: 0, y: -120, scale: 0.8, rotation: 0 }} />
    </track>
    <track id="trk_main" kind="video" name="Main">
      <clip id="itm_a1" name="Intro" src="founder-talk.mp4" start={0} end={6} in={12.4} out={18.4} autoReframe />
      <clip id="itm_a2" name="Problem" src="founder-talk.mp4" start={6} end={16} in={31} out={41} autoReframe />
      <clip id="itm_a3" name="CTA" src="founder-talk.mp4" start={16} end={24} in={80.2} out={88.2} autoReframe colorGrade={{ saturation: 1.1 }} />
    </track>
    <track id="trk_music" kind="audio" name="Music">
      <audio id="itm_music" name="Beat" src="lofi-beat.mp3" start={0} end={24} in={10} out={34} volume={35} audioFadeOut={1.5} />
    </track>
    <track id="trk_caps" kind="caption" name="Captions">
      <caption id="itm_caps" start={0} end={24} preset="beast-mode" captionSegments={[{ text: "We cut editing time", start: 0.6, end: 1.9 }, { text: "by 10x", start: 1.9, end: 2.7 }]} />
    </track>
  </timeline>
);
