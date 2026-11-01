// The real Cardboard 1.4.0 CLI as printer and parser, against our committed fixtures, and the header contract probe:
// what 1.4.0 does when Carton's own header takes the `// cardboard:rev` line. Skipped when the CLI is absent.
//
//   node --test --test-concurrency=2 carton/packages/conformance/src/cardboard/cli-codec.test.ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cardboardCli, editElement, type ApplyResult, type CardboardCli } from "./cli-codec.ts";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const CARTON_HEADER = "// cardboard:rev main@57~3f9a1c0e b:1a2b3c4d p:9f8e7d6c by director/c/t1";
const REV_LINE = /^\/\/ cardboard:rev \d+$/m;

type Obj = Record<string, unknown>;
interface Envelope {
  format: string;
  project: Obj & { tracks: Obj[]; timelineItems: Obj[]; media: Obj[]; aspectRatio: string; stateUpdatedAt: number };
  media: Obj[];
}

const read = (rel: string): string => fs.readFileSync(path.join(FIXTURES, rel), "utf8");
const readJson = <T = Obj>(rel: string): T => JSON.parse(read(rel)) as T;

/** Recursively sorts object keys: Cardboard's JSON key order is not stable across writes. */
function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    const o = v as Obj;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, canon(o[k])]));
  }
  return v;
}

/**
 * The timeline slice in a comparable form. Text and code items get a media item synthesized on every apply that
 * creates them (the print does not carry their mediaItemId), so it is replaced by what that media holds; items whose
 * id is not in `known` were created by the apply and get their name for an id.
 */
function slice(p: { tracks: unknown[]; timelineItems: unknown[]; aspectRatio: string; media: unknown[] }, known?: Set<string>): unknown {
  const media = new Map((p.media as Obj[]).map((m) => [m.id as string, m.data as Obj]));
  const items = (p.timelineItems as Obj[]).map((it) => {
    const out: Obj = { ...it };
    if (known && !known.has(it.id as string)) out.id = `new:${String(it.name)}`;
    if (it.type === "text" || it.type === "code") {
      const data = media.get(it.mediaItemId as string);
      out.mediaItemId = it.type === "text" ? `text:${String(data?.content)}` : `code:${JSON.stringify(data?.code)}`;
    }
    return out;
  });
  return canon({ aspectRatio: p.aspectRatio, tracks: p.tracks, timelineItems: items });
}

/** ops, conflicts and diagnostics of an apply, with created ids and synthesized media ids taken out. */
function applyShape(r: ApplyResult): unknown {
  const ops = (r.ops as Obj[]).map((op) => {
    if (op.op !== "addItem") return op;
    const item: Obj = { ...(op.item as Obj) };
    item.id = `new:${String(item.name)}`;
    if (item.type === "text" || item.type === "code") item.mediaItemId = "synthesized";
    return { ...op, item };
  });
  return canon({ applied: r.applied, ops, conflicts: r.conflicts, diagnostics: r.diagnostics });
}

const withoutRev = (tsx: string): string => tsx.replace(REV_LINE, "// cardboard:rev <rev>");

const cli: CardboardCli | null = cardboardCli();

describe("Cardboard 1.4.0 CLI as printer and parser", { skip: cli ? false : "no Cardboard CLI (set $CARTON_CARDBOARD_CLI)" }, () => {
  const c = cli as CardboardCli;
  const sample = readJson<Envelope>("sample/project.json");
  const sampleTsx = read("sample/timeline.tsx");

  after(() => c.dispose());

  it("is version 1.4.0", { timeout: 60_000 }, async () => {
    const r = await c.run(["--version"]);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), "1.4.0");
  });

  it("prints the committed sample exactly as committed", { timeout: 60_000 }, async () => {
    const fresh = await c.print(sample);
    // project.json's /FIXTURE paths never reach the print; the rev line is the project's stateUpdatedAt either way.
    assert.equal(withoutRev(fresh), withoutRev(sampleTsx));
    assert.equal(REV_LINE.exec(fresh)?.[0], `// cardboard:rev ${sample.project.stateUpdatedAt}`);
    assert.equal(fresh.split("\n")[3], `// cardboard:rev ${sample.project.stateUpdatedAt}`, "the rev is line 4");
  });

  it("print then parse reproduces the sample's timeline slice", { timeout: 120_000 }, async () => {
    const tsx = await c.print(sample);
    const parsed = await c.parse(tsx, sample);
    assert.deepEqual(parsed.diagnostics, []);
    assert.deepEqual(slice(parsed), slice(sample.project));

    // The .revs snapshot is the same slice with each code item's source inlined from its media.
    assert.ok(parsed.snapshot, "the apply recorded a revision");
    const media = new Map((parsed.media as Obj[]).map((m) => [m.id, m.data as Obj]));
    const stored = parsed.timelineItems as Obj[];
    for (const item of parsed.snapshot.timelineItems as Obj[]) {
      const own = stored.find((s) => s.id === item.id) as Obj;
      if (item.type !== "code") {
        assert.deepEqual(canon(item), canon(own));
        continue;
      }
      const code = (media.get(own.mediaItemId) as Obj).code as Obj;
      assert.equal((item.codeComposition as Obj).source, code.source);
      assert.equal((own.codeComposition as Obj).source, undefined, "project.json keeps code source only in media");
    }

    // And printing what the parse stored gives the same text back.
    const reprinted = await c.print({ ...sample, project: { ...sample.project, ...parsed, snapshot: undefined, diagnostics: undefined } });
    assert.equal(withoutRev(reprinted), withoutRev(tsx));
  });

  it("parses without a context project (no media, so only items without src)", { timeout: 60_000 }, async () => {
    const parsed = await c.parse('export default (\n  <timeline aspect="9:16">\n    <track name="T">\n      <text start={0} end={1} textContent="Carton" />\n    </track>\n  </timeline>\n);\n');
    assert.equal(parsed.aspectRatio, "9:16");
    assert.equal(parsed.tracks.length, 1);
    const [item] = parsed.timelineItems as Obj[];
    assert.equal(item?.type, "text");
    assert.equal(item?.textContent, "Carton");
  });

  it("refuses text that is not a literal timeline", { timeout: 60_000 }, async () => {
    await assert.rejects(c.parse("export default (<timeline><track>{[1, 2].map((x) => x)}</track></timeline>);\n"), {
      name: "CardboardCliError",
    });
  });

  for (const name of fs.readdirSync(FIXTURES).filter((n) => n.startsWith("edit-")).sort()) {
    it(`replays ${name}: the committed apply result and project`, { timeout: 120_000 }, async () => {
      const beforeProject = readJson<Envelope>(`${name}/project.before.json`);
      const bundle = c.makeBundle(beforeProject, "Sample");
      if (fs.existsSync(path.join(FIXTURES, name, "base.rev.json"))) {
        const base = readJson<{ rev: number }>(`${name}/base.rev.json`);
        fs.mkdirSync(path.join(bundle, ".revs"));
        fs.writeFileSync(path.join(bundle, ".revs", `${base.rev}.json`), read(`${name}/base.rev.json`));
      }
      assert.equal(read(`${name}/before.tsx`), sampleTsx, "the agent read the sample's print");
      const result = await c.apply(bundle, read(`${name}/after.tsx`));
      assert.deepEqual(applyShape(result), applyShape(readJson<ApplyResult>(`${name}/apply.json`)));

      const known = new Set(beforeProject.project.timelineItems.map((i) => i.id as string));
      const now = JSON.parse(fs.readFileSync(path.join(bundle, "project.json"), "utf8")) as Envelope;
      assert.deepEqual(slice(now.project, known), slice(readJson<Envelope>(`${name}/project.after.json`).project, known));
    });
  }

  describe("header contract probe: Carton's header in place of `// cardboard:rev <ms>`", () => {
    // The state is edit-nested-concurrent's: the agent's file was printed at rev R1 (the sample), and since then the
    // app changed the Title's fontSize 96 → 120 and saved (rev R2; .revs holds R1 and R2). The agent's file changes
    // the Title's color plus two nested fields of other items. The outcome tells which base the apply used:
    //   three-way  base R1: the app's fontSize 120 survives, the Title is reported as a conflict (both sides changed it)
    //   two-way    no base, the file diffed against the current timeline: its stale fontSize 96 overwrites the app's
    //              120, with no conflict reported
    type Mode = "three-way" | "two-way";
    interface Variant {
      name: string;
      make: (tsx: string, rev: string) => string;
      expect: Mode;
    }
    const line4 = (tsx: string, text: string | null): string => {
      const lines = tsx.split("\n");
      assert.match(lines[3] ?? "", REV_LINE);
      if (text === null) lines.splice(3, 1);
      else lines[3] = text;
      return lines.join("\n");
    };
    const carton = (tsx: string): string => line4(tsx, CARTON_HEADER);
    const VARIANTS: Variant[] = [
      { name: "control: `// cardboard:rev R1` on line 4", make: (t) => t, expect: "three-way" },
      { name: "Carton's header on line 4", make: carton, expect: "two-way" },
      { name: "no rev line at all", make: (t) => line4(t, null), expect: "two-way" },
      { name: "Carton's header on line 4, `// cardboard:rev R1` on line 5", make: (t, r) => carton(t).replace(CARTON_HEADER, `${CARTON_HEADER}\n// cardboard:rev ${r}`), expect: "three-way" },
      { name: "rev line on line 1, Carton's header on line 4", make: (t, r) => `// cardboard:rev ${r}\n${carton(t)}`, expect: "three-way" },
      { name: "Carton's header on line 4, rev line just above `export default`", make: (t, r) => carton(t).replace("\nexport default (", `\n// cardboard:rev ${r}\nexport default (`), expect: "three-way" },
      { name: "Carton's header on line 4, rev line after the closing `);`", make: (t, r) => `${carton(t)}// cardboard:rev ${r}\n`, expect: "three-way" },
      {
        name: "Carton's header on line 4, rev line indented inside a JSX opening tag",
        make: (t, r) => carton(t).replace(/(<caption\n\s+id="[^"]+"\n)/, `$1        // cardboard:rev ${r}\n`),
        expect: "three-way",
      },
      { name: "`//cardboard:rev R1` (no space after //) on line 4", make: (t, r) => line4(t, `//cardboard:rev ${r}`), expect: "three-way" },
      { name: "whole file with CRLF line ends", make: (t) => t.replace(/\n/g, "\r\n"), expect: "three-way" },
      { name: "`// cardboard:rev R1 main@57~3f9a1c0e` (Carton's text after the digits)", make: (t, r) => line4(t, `// cardboard:rev ${r} main@57~3f9a1c0e`), expect: "two-way" },
      { name: "`/* cardboard:rev R1 */` on line 4", make: (t, r) => line4(t, `/* cardboard:rev ${r} */`), expect: "two-way" },
      { name: "`// cardboard:rev 1` (older than every snapshot)", make: (t) => line4(t, "// cardboard:rev 1"), expect: "two-way" },
      { name: "`// cardboard:rev 1` on line 4, `// cardboard:rev R1` on line 5 (first wins?)", make: (t, r) => line4(t, `// cardboard:rev 1\n// cardboard:rev ${r}`), expect: "two-way" },
      { name: "`// cardboard:rev 9999999999999` (newer than every snapshot)", make: (t) => line4(t, "// cardboard:rev 9999999999999"), expect: "two-way" },
    ];

    let template = "";
    let agentTsx = "";
    let r1 = "";
    let titleId = "";

    before(async () => {
      const name = "edit-nested-concurrent";
      const base = readJson<{ rev: number }>(`${name}/base.rev.json`);
      r1 = String(base.rev);
      assert.equal(REV_LINE.exec(sampleTsx)?.[0], `// cardboard:rev ${r1}`);
      // R1 as the sample's bundle had it, then the app's change applied by the CLI so that it records R2 itself.
      template = c.makeBundle(sample, "Sample");
      fs.mkdirSync(path.join(template, ".revs"));
      fs.writeFileSync(path.join(template, ".revs", `${r1}.json`), read(`${name}/base.rev.json`));
      const editor = await c.apply(template, editElement(sampleTsx, "Title", "fontSize={96}", "fontSize={120}"));
      assert.equal(editor.applied, true);
      assert.equal(fs.readdirSync(path.join(template, ".revs")).length, 2, ".revs holds R1 and R2");
      agentTsx = read(`${name}/after.tsx`);
      titleId = (sample.project.timelineItems.find((i) => i.name === "Title") as Obj).id as string;
    });

    for (const v of VARIANTS) {
      it(v.name, { timeout: 60_000 }, async (t) => {
        const bundle = c.copyBundle(template);
        const tsx = v.make(agentTsx, r1);
        const result = await c.apply(bundle, tsx);
        const project = (JSON.parse(fs.readFileSync(path.join(bundle, "project.json"), "utf8")) as Envelope).project;
        const title = project.timelineItems.find((i) => i.id === titleId) as Obj;
        const conflicts = result.conflicts as Obj[];
        const titleOps = (result.ops as Obj[]).filter((op) => op.id === titleId).map((op) => op.changes);
        const mode: Mode | "unclear" =
          title.fontSize === 120 && conflicts.some((x) => x.id === titleId) ? "three-way"
          : title.fontSize === 96 && conflicts.length === 0 ? "two-way"
          : "unclear";
        t.diagnostic(
          `${mode}: applied=${result.applied} rev=${result.rev} Title fontSize=${String(title.fontSize)} color=${String(title.color)} ` +
            `conflicts=${JSON.stringify(conflicts)} titleOps=${JSON.stringify(titleOps)} ops=${result.ops.length} diagnostics=${JSON.stringify(result.diagnostics)}`,
        );
        assert.equal(result.applied, true, "1.4.0 still parses and applies the file");
        assert.deepEqual(result.diagnostics, [], "no diagnostic mentions the header");
        assert.equal(title.color, "#ffd166", "the agent's own change lands either way");
        assert.equal(mode, v.expect);
      });
    }
  });
});
