// How head goes into project.json through Cardboard 1.4.0's own store (`projects.updateScoped`). Its scoped merge takes
// root fields from `ownedFields`, but never `media`: a media record comes in only through `ownedMediaIds` (added or
// replaced whole), and goes only through `removedMediaIds`. So a teammate's new clip, a removed clip, or a record
// Carton changed needs those, computed against the document head was materialized from (R4 in
// notes/windows-sync.md). The store applies the scope to the newest document in its chain, so a clip added after
// `current` was read is never removed.
export const HEAD_FIELDS = ["tracks", "timelineItems", "aspectRatio", "name", "description"];

export function mediaScope(current, next) {
  const had = new Map((current?.media ?? []).map((m) => [m.id, JSON.stringify(m)]));
  const keep = new Set((next?.media ?? []).map((m) => m.id));
  return {
    ownedMediaIds: (next?.media ?? []).filter((m) => had.get(m.id) !== JSON.stringify(m)).map((m) => m.id),
    removedMediaIds: [...had.keys()].filter((id) => !keep.has(id)),
  };
}

/** The updateScoped options that write `next` (head, from `current`) without committing it again. */
export const headScope = (current, next) => ({ ownedFields: HEAD_FIELDS, ...mediaScope(current, next), carton: { materialize: true } });
