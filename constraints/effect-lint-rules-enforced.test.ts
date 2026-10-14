/**
 * Constraint: EffectLintRulesEnforced (architecture rule, L4).
 *
 * The IO rules EFFECT.md §10 lists as lint-enforced fail `npm run lint` (and
 * so CI) — they are errors, not warnings — in the directories the doc names:
 *
 *   server IO code    Promise.all / Promise.race / setTimeout / setInterval
 *   client code       window.parent.postMessage
 *   components (.tsx) a direct fetch(…)
 *
 * Why: the doc said these were forbidden and "enforced in eslint.config.mjs",
 * but every rule was "warn", which never fails the lint step, so violations
 * accumulated unnoticed. A rule the doc calls enforced must be able to fail
 * the build.
 */
import { ESLint } from 'eslint';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const eslint = new ESLint({ cwd: ROOT });

async function errorsFor(code: string, relPath: string): Promise<number> {
  const [res] = await eslint.lintText(code, { filePath: join(ROOT, relPath) });
  return res.messages.filter((m) => m.ruleId === 'no-restricted-syntax' && m.severity === 2).length;
}

const SERVER_FILES = [
  'src/app/api/example/route.ts',
  'src/lib/effect/example.ts',
  'packages/feature/agent/src/effect/example.ts',
  'packages/feature/agent/src/server/effect/example.ts',
  'packages/feature/explorer/src/server/api/example.ts',
];

describe('EffectLintRulesEnforced', () => {
  it('server IO code: Promise.all / race, setTimeout / setInterval are errors', async () => {
    for (const file of SERVER_FILES) {
      for (const code of [
        'export const f = (ps: Promise<unknown>[]) => Promise.all(ps);',
        'export const f = (ps: Promise<unknown>[]) => Promise.race(ps);',
        'export const f = () => setTimeout(() => {}, 10);',
        'export const f = () => setInterval(() => {}, 10);',
      ]) {
        expect(await errorsFor(code, file), `${file}: ${code}`).toBe(1);
      }
    }
    // 20 sequential lints, the first of which loads the whole ESLint config.
    // ~1.8s on a macOS runner normally, but past the 5s default under load.
  }, 30_000);

  it('client code: window.parent.postMessage is an error', async () => {
    expect(await errorsFor('export const f = () => window.parent.postMessage({}, "*");', 'packages/feature/agent/src/client/example.ts')).toBe(1);
  });

  it('components: a direct fetch is an error', async () => {
    expect(await errorsFor('export const f = () => fetch("/api/x");', 'packages/feature/agent/src/client/Example.tsx')).toBe(1);
  });
});
