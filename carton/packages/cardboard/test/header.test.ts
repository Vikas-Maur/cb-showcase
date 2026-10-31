// The timeline.tsx header contract (§5.2): Carton refs, the print nonce, legacy 1.4.0 timestamps.
import test from "node:test";
import assert from "node:assert/strict";
import { renderRev, findRev, setRev, parseRevBody, printNonce } from "../src/header.ts";

// The shape of Cardboard's printed header block (our own sample text, not Cardboard's printer).
const printed = (rev: string) =>
  [`// Cardboard timeline for "Demo".`, "// Comments are not kept.", "// pending marks a placeholder.", `// cardboard:rev ${rev}`, "//", "", "export default (", '  <timeline aspect="16:9" />', ");", ""].join("\n");

test("renders and parses the full Carton header", () => {
  const line = renderRev({ ref: "main@57~3f9a1c0e", branchId: "1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809", nonce: "9f8e7d6c", by: "director/c/t1" });
  assert.equal(line, "// cardboard:rev main@57~3f9a1c0e b:1a2b3c4d p:9f8e7d6c by director/c/t1");
  const f = findRev(printed(line.slice("// cardboard:rev ".length)));
  assert.deepEqual(f?.rev, { kind: "carton", ref: "main@57~3f9a1c0e", branch8: "1a2b3c4d", nonce: "9f8e7d6c", by: "director/c/t1" });
});

test("a cut name with spaces survives as one token; an actor name keeps its spaces", () => {
  const line = renderRev({ ref: "30s Instagram cut@4", nonce: "00ff00ff", by: "Claude Code (terminal)" });
  assert.equal(line, "// cardboard:rev 30s%20Instagram%20cut@4 p:00ff00ff by Claude Code (terminal)");
  assert.deepEqual(findRev(line)?.rev, { kind: "carton", ref: "30s Instagram cut@4", branch8: null, nonce: "00ff00ff", by: "Claude Code (terminal)" });
});

test("a bare 13-digit number still parses, as 1.4.0's timestamp rev", () => {
  assert.deepEqual(findRev(printed("1793374963695"))?.rev, { kind: "legacy", rev: 1793374963695 });
  assert.deepEqual(parseRevBody(" 1793374963695 "), { kind: "legacy", rev: 1793374963695 });
});

test("two prints of one state differ only by their nonce", () => {
  const a = renderRev({ ref: "main@3", nonce: printNonce() });
  const b = renderRev({ ref: "main@3", nonce: printNonce() });
  assert.notEqual(a, b);
  assert.equal(findRev(a)?.rev && (findRev(a)!.rev as { ref: string }).ref, "main@3");
});

test("setRev replaces only the rev line, byte for byte elsewhere, and handles CRLF files", () => {
  const before = printed("1793374963695");
  const after = setRev(before, renderRev({ ref: "main@1", nonce: "abcdef01", by: "carton" }));
  assert.equal(after, before.replace("// cardboard:rev 1793374963695", "// cardboard:rev main@1 p:abcdef01 by carton"));
  const crlf = before.replace(/\n/g, "\r\n");
  const crlfAfter = setRev(crlf, "// cardboard:rev main@2");
  assert.equal(crlfAfter, crlf.replace("// cardboard:rev 1793374963695", "// cardboard:rev main@2"));
  assert.deepEqual(findRev(crlf)?.rev, { kind: "legacy", rev: 1793374963695 });
});

test("only the first rev line counts; a file without one gets it on top", () => {
  const two = "// cardboard:rev main@1\n// cardboard:rev main@2\n";
  assert.equal((findRev(two)?.rev as { ref: string }).ref, "main@1");
  assert.equal(findRev("export default (<timeline aspect=\"16:9\" />);"), null);
  assert.equal(setRev("x\n", "// cardboard:rev main@9"), "// cardboard:rev main@9\nx\n");
});
