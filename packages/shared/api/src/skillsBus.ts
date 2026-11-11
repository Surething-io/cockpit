/**
 * Cross-frame notification bus for skills-registry mutations.
 *
 * Lives in shared-api (not feature-skills) because three features must agree on
 * the channel: feature-skills (SkillsModal add/delete), feature-agent (chat `/`
 * autocomplete reload), and feature-explorer (the SKILL.md "add" buttons).
 * Homing it in feature-skills would force feature-explorer → feature-skills,
 * which cycles back through SkillPreviewModal's feature-explorer import.
 */
import { createChangeBus } from './changeBus';

const bus = createChangeBus('cockpit-skills', '/api/skills');

/** Notify all frames/tabs that the skills list changed (added or removed). */
export const notifySkillsChanged = bus.notify;

/** Subscribe to skills-change events. Returns an unsubscribe function. */
export const onSkillsChanged = bus.subscribe;
