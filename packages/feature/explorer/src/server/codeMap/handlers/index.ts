/**
 * Handler barrel — single import point that triggers registration of
 * every per-language handler.
 *
 * USAGE: import this barrel ONCE, early in the app bootstrap path
 * (server entry, route handler init, test setup). Each handler module
 * registers itself as an import side effect, so this barrel doesn't
 * need to do anything itself — the imports below are the entire point.
 *
 * Adding a new language handler:
 *   1. Write `./<lang>.ts` with `registerHandler(...)` at the bottom
 *   2. Add an `import './<lang>';` line below
 *   3. Done. No registry-of-registries to edit.
 *
 * NOTE (P0): no handlers are imported yet — the typescript.ts /
 * python.ts modules don't exist until P1 / P2. This barrel exists in
 * P0 so the bootstrap import path is in place; downstream code can
 * already start `import './handlers'` even though the registry is
 * empty. The codeMap pipeline still uses its existing direct calls
 * during P0 (no dispatch through `getHandler` yet — that wiring lands
 * in P1 alongside the first real handler).
 */

// === Handlers ===
// Each import triggers `registerHandler(...)` as a side effect.
// Adding a new language: write `./<lang>.ts`, add an import line here.
import { registerHandler } from './registry';
import {
  typescriptHandler,
  tsxHandler,
  javascriptHandler,
} from './typescript';
import { pythonHandler } from './python';
import { goHandler } from './go';
import { rustHandler } from './rust';

registerHandler(typescriptHandler);
registerHandler(tsxHandler);
registerHandler(javascriptHandler);
registerHandler(pythonHandler);
registerHandler(goHandler);
registerHandler(rustHandler);

export { registerHandler, getHandler, tryGetHandler, hasHandler } from './registry';
export type {
  LanguageHandler,
  ProjectContext,
  ImportExtraction,
  CallResolution,
} from './types';
