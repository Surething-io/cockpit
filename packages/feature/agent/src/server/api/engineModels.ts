/**
 * GET handler for an engine's model list, shared by /api/deepseek/models and
 * /api/kimi/models.
 *
 * Live rather than hardcoded: both providers ship new models without a cockpit
 * release, and their OpenAI-compatible /models is the only listing API either of
 * them exposes.
 *
 * The metadata fields are optional because the two providers report different
 * amounts of it: DeepSeek returns bare ids, Kimi also returns display names,
 * context windows and thinking-effort defaults. The picker persists whatever it
 * gets alongside the chosen model, and engines/kimi.ts turns it into the SDK's
 * context/effort env — see EngineModelSettings.
 */
import { Effect } from 'effect';
import { handler, ok } from '@cockpit/effect-runtime/server';
import { AgentError } from '@cockpit/effect-core';
import type { ApiKeyStore } from '../engines/credentials';
import { agentErrorKind, getJsonWithKey } from './engineHttp';

export interface EngineModelInfo {
  id: string;
  /** Human-readable name when the provider has one, else the picker shows the id. */
  label?: string;
  /** Context window, fed to CLAUDE_CODE_MAX_CONTEXT_TOKENS in SDK mode. */
  contextTokens?: number;
  /** Default thinking effort, fed to CLAUDE_CODE_EFFORT_LEVEL in SDK mode. */
  effort?: string;
}

interface RawModel {
  id?: string;
  display_name?: string;
  context_length?: number;
  think_efforts?: { support?: boolean; default_effort?: string };
}

function toModelInfo(m: RawModel): EngineModelInfo | null {
  if (!m.id) return null;
  const effort = m.think_efforts?.support ? m.think_efforts.default_effort : undefined;
  return {
    id: m.id,
    ...(m.display_name && { label: m.display_name }),
    ...(typeof m.context_length === 'number' && { contextTokens: m.context_length }),
    ...(effort && { effort }),
  };
}

export function makeModelsRoute(opts: {
  /** AgentError provider tag. */
  provider: 'deepseek' | 'kimi';
  /** Human-readable name for the "not configured" message. */
  label: string;
  url: string;
  store: ApiKeyStore;
}) {
  return handler(() =>
    Effect.gen(function* () {
      const models = yield* Effect.tryPromise({
        try: async () => {
          const data = await getJsonWithKey<{ data?: RawModel[] }>({
            url: opts.url,
            store: opts.store,
            label: opts.label,
          });
          return (data.data || []).map(toModelInfo).filter((m): m is EngineModelInfo => !!m);
        },
        catch: (cause) =>
          new AgentError({ provider: opts.provider, kind: agentErrorKind(cause), cause }),
      });
      return ok({ models });
    })
  );
}
