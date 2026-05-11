/**
 * Handler registry — singleton map keyed by `GrammarId`.
 *
 * Lifecycle:
 *   - Per-handler module (e.g. `typescript.ts`) calls `registerHandler`
 *     at top level. Importing the module thus triggers registration
 *     as a side effect.
 *   - `handlers/index.ts` is a barrel that imports every handler
 *     module — the application bootstrap path imports the barrel
 *     once, which causes every handler to register.
 *   - The codeMap pipeline calls `getHandler(grammarId)` lazily, so
 *     by the time the first file parses the registry is populated.
 *
 * Why module-side-effect registration vs explicit `bootstrap()`:
 *   - One import chain (the barrel) is the single bootstrap point.
 *     Forgetting to call an explicit bootstrap from N entry points
 *     (server route, build step, test setup) is a known foot-gun.
 *   - Each handler module's registration is colocated with its
 *     definition, so adding a handler is a one-file change (write
 *     handler + add to barrel; no third "register me" file to edit).
 *
 * Duplicate registration throws — registering twice is always a bug
 * (two handler modules trying to claim the same grammar id), and a
 * silent overwrite would mask the conflict. */

import type { GrammarId } from '../languageMap';
import type { LanguageHandler } from './types';

const handlers = new Map<GrammarId, LanguageHandler>();

/** Register a handler under its `grammarId`. The same handler instance
 *  may be registered under multiple ids (e.g. the TS handler covers
 *  `'typescript'`, `'tsx'`, and `'javascript'` — call this three
 *  times with the same instance plus per-id `extensions` arrays).
 *
 *  Re-registration of the same id silently OVERWRITES the previous
 *  handler. This isn't strictness theatre we wanted — Next.js dev
 *  HMR re-evaluates the barrel module on file changes, which fires
 *  every `registerHandler` call again with freshly-constructed
 *  handler instances. Throwing here would 500 every API request
 *  after the first edit. The "duplicate registration is a bug"
 *  property would catch genuine wiring mistakes, but those surface
 *  via the FIRST request anyway (handler not found / wrong shape). */
export function registerHandler(handler: LanguageHandler): void {
  handlers.set(handler.grammarId, handler);
}

/** Look up the handler for a grammar id. Throws if no handler is
 *  registered — at the point we ask for one we already KNOW the file
 *  parsed under this grammar, so a missing handler is a bootstrap
 *  bug (forgot to import the handler module / the barrel). */
export function getHandler(id: GrammarId): LanguageHandler {
  const h = handlers.get(id);
  if (!h) {
    throw new Error(
      `[codeMap] no handler registered for grammar '${id}' — ` +
        `did the handler module get imported (handlers/index.ts barrel)?`,
    );
  }
  return h;
}

/** Soft lookup — returns `undefined` instead of throwing. Use this
 *  when the caller wants to fall back gracefully (e.g. during the
 *  P0–P2 migration window when not every grammar has a handler yet). */
export function tryGetHandler(id: GrammarId): LanguageHandler | undefined {
  return handlers.get(id);
}

/** True iff a handler is registered for this grammar. Cheap check —
 *  prefer `tryGetHandler` if you'll consume the handler too. */
export function hasHandler(id: GrammarId): boolean {
  return handlers.has(id);
}

/** Test-only — clear all registrations. Useful between unit-test
 *  cases that want to register their own fixtures. NEVER call from
 *  production code; the registry is a process-wide singleton. */
export function _resetHandlersForTest(): void {
  handlers.clear();
}

/** Union of every registered handler's `extensions`, lowercased and
 *  deduplicated. Used by walkSource / listFilesViaGit to decide
 *  whether a file is a source file at all (the first filter, before
 *  grammar selection).
 *
 *  Lazy on call: depends on every handler module having been imported
 *  before invocation — the bootstrap path imports `handlers/index.ts`
 *  (the barrel) early, so by the time codeIndex.ts asks for the
 *  extension set the registrations have all fired. */
export function getAllExtensions(): readonly string[] {
  const out = new Set<string>();
  for (const h of handlers.values()) {
    for (const ext of h.extensions) out.add(ext.toLowerCase());
  }
  return [...out];
}
