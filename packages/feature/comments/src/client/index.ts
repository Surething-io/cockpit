// @cockpit/feature-comments (client) — hooks for code-annotation comments.
// Comments are per-file line-range annotations the user attaches to source
// code; non-chat features (file browser, diff view, AI message bubbles) use
// these hooks to read/write them and to compose AI prompts that reference
// the annotated code.

export type { CodeComment } from '../server/api/comments';

export {
  fetchAllCommentsWithCode,
  clearAllComments,
  buildAIMessage,
  emitCommentsChange,
  subscribeCommentsChange,
  CHAT_COMMENT_FILE,
  type CommentWithCode,
  type CodeReference,
} from './useAllComments';

export { useComments } from './useComments';

// UI: list-style modal showing all code annotations
export { CommentsListModal } from './CommentsListModal';
