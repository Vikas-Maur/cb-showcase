// The room's message cap is in UTF-8 bytes, counted without encoding (utf8Over).
import { test } from "node:test";
import assert from "node:assert/strict";
import { utf8Over } from "../src/room.ts";

test("utf8Over agrees with TextEncoder at the boundary, for 1-, 2-, 3- and 4-byte characters", () => {
  const enc = new TextEncoder();
  for (const unit of ["a", "é", "€", "😀", "a€😀é"]) {
    for (const reps of [1, 7, 100, 3333]) {
      const s = unit.repeat(reps);
      const bytes = enc.encode(s).byteLength;
      for (const cap of [bytes - 1, bytes, bytes + 1, Math.floor(bytes / 2)]) assert.equal(utf8Over(s, cap), bytes > cap, `${JSON.stringify(unit)}×${reps}, cap ${cap}`);
    }
  }
  // a string whose UTF-16 length is under the cap but whose bytes are over: the case the check exists for
  assert.equal(utf8Over("€".repeat(1000), 2000), true);
});
