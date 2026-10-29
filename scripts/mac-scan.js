// Lists macOS-specific calls in a bundle with a little context, one line per hit.
// Usage: node mac-scan.js <bundle.js> [width]
const s = require("fs").readFileSync(process.argv[2], "utf8");
const w = Number(process.argv[3] || 110);
const pats = [
  /"osascript"/g, /"\/usr\/bin\/[a-z]+"/g, /"\/bin\/(ba|z)?sh"/g, /"\/sbin\/[a-z]+"/g, /"(security|mdfind|mdls|sips|afplay|afconvert|say|screencapture|xattr|codesign|spctl|ditto|hdiutil|diskutil|launchctl|defaults|pbcopy|caffeinate|tccutil)"/g,
  /systemPreferences\.[a-zA-Z]+/g, /\.dock\b/g, /setAboutPanelOptions/g, /TouchBar/g, /"open-file"/g, /"open-url"/g,
  /autoUpdater/g, /moveToApplicationsFolder|isInApplicationsFolder/g, /vibrancy|visualEffectState|trafficLightPosition|setWindowButtonVisibility/g,
  /setRepresentedFilename|setDocumentEdited|addRecentDocument/g, /desktopCapturer/g, /setLoginItemSettings/g,
  /"\/Applications"/g, /"\/Volumes"/g, /"Library"/g, /\.app","Contents"/g, /"Contents","MacOS"/g, /Squirrel/g, /avfoundation/gi, /videotoolbox/gi, /audiotoolbox/gi, /ScreenCaptureKit|screencapturekit/g,
];
const seen = new Set();
for (const re of pats) {
  let m, n = 0;
  while ((m = re.exec(s))) {
    const key = Math.floor(m.index / 300);
    if (seen.has(key)) continue;
    seen.add(key); n++;
    console.log(`${m.index}\t${m[0]}\t${s.slice(Math.max(0, m.index - w), m.index + w).replace(/\s+/g, " ")}`);
  }
}
