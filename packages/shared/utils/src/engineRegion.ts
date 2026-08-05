/**
 * Which region an engine's requests go to when the user has not chosen one.
 *
 * Lives in shared-utils because BOTH sides need the identical rule and must agree:
 * the server (engines/glm.ts) applies it to route the actual traffic, and the picker
 * applies it to show which region is in effect. If the two drifted, the UI would
 * claim one host while the runs went to another.
 *
 * The input is `settings.language` as PERSISTED — not the browser's resolved locale.
 * That matters: 'auto' is resolved client-side from navigator.language and reaches the
 * server unresolved, so feeding the resolved value here on one side and the raw value
 * on the other is exactly how the two would disagree.
 */
export type EngineRegion = 'cn' | 'global';

export function defaultRegionForLanguage(language: string | undefined): EngineRegion {
  // English UI → the international host. Everything else, including 'auto' and unset,
  // → mainland: cockpit's GLM users register on bigmodel.cn, and guessing wrong here
  // costs a slower route rather than a failed request (the same key works on both).
  return language === 'en' ? 'global' : 'cn';
}
