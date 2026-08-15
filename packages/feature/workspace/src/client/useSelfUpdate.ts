'use client';

/**
 * Thin React view over updateProgressStore.
 *
 * The driver itself deliberately does NOT live here. An update outlives the
 * component that starts it — the sidebar popover unmounts as soon as it closes
 * — so the state and the polling loop sit in a module-level store and the
 * progress UI is rendered by UpdateProgressCard from Providers. This hook only
 * gives the trigger a disabled flag and a way to fire.
 */
import { useCallback, useSyncExternalStore } from 'react';
import {
  getUpdateProgress,
  startSelfUpdate,
  subscribeUpdateProgress,
} from './updateProgressStore';

export function useSelfUpdate() {
  const progress = useSyncExternalStore(
    subscribeUpdateProgress,
    getUpdateProgress,
    getUpdateProgress
  );

  const start = useCallback(() => {
    void startSelfUpdate();
  }, []);

  const isUpdating =
    progress.visible &&
    progress.stage !== 'done' &&
    progress.stage !== 'failed';

  return { isUpdating, start };
}
