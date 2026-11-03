// Design QA G14 (fix/ux2-a): a change row's sentence doesn't say its own time again, and a sentence's place in the edit
// is found whole, so a History row title is cut before it, never inside its timecode.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sentenceTail, withoutSameTime } from "../src/components/ChangeRow.ts";

test("design QA G14: a move's '(now starts at X)' goes when X is the row's time; any other place stays", () => {
  assert.equal(withoutSameTime("Moved “Summer launch” 1 s earlier (now starts at 0:05)", "0:05"), "Moved “Summer launch” 1 s earlier");
  assert.equal(withoutSameTime("Moved “Summer launch” 1 s earlier to V2 (now starts at 1:02:05)", "1:02:05"), "Moved “Summer launch” 1 s earlier to V2");
  assert.equal(withoutSameTime("Moved “Summer launch” 1 s earlier (now starts at 0:05)", "0:06"), "Moved “Summer launch” 1 s earlier (now starts at 0:05)", "another time: kept");
  // a trim's ", now ends at" says which end: kept
  assert.equal(withoutSameTime("Trimmed “Intro”, now ends at 0:05", "0:05"), "Trimmed “Intro”, now ends at 0:05");
  assert.equal(withoutSameTime("Added caption “meet the team”", "0:06"), "Added caption “meet the team”");
});

test("design QA G14: a sentence's place, whole: the head before it and the tail with its comma or bracket", () => {
  assert.deepEqual(sentenceTail("Trimmed “Product close-up”, now ends at 0:15"), { head: "Trimmed “Product close-up”", tail: ", now ends at 0:15", at: "0:15" });
  assert.deepEqual(sentenceTail("Moved “Interview B” 2 s later (now starts at 0:18)"), { head: "Moved “Interview B” 2 s later", tail: " (now starts at 0:18)", at: "0:18" });
  assert.deepEqual(sentenceTail("Moved “Interview B” 2 s later"), { head: "Moved “Interview B” 2 s later", tail: "", at: null });
  // a quoted name that holds the words is not a tail
  assert.deepEqual(sentenceTail("Renamed “A” to “now ends at 0:05 soon”"), { head: "Renamed “A” to “now ends at 0:05 soon”", tail: "", at: null });
});
