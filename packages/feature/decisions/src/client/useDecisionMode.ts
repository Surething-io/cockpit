import { useCallback, useEffect, useState } from 'react';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import type { DecisionProjectResolution } from '../shared/types';
import { bindDecisionProject, loadDecisionProject, setDecisionMode } from './effect/decisionsClient';

// The switch is per PROJECT, but every chat tab of that project shows it. One
// in-window channel keeps them in step: whoever changes it broadcasts the new
// resolution, every mounted hook for any cwd re-reads its own (two cwds may be
// worktrees of one project, so cwd equality is not the right filter).
type Listener = () => void;
const listeners = new Set<Listener>();
const notifyDecisionModeChange = (): void => listeners.forEach((l) => l());

export interface DecisionModeState {
  /** null until the first load finishes (or when cwd is missing). */
  resolution: DecisionProjectResolution | null;
  enabled: boolean;
  busy: boolean;
  setEnabled: (enabled: boolean) => Promise<DecisionProjectResolution | null>;
  bind: (choice: string) => Promise<DecisionProjectResolution | null>;
}

export function useDecisionMode(cwd: string | undefined): DecisionModeState {
  const [resolution, setResolution] = useState<DecisionProjectResolution | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!cwd) {
      setResolution(null);
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      const exit = await BrowserRuntime.runPromiseExit(loadDecisionProject(cwd));
      if (!cancelled && exit._tag === 'Success') setResolution(exit.value);
    };
    void refresh();
    listeners.add(refresh);
    return () => {
      cancelled = true;
      listeners.delete(refresh);
    };
  }, [cwd]);

  const run = useCallback(
    async (effect: ReturnType<typeof setDecisionMode>) => {
      setBusy(true);
      try {
        const exit = await BrowserRuntime.runPromiseExit(effect);
        if (exit._tag !== 'Success') return null;
        setResolution(exit.value);
        notifyDecisionModeChange();
        return exit.value;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const setEnabled = useCallback(
    (enabled: boolean) => (cwd ? run(setDecisionMode(cwd, enabled)) : Promise.resolve(null)),
    [cwd, run],
  );
  const bind = useCallback(
    (choice: string) => (cwd ? run(bindDecisionProject(cwd, choice)) : Promise.resolve(null)),
    [cwd, run],
  );

  return {
    resolution,
    enabled: resolution?.status === 'resolved' && resolution.enabled,
    busy,
    setEnabled,
    bind,
  };
}
