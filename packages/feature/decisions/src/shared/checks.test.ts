import { describe, expect, it } from 'vitest';
import { classifyCommand, expectedKinds, normalizeCommand } from './checks';

const scripts = {
  test: 'vitest run',
  lint: 'eslint',
  typecheck: 'tsc --noEmit -p .',
  dev: 'next dev',
  'test:watch': 'vitest',
  verify: 'npm run lint && npm test',
};
const none = { include: [], exclude: [] };
const kind = (cmd: string, s: Record<string, string> = scripts, o = none) => classifyCommand(cmd, s, o)?.kind ?? null;

describe('classifyCommand', () => {
  it.each([
    ['npm test', 'test'],
    ['npm t', 'test'],
    ['pnpm run lint', 'lint'],
    ['yarn typecheck', 'typecheck'],
    ['npx vitest run src/a.test.ts', 'test'],
    ['./node_modules/.bin/jest', 'test'],
    ['cd packages/x && npm test 2>&1 | tail -20', 'test'],
    ['CI=1 npx tsc --noEmit', 'typecheck'],
    ['python -m pytest -k slow', 'test'],
    ['go test ./...', 'test'],
    ['cargo clippy', 'lint'],
    ['node --test test/', 'test'],
    ['make test', 'test'],
    ['timeout 120 npx eslint src', 'lint'],
    ['npm run verify', 'lint'], // first check inside the script body
  ])('%s → %s', (cmd, k) => expect(kind(cmd)).toBe(k));

  it.each(['git status', 'npm install', 'npm run dev', 'npx vitest --watch', 'echo npm test', 'ls -la', 'cat package.json', 'tsc -w'])(
    '%s is not a check',
    (cmd) => expect(kind(cmd)).toBeNull(),
  );

  it('script names count even when package.json is unknown', () => {
    expect(kind('npm test', {})).toBe('test');
    expect(kind('npm run lint:fix', {})).toBe('lint');
  });

  it('records file filters and name filters', () => {
    expect(classifyCommand('npx vitest run src/a.test.ts src/b.test.ts', scripts, none)).toEqual({ kind: 'test', filtered: true, targets: ['src/a.test.ts', 'src/b.test.ts'] });
    expect(classifyCommand('npm test -- -t "renders"', scripts, none)).toMatchObject({ kind: 'test', filtered: true, targets: [] });
    expect(classifyCommand('npm test', scripts, none)).toEqual({ kind: 'test', filtered: false, targets: [] });
    expect(classifyCommand('go test ./...', scripts, none)?.filtered).toBe(false);
  });

  it('user corrections win, keyed by normalized command', () => {
    expect(classifyCommand('npm  test', scripts, { include: [], exclude: ['npm test'] })).toBeNull();
    expect(classifyCommand('./scripts/check.sh', scripts, { include: ['./scripts/check.sh'], exclude: [] })).toEqual({ kind: 'custom', filtered: false, targets: [] });
    expect(normalizeCommand('  a   b \n')).toBe('a b');
  });
});

describe('expectedKinds', () => {
  it('from scripts and project markers, ignoring watch scripts', () => {
    expect(expectedKinds(scripts, {})).toEqual(['test', 'typecheck', 'lint']);
    expect(expectedKinds({ 'test:watch': 'vitest' }, {})).toEqual([]);
    expect(expectedKinds({}, { goMod: true })).toEqual(['test']);
  });
});
