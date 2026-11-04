// Carton UX v2 on the real Windows laptop (fix/ux2-laptop): the words. Quotes typed into a prompt or a version's name
// read as the panel's own curly ones (P3-12); "You have a comparison ready" for the person's own `cb compare --show`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { curlyQuotes, versionLabel } from "../src/format.ts";
import { words } from "../src/words.ts";
import type { Version } from "../src/model.ts";

test("curlyQuotes: straight quotation marks typed in a prompt or a name read as the panel's own (laptop P3-12)", () => {
  assert.equal(curlyQuotes('Make the title say "Summer launch"'), "Make the title say ‘Summer launch’");
  assert.equal(curlyQuotes("Use the 'wide' take"), "Use the ‘wide’ take");
  assert.equal(curlyQuotes("Leo's intro"), "Leo's intro", "an apostrophe stays");
  assert.equal(curlyQuotes("plain"), "plain");
  const v = { id: "v1", ref: "main@3", at: Date.now(), kind: "edit", author: { key: "agent/director", kind: "agent", name: "Director" }, turn: { label: 'Say "Hi" at the start', edits: 1 } } as unknown as Version;
  assert.equal(versionLabel(v, { start: true }), "Director's “Say ‘Hi’ at the start”");
  const named = { ...v, author: { key: "me", kind: "human", name: "Alice", isYou: true }, turn: undefined, name: 'The "final" cut' } as unknown as Version;
  assert.equal(versionLabel(named), "“The ‘final’ cut”");
});

test("words: the person's own ask reads “You have a comparison ready”; a moved clip's slate says where it is", () => {
  assert.equal(words.comparisonReady("You", "“Sent to client”", "your edit now"), "You have a comparison ready: “Sent to client” with your edit now.");
  assert.equal(words.comparisonReady("Director", "a", "b"), "Director has a comparison ready: a with b.");
  assert.equal(words.elsewhereInSide("“Shot A”", "your edit now", "later"), "“Shot A” is later in your edit now");
});
