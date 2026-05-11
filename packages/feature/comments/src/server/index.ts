// @cockpit/feature-comments (server) — code-annotation API + types.
// Comments = per-file line-range annotations stored in
// ~/.cockpit/projects/<encoded-cwd>/comments.json. Distinct from review
// comments (which are anchored on shareable review pages — see
// @cockpit/feature-review).
export type { CodeComment } from './api/comments';
