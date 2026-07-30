// @cockpit/shared-api — browser-side clients for Cockpit's own /api routes,
// for the cases where TWO OR MORE features need the same endpoint.
//
// Admission rule: a client belongs here only once a second feature needs it.
// A client used by exactly one feature stays inside that feature
// (agentClient, gitClient, lspClient, htmlAppsClient, reviewClient, … all
// correctly live in their own package) — moving those here would just relocate
// private code into shared space and make each feature harder to read alone.
//
// Why this package exists at all: features are only allowed to depend on each
// other acyclically, and both of the endpoints below are needed by a feature on
// each side of an existing edge. Homing them in the feature that looks like
// their owner would close a cycle:
//   - /api/files/text  — feature-explorer owns file IO, but feature-comments
//     reads file bodies too, and feature-explorer already imports
//     feature-comments for useComments.
//   - /api/skills      — feature-skills owns the registry, but feature-explorer
//     writes to it from the SKILL.md "add" buttons, and feature-skills already
//     imports feature-explorer for its markdown renderers.
// See MODULES.md "Current feature dependency graph".
//
// skillsBus is here rather than in shared-ui because it is the invalidation
// half of the /api/skills contract — whoever POSTs must tell the other frames.
// Splitting the two across packages would hide that pairing.

export { fetchFileText, type TextResponse } from './filesTextClient';

export { notifySkillsChanged, onSkillsChanged } from './skillsBus';
export {
  loadSkillsList,
  addSkill,
  deleteSkill,
  loadSkillContent,
  type SkillInfoLite,
  type SkillPreviewLite,
  type AddSkillResult,
} from './skillsRegistryClient';
