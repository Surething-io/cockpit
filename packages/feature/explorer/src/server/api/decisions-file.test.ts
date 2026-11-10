/**
 * GET /api/decisions/file through the real route: a symbol link is placed on
 * the symbol's CURRENT line, a decision only on another branch is hidden, and
 * with decision mode off nothing is returned.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import { beforeAll, describe, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'cockpit-decisions-file-'));
process.env.COCKPIT_HOME = join(root, 'home');
const repo = join(root, 'repo');

let GET: typeof import('./decisions-file').GET;
let decisions: typeof import('@cockpit/feature-decisions/server');

const git = (...a: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...a], { cwd: repo, stdio: 'pipe' }).toString().trim();
const blobOf = (c: string) => execFileSync('git', ['hash-object', '--stdin'], { input: c }).toString().trim();
const call = async () => (await GET(new Request(`http://x/api/decisions/file?cwd=${encodeURIComponent(repo)}&path=src/lib.ts`))).json();

beforeAll(async () => {
  mkdirSync(join(repo, 'src'), { recursive: true });
  git('init', '-q');
  writeFileSync(join(repo, 'src/lib.ts'), `// header\n\nexport function greet(name: string) {\n  return name;\n}\n`);
  git('add', '.');
  git('commit', '-qm', `init ${repo}`);
  ({ GET } = await import('./decisions-file'));
  decisions = await import('@cockpit/feature-decisions/server');
});

describe('GET /api/decisions/file', () => {
  it('off → nothing; on → file decisions with current symbol lines, other-branch hidden', async () => {
    expect(await call()).toEqual({ enabled: false, decisions: [] });
    await Effect.runPromise(decisions.setEnabled(repo, true));
    const { projectId } = await Effect.runPromise(decisions.requireProject(repo));
    const content = { choice: 'greet stays sync', alternatives: [], rationale: '', tradeoffs: '', premises: [] };
    const sym = await Effect.runPromise(decisions.createDecision(projectId, { content, source: { kind: 'manual' }, links: [{ path: 'src/lib.ts', symbol: 'greet' }] }));
    await Effect.runPromise(decisions.createDecision(projectId, { content: { ...content, choice: 'elsewhere' }, source: { kind: 'manual' }, links: [{ path: 'src/lib.ts', blob: blobOf('only on a branch\n') }] }));
    git('checkout', '-qb', 'feature');
    writeFileSync(join(repo, 'src/lib.ts'), 'only on a branch\n');
    git('commit', '-qam', 'feature');
    git('checkout', '-q', 'main');

    const r = await call();
    expect(r.enabled).toBe(true);
    expect(r.decisions.map((x: { decision: { id: string }; lines: number[]; state: string }) => [x.decision.id, x.state, x.lines])).toEqual([[sym.id, 'applicable', [3]]]);
  });
});
