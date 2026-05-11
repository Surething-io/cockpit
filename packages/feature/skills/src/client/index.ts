// @cockpit/feature-skills (client) — skills UI + cross-frame bus.
// Skills = user-managed SKILL.md files (~/.cockpit/skills.json + filesystem
// markdown bodies) surfaced via the slash-command autocomplete.
export { SkillsModal, type SkillInfo } from './SkillsModal';
export { SkillPreviewModal } from './SkillPreviewModal';
export { notifySkillsChanged, onSkillsChanged } from './skillsBus';
