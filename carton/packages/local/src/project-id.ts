// A project's id from its project.json (no engine: hook processes read it too).
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function readProjectId(projectDir: string): string {
  try {
    const p = JSON.parse(readFileSync(join(projectDir, "project.json"), "utf8"));
    // Cardboard's envelope is {format, version, project: {id, …}, media}; a bare project keeps `id` at the top
    const id = p?.project?.id ?? p?.id;
    if (typeof id === "string" && id) return id;
  } catch { /* no project.json: a non-Cardboard host */ }
  throw new Error(`no project id: ${join(projectDir, "project.json")} has none; pass projectId`);
}
