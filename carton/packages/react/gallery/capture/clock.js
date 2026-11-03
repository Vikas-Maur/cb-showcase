// The capture page's clock (gallery code): build.mjs puts it ahead of the bundle, so it runs before any module.
// One fixed clock for every page (Tue 3 Nov 2026, 2:30:20 PM local, then running): the mock's times, "N min ago" and
// the day headers come out the same on every run, so React, Preact and later "after" shots compare pixel for pixel.
// `?clock=real` keeps the real one.
if (new URLSearchParams(location.search).get("clock") !== "real") {
  const RealDate = Date, t0 = new RealDate(2026, 10, 3, 14, 30, 20).getTime(), p0 = performance.now();
  const now = () => Math.round(t0 + performance.now() - p0);
  globalThis.Date = class extends RealDate {
    constructor(...a) { super(...(a.length ? a : [now()])); }
    static now() { return now(); }
  };
}
