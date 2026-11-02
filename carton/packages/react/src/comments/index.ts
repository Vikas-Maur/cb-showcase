// Comments (owner: comments): the panel, the timeline markers, their view model and its adapter over a
// `@carton/comments` handle, words, a mock, and the look.
export type * from "./model.ts";
export { commentsUi, type CommentsSource, type SourceComment, type CommentsUiOptions, type CommentsUiHandle } from "./from-comments.ts";
export { CommentsPanel, PersonAvatar, useCommentThreads, type CommentsPanelProps, type CommentsFilter } from "./CommentsPanel.ts";
export { CommentMarkers, markerGroups, type CommentMarkersProps } from "./CommentMarkers.ts";
export { commentWords, type CommentWords } from "./words.ts";
export { createMockComments, mockPeople, type MockComments } from "./mock.ts";
export { commentsBaseCss, commentsSkin, injectCommentsSkin } from "./skin.ts";
export { serveComments, remoteComments, type CommentsServerMessage, type CommentsClientMessage } from "./remote.ts";
