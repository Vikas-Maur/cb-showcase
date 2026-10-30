// Re-implementation, for study, of how Cardboard 1.4.0 merges an edited
// timeline.tsx back into a project that changed in the meantime.
// Run: node examples/merge-demo.mjs
//
// The model (read from their CLI bundle):
//   base     = the timeline at the `cardboard:rev` the file was printed from
//   editor   = the timeline now (human edits in the app since then)
//   incoming = the parsed file (agent or human edits in text)
//   ops = diff(base, incoming), applied on top of editor.
//   Conflict = an item/track id touched by BOTH diff(base, editor) and diff(base, incoming).
//   prefer "file" (default): apply every op anyway; prefer "editor": drop ops on conflicting ids.

const IGNORED_ITEM_KEYS = new Set(["id", "trackId", "type"]);

const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Field diff: top-level keys only, so nested objects (transform, colorGrade,
// keyframeTracks) are replaced whole when anything inside them changes.
const diffFields = (before, after) => {
  const changes = {};
  const unset = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (IGNORED_ITEM_KEYS.has(key) || deepEqual(before[key], after[key])) continue;
    if (after[key] === undefined) unset.push(key);
    else changes[key] = after[key];
  }
  return Object.keys(changes).length || unset.length ? { changes, unset } : null;
};

const diff = (base, next) => {
  const ops = [];
  const baseItems = new Map(base.items.map((i) => [i.id, i]));
  const nextItems = new Map(next.items.map((i) => [i.id, i]));
  const removed = [...baseItems.keys()].filter((id) => !nextItems.has(id));
  const readded = [];
  for (const [id, item] of nextItems) {
    const old = baseItems.get(id);
    if (!old) ops.push({ op: "addItem", item });
    // Moving to another track or changing type is remove + re-add of the whole item.
    else if (old.trackId !== item.trackId || old.type !== item.type) {
      removed.push(id);
      readded.push(item);
    } else {
      const d = diffFields(old, item);
      if (d && Object.keys(d.changes).length) ops.push({ op: "updateItem", id, changes: d.changes });
      if (d && d.unset.length) ops.push({ op: "unsetItemFields", id, fields: d.unset });
    }
  }
  if (removed.length) ops.push({ op: "removeItems", ids: removed });
  for (const item of readded) ops.push({ op: "addItem", item });
  return ops;
};

const touchedIds = (ops) =>
  new Set(ops.flatMap((o) => (o.op === "addItem" ? [o.item.id] : o.op === "removeItems" ? o.ids : [o.id])));

const apply = (doc, ops) => {
  let items = doc.items.map((i) => ({ ...i }));
  for (const o of ops) {
    if (o.op === "addItem") items = [...items.filter((i) => i.id !== o.item.id), { ...o.item }];
    if (o.op === "removeItems") items = items.filter((i) => !o.ids.includes(i.id));
    if (o.op === "updateItem") items = items.map((i) => (i.id === o.id ? { ...i, ...o.changes } : i));
    if (o.op === "unsetItemFields")
      items = items.map((i) => (i.id === o.id ? Object.fromEntries(Object.entries(i).filter(([k]) => !o.fields.includes(k))) : i));
  }
  return { ...doc, items };
};

const merge = (base, editor, incoming, prefer = "file") => {
  const fileOps = diff(base, incoming);
  const editorTouched = touchedIds(diff(base, editor));
  const conflicts = [...touchedIds(fileOps)].filter((id) => editorTouched.has(id));
  const ops = prefer === "editor" ? fileOps.filter((o) => !conflicts.some((id) => touchedIds([o]).has(id))) : fileOps;
  return { doc: apply(editor, ops), ops, conflicts };
};

// ---------------------------------------------------------------------------

const base = {
  items: [
    { id: "a1", trackId: "main", type: "video", name: "Intro", start: 0, end: 6 },
    { id: "a2", trackId: "main", type: "video", name: "Problem", start: 6, end: 16 },
    { id: "a3", trackId: "main", type: "video", name: "CTA", start: 16, end: 24, colorGrade: { saturation: 1.1, contrast: 1 } },
    { id: "t1", trackId: "titles", type: "text", start: 0.5, end: 3, textContent: "We cut editing time by 10x" },
  ],
};
const edit = (doc, id, patch) => ({ ...doc, items: doc.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) });
const show = (doc, ids) => doc.items.filter((i) => ids.includes(i.id)).map((i) => JSON.stringify(i)).join("\n    ");

const scenarios = [
  {
    title: "1. Different items: clean merge",
    editor: edit(base, "a1", { end: 5 }), // human trims Intro in the app
    incoming: edit(base, "t1", { textContent: "10x faster edits" }), // agent rewrites the title in the file
    ids: ["a1", "t1"],
  },
  {
    title: "2. Same item, different fields: reported as a conflict, but both survive (file wins)",
    editor: edit(base, "a2", { end: 14 }), // human trims Problem
    incoming: edit(base, "a2", { name: "The problem" }), // agent renames it
    ids: ["a2"],
  },
  {
    title: "3. Same item, same field: file silently overwrites the human",
    editor: edit(base, "a2", { end: 14 }),
    incoming: edit(base, "a2", { end: 15 }),
    ids: ["a2"],
  },
  {
    title: "4. Same item with --prefer editor: ALL of the file's changes to it are dropped",
    editor: edit(base, "a2", { end: 14 }),
    incoming: edit(base, "a2", { name: "The problem" }),
    prefer: "editor",
    ids: ["a2"],
  },
  {
    title: "5. Nested object: different keys inside colorGrade still clobber each other",
    editor: edit(base, "a3", { colorGrade: { saturation: 1.3, contrast: 1 } }), // human boosts saturation
    incoming: edit(base, "a3", { colorGrade: { saturation: 1.1, contrast: 1.2 } }), // agent adds contrast
    ids: ["a3"],
  },
  {
    title: "6. No ripple: trimming a clip in the file leaves a gap, later clips don't shift",
    editor: base,
    incoming: edit(base, "a1", { end: 4 }),
    ids: ["a1", "a2"],
  },
  {
    title: "7. Delete vs edit: file deletes an item the human just changed; delete wins",
    editor: edit(base, "t1", { end: 4 }),
    incoming: { items: base.items.filter((i) => i.id !== "t1") },
    ids: ["t1"],
  },
];

for (const s of scenarios) {
  const { doc, ops, conflicts } = merge(base, s.editor, s.incoming, s.prefer);
  console.log(`\n${s.title}`);
  console.log(`  ops:       ${ops.map((o) => o.op + (o.id ? `(${o.id})` : o.ids ? `(${o.ids})` : "")).join(", ") || "none"}`);
  console.log(`  conflicts: ${conflicts.join(", ") || "none"}`);
  console.log(`  result:\n    ${show(doc, s.ids) || "(removed)"}`);
}
