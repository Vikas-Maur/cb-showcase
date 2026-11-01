// The formatter cache follows the system time zone (Stage F review F-6). Its own file: it changes TZ for its process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { exactTime } from "../src/format.ts";

test("F-6: a zone change with the same offset today (Lagos → Paris in winter) still rebuilds the formatters", () => {
  const was = process.env.TZ;
  try {
    const summer = Date.UTC(2026, 6, 15, 12, 0);
    process.env.TZ = "Africa/Lagos";
    assert.match(exactTime(summer, "en-GB"), /13:00/);
    process.env.TZ = "Europe/Paris";
    assert.match(exactTime(summer, "en-GB"), /14:00/, "Paris is UTC+2 in July");
  } finally {
    if (was === undefined) delete process.env.TZ;
    else process.env.TZ = was;
  }
});
