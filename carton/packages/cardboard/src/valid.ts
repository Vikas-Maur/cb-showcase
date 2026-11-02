// What every writer of project.json checks first (laptop, build 915eb36: Restore of "Started the cut" wrote a project
// with no name and empty tracks and media, and the project left Cardboard's library). Cardboard 1.4.0 lists a bundle
// only if its reader takes the file (library-worker.js `ti`: the envelope `qW`, the project `zW`, its media `jW` with
// `FW`, its items `UW`); a file it can't read is a project that is gone. So a write is refused, and the old file kept,
// when the new one breaks what that reader needs in the fields Carton writes (the versioned slice and the stamps), or
// has no name. The host's own fields Carton never changes (cast, a media entry's thumbnails…) come from the file it
// replaces, which Cardboard already read: they aren't checked again.

/** A project.json envelope (`{format, version, project, media}`). */
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const blank = (v: unknown) => !str(v) || !v.trim();

/**
 * What is wrong with a project.json envelope for Cardboard 1.4.0, in words for the log (field names and positions, never
 * the project's text): an empty list when it can be written. `before`: the project it replaces, read only when the new
 * one's name is blank (a project that had a name never loses it; one Cardboard made with a blank name keeps saving).
 */
export function projectProblems(envelope: unknown, before?: () => Obj | null | undefined): string[] {
  const out: string[] = [];
  if (!isObj(envelope)) return ["not a project file"];
  if (envelope.format !== "cardboard-project") out.push("not a cardboard-project file");
  if (envelope.media !== undefined && !Array.isArray(envelope.media)) out.push("the media manifest isn't a list");
  const p = envelope.project;
  if (!isObj(p)) return [...out, "no project"];
  if (!str(p.id) || !p.id) out.push("no id");
  if (!str(p.name)) out.push("no name");
  else if (blank(p.name) && !blank(before?.()?.name)) out.push("its name was removed");
  if (!str(p.updatedAt)) out.push("no updatedAt");
  for (const f of ["createdAt", "mediaBaseDirectory", "aspectRatio"]) if (p[f] !== undefined && !str(p[f])) out.push(`${f} isn't text`);
  if (p.stateUpdatedAt !== undefined && !num(p.stateUpdatedAt)) out.push("stateUpdatedAt isn't a number");
  if (p.temp !== undefined && typeof p.temp !== "boolean") out.push("temp isn't true or false");
  if (p.cast !== undefined && !Array.isArray(p.cast)) out.push("cast isn't a list");
  list(p, "media", out, (m, at) => {
    if (!str(m.id)) out.push(`${at} has no id`);
    for (const f of ["createdAt", "addedAt"]) if (m[f] !== undefined && !str(m[f])) out.push(`${at}.${f} isn't text`);
    const d = m.data;
    if (d === undefined) return;
    if (!isObj(d)) return void out.push(`${at}.data isn't an object`);
    if (!str(d.type)) out.push(`${at}.data has no type`);
    for (const f of ["fileName", "content"]) if (d[f] !== undefined && !str(d[f])) out.push(`${at}.data.${f} isn't text`);
    if (d.code !== undefined && !(isObj(d.code) && str(d.code.source) && num(d.code.width) && num(d.code.height))) out.push(`${at}.data.code needs its source, width and height`);
  });
  list(p, "timelineItems", out, (it, at) => {
    if (!str(it.id)) out.push(`${at} has no id`);
    for (const f of ["type", "mediaItemId"]) if (it[f] !== undefined && !str(it[f])) out.push(`${at}.${f} isn't text`);
    if (it.endTime !== undefined && !num(it.endTime)) out.push(`${at}.endTime isn't a number`);
    if (it.pending !== undefined && typeof it.pending !== "boolean") out.push(`${at}.pending isn't true or false`);
    const c = it.codeComposition;
    if (c !== undefined && !(isObj(c) && num(c.width) && num(c.height) && (c.source === undefined || str(c.source)))) out.push(`${at}.codeComposition needs its width and height`);
  });
  list(p, "tracks", out, (t, at) => {
    if (!str(t.id)) out.push(`${at} has no id`);
  });
  return out;
}

/** A list field of the project: absent, or a list of objects, each checked. */
function list(p: Obj, field: string, out: string[], each: (x: Obj, at: string) => void): void {
  const v = p[field];
  if (v === undefined) return;
  if (!Array.isArray(v)) return void out.push(`${field} isn't a list`);
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (isObj(x)) each(x, `${field}[${i}]`);
    else out.push(`${field}[${i}] isn't an object`);
  }
}
