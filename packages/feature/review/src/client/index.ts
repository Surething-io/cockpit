// @cockpit/feature-review (client) — review UI components, hooks, and types.
// Review = standalone shareable code-review pages (anchored highlights,
// per-paragraph comments, threaded replies). Distinct from cross-feature
// code-annotations (which live in @cockpit/feature-comments).
export { ReviewPage } from './ReviewPage';
export { ReviewListPanel } from './ReviewListPanel';
export { ReviewIdentitySettings } from './ReviewIdentitySettings';
export { ReviewCommentsListModal, type UserNameMap } from './ReviewCommentsListModal';
export { ShareReviewToggle } from './ShareReviewToggle';
export { ReviewDropdown } from './ReviewDropdown';
export { useReviewIdentity } from './hooks/useReviewIdentity';
export { useReviewHighlights, type HighlightRect } from './hooks/useReviewHighlights';

// Review data types + ID generators (re-exported from server/lib so client
// code doesn't reach into a server path directly).
export type {
  ReviewData,
  ReviewComment,
  ReviewReply,
  CommentAnchor,
} from '../server/lib/reviewUtils';
export {
  generateReviewId,
  generateCommentId,
  generateReplyId,
  randomDisplayName,
} from '../server/lib/reviewUtils';
