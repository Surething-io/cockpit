/**
 * Cross-frame notification bus for skills mutations.
 *
 * SkillsModal runs in the Workspace parent frame, while ChatInput runs
 * inside each project's iframe. BroadcastChannel propagates messages
 * across all same-origin frames/tabs with zero server round-trip.
 */

const CHANNEL_NAME = 'cockpit-skills';

function getChannel(): BroadcastChannel | null {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') {
    return null;
  }
  return new BroadcastChannel(CHANNEL_NAME);
}

/** Notify all frames/tabs that the skills list changed (added or removed). */
export function notifySkillsChanged(): void {
  const ch = getChannel();
  if (!ch) return;
  try {
    ch.postMessage({ type: 'changed' });
  } finally {
    ch.close();
  }
}

/**
 * Subscribe to skills-change events. Returns an unsubscribe function.
 * The callback is invoked whenever any frame calls notifySkillsChanged().
 */
export function onSkillsChanged(cb: () => void): () => void {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') {
    return () => {};
  }
  const ch = new BroadcastChannel(CHANNEL_NAME);
  const handler = (e: MessageEvent) => {
    if (e.data?.type === 'changed') cb();
  };
  ch.addEventListener('message', handler);
  return () => {
    ch.removeEventListener('message', handler);
    ch.close();
  };
}
