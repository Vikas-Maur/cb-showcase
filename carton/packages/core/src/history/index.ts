// History (PLAN §5, §8, §13): changes with stable ids, versions, StateRefs and pins with owner sets, cuts with global
// ids and tracking cuts, the merge DAG (LCA over fork and merge edges, recursive virtual base for criss-cross folds),
// partial accept, restore, undo by actor group, keyframes, view-save bases (§6.4) and shallow and full `.cbproj`
// exports. Owner: foundation-core.
export * from "./common.ts";
export { History, actorKey, groupOf, nodeId, parseNode, randomHex, undoLabel } from "./history.ts";
