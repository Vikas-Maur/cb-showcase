// @carton/comments: timecoded comments for Carton (PLAN §1 C6, §9 anchors, §14 the commenter role). A comment is
// pinned to the version and the place it was made on; on a later version it is placed exactly, followed to where its
// clip moved (through splits too), or marked "may be outdated" where the shot changed. Comments are never versions:
// they never make a change, never meet an edit and never show in History.
//
// Plug-ins (PLAN §3.1): where comments are kept (`CommentStore`: the project's own Store by default) and how they are
// shared (`CommentSync`: the project's own host and Transport). The server half is `@carton/comments/server`.

export type * from "./types.ts";
export { LIMITS } from "./types.ts";
export { applyPatch, mergePatch, patchProblem, anchorProblem, validBody, validId, threadsOf, newCommentId, type Thread, type PatchResult } from "./model.ts";
export { TimelineIndex, makeAnchor, place, type AnchorOptions, type AnchorAt, type Placement, type PlacementStatus, type PlaceTarget } from "./anchor.ts";
export { cartonLineage, type LineageSource, type LineageCarton, type VersionAt } from "./lineage.ts";
export { cartonCommentStore, memoryCommentStore, COMMENT_TABLES, type CommentStore, type CommentSnapshot, type CommentWrite } from "./store.ts";
export { CommentSync, type CommentSyncOptions, type CommentSyncState, type CommentSyncStatus, type CommentSyncEngine } from "./sync.ts";
export { Comments, CommentError, type CommentsOptions, type CommentsCarton, type CommentsEvent, type CommentTarget } from "./comments.ts";
