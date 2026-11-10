'use client';

import { useCallback, useMemo, useState } from 'react';
import { Effect } from 'effect';
import { isPiEngine } from '@cockpit/shared-utils/piEngines';
import { useEffectQuery } from '@cockpit/effect-react';
import { loadPiThinking } from './effect/agentClient';
import type { PiThinkingLevel } from '../shared/piThinking';

export function usePiThinking(engine: string | undefined, model: string | undefined, cwd: string | undefined, sessionId: string | null, hasKey: boolean) {
  const [revision, setRevision] = useState(0);
  const [choice, setChoice] = useState<{ engine: string; cwd?: string; sessionId: string | null; level: PiThinkingLevel }>();
  const key = JSON.stringify([engine, model, cwd, sessionId, hasKey, revision]);
  const query = useEffectQuery(useMemo(() => isPiEngine(engine) && model && (engine === 'ollama' || hasKey)
    ? loadPiThinking(engine, model, cwd, sessionId).pipe(Effect.map((options) => ({ key, options })))
    : Effect.succeed(undefined), [engine, model, cwd, sessionId, hasKey, key]), [key]);
  const options = query.status === 'success' && query.data?.key === key ? query.data.options : undefined;
  // A new session acquires its native id after send; retain its pending selection.
  const pending = choice && choice.engine === engine && choice.cwd === cwd && (choice.sessionId === sessionId || choice.sessionId === null) ? choice.level : undefined;
  const level = options ? pending && options.levels.includes(pending) ? pending : options.selectedLevel : undefined;
  const onChange = useCallback((level: PiThinkingLevel) => {
    if (engine) setChoice({ engine, cwd, sessionId, level });
  }, [engine, cwd, sessionId]);
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  return { options, level, onChange, retry, error: query.status === 'error' ? query.error : undefined };
}
