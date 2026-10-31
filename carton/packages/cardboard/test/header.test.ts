// The timeline.tsx header contract (§5.2): Carton refs, the print nonce, legacy 1.4.0 timestamps.
import test from "node:test";
import assert from "node:assert/strict";
import { branchToken as coreBranchToken } from "@carton/core";
import { renderRev, findRev, setRev, parseRevBody, printNonce, revBody, branchToken } from "../src/header.ts";

// The shape of Cardboard's printed header block (our own sample text, not Cardboard's printer).
const printed = (rev: string) =>
  [`// Cardboard timeline for "Demo".`, "// Comments are not kept.", "// pending marks a placeholder.", `// cardboard:rev ${rev}`, "//", "", "export default (", '  <timeline aspect="16:9" />', ");", ""].join("\n");

test("renders and parses the full Carton header", () => {
  const line = renderRev({ ref: "main@57~3f9a1c0e", branchId: "1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809", nonce: "9f8e7d6c", by: "director/c/t1" });
  assert.equal(line, "// cardboard:rev main@57~3f9a1c0e b:1a2b3c4d p:9f8e7d6c by director/c/t1");
  const f = findRev(printed(line.slice("// cardboard:rev ".length)));
  assert.deepEqual(f?.rev, { kind: "carton", ref: "main@57~3f9a1c0e", branch8: "1a2b3c4d", nonce: "9f8e7d6c", by: "director/c/t1" });
});

test("core's format: a cut name with spaces runs up to b:, an actor name keeps its spaces", () => {
  const line = renderRev({ ref: "30s Instagram cut@4~0badf00d", branchId: "1a2b3c4d-0000", nonce: "00ff00ff", by: "Claude Code (terminal)" });
  assert.equal(line, "// cardboard:rev 30s Instagram cut@4~0badf00d b:1a2b3c4d p:00ff00ff by Claude Code (terminal)");
  const rev = findRev(line)?.rev;
  assert.deepEqual(rev, { kind: "carton", ref: "30s Instagram cut@4~0badf00d", branch8: "1a2b3c4d", nonce: "00ff00ff", by: "Claude Code (terminal)" });
  assert.equal(revBody(rev as never), line.slice("// cardboard:rev ".length), "round trip to the string core's parseRef reads");
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

// core's ref parser (core/src/history/history.ts REF_RE): b: is exactly 8 lowercase hex characters
const CORE_REF = /^(.+)@(\d+)~([0-9a-f]{8}) b:([0-9a-f]{8})(?: p:(\S+))?(?: by (.+))?$/;

test("b: names any cut id in the 8 lowercase hex characters core reads; ids core makes keep their first 8 (local-cli)", () => {
  assert.equal(branchToken, coreBranchToken, "core's one definition, re-exported: the header format has one owner");
  assert.equal(branchToken("b7e1c2d3-0000-4000-8000-000000000000"), "b7e1c2d3", "a UUID (core's ids): as core prints it");
  assert.equal(branchToken("0123456789abcdef01234567.2"), "01234567", "`cb cut new`'s ids: as core prints it");
  const odd = ["b6b.alt", "ab-cdef01234", "\u00c9CLAT-cut", "main", "B7E1C2D3-0000", "abc"];
  for (const id of odd) assert.match(branchToken(id), /^[0-9a-f]{8}$/, id);
  assert.equal(new Set(odd.map(branchToken)).size, odd.length, "distinct ids, distinct tokens");
  assert.equal(branchToken("b6b.alt"), branchToken("b6b.alt"));
});

test("any cut id and any cut name round-trip through the header, in the form core's parser reads (local-cli)", () => {
  const cases: [string, string][] = [
    ["Alt@3~abcdef01", "b6b.alt"],
    ["Alt@3~abcdef01", "ab-cdef01234"],
    ["Alt@3~abcdef01", "\u00c9CLAT-cut"],
    ["Version by Alice@3~abcdef01", "0123abcd-0000"],
    ["x p:1 b:12345678 cut@2~abcdef01", "0123abcd.1"],
    ["main@57~3f9a1c0e", "1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809"],
  ];
  for (const [ref, id] of cases) {
    const line = renderRev({ ref, branchId: id, nonce: "1234abcd", by: "Claude Code (by the terminal)" });
    const rev = findRev(printed(line.slice("// cardboard:rev ".length)))?.rev;
    assert.deepEqual(rev, { kind: "carton", ref, branch8: branchToken(id), nonce: "1234abcd", by: "Claude Code (by the terminal)" }, line);
    const m = CORE_REF.exec(revBody(rev as never));
    assert.ok(m, `core parses ${line}`);
    assert.deepEqual([m[1], m[4], m[5]], [ref.slice(0, ref.lastIndexOf("@")), branchToken(id), "1234abcd"]);
  }
});
