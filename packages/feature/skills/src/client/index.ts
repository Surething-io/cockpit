// @cockpit/feature-skills (client) — skills UI + cross-frame bus.
// Skills = user-managed SKILL.md files (~/.cockpit/skills.json + filesystem
// markdown bodies) surfaced via the slash-command autocomplete.
// The registry IO + cross-frame bus live in @cockpit/shared-ui
// (notifySkillsChanged / onSkillsChanged / loadSkillsList / addSkill / …) —
// import them from there, not through this barrel.
export { SkillsModal, type SkillInfo } from './SkillsModal';
export { SkillPreviewModal } from './SkillPreviewModal';
