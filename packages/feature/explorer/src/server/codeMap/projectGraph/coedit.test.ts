import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';
import { coEditFromGit } from './coedit';
import { getCodeIndex, invalidateIndex } from './codeIndex';
import { buildRelated } from '../analytics/relatedBuilder';
import { GET } from '../../api/projectGraph/coedit';

const gitFault = vi.hoisted(() => ({ command: undefined as 'log' | 'status' | 'all' | undefined }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const execFile = (...args: unknown[]) => {
    const [file, argv] = args;
    const command = gitFault.command;
    if (file === 'git' && Array.isArray(argv) && command
      && (command === 'all' || argv.includes(command))) {
      // A real failing child process exercises native exit/error propagation
      // without requiring a POSIX shell or a platform-specific fake executable.
      return Reflect.apply(actual.execFile, actual, [process.execPath, ['-e', 'process.exit(42)'], ...args.slice(2)]);
    }
    return Reflect.apply(actual.execFile, actual, args);
  };
  Object.defineProperty(execFile, promisify.custom, {
    value: (...args: unknown[]) => new Promise((resolve, reject) => {
      execFile(...args, (error: Error | null, stdout: string, stderr: string) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      });
    }),
  });
  return { ...actual, execFile };
});

let cwd: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const commit = () => {
  git('add', '.');
  git('-c', 'user.name=Coedit Test', '-c', 'user.email=coedit@example.test', 'commit', '-qm', 'fixture');
};
beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(tmpdir(), 'cg-coedit-'));
  git('init', '-q');
  await fs.writeFile(path.join(cwd, 'core.ts'), 'export function target() {}');
  await fs.writeFile(path.join(cwd, 'partner.ts'), 'export function partner() {}');
});
afterEach(async () => {
  gitFault.command = undefined;
  invalidateIndex(cwd);
  await fs.rm(cwd, { recursive: true, force: true });
});

describe('coedit Git outcomes', () => {
  it('accepts unborn branches and untracked files as genuinely empty history', async () => {
    expect(await coEditFromGit(cwd, 'core.ts')).toMatchObject({ history: [], totalCommits: 0 });
    const index = await getCodeIndex(cwd);
    expect(await Effect.runPromise(buildRelated(index, { qname: 'target' }))).toMatchObject({ degraded: false });
    commit();
    expect(await coEditFromGit(cwd, 'untracked.ts')).toMatchObject({ history: [], totalCommits: 0 });
    expect(await coEditFromGit(cwd, 'core.ts')).toMatchObject({ totalCommits: 1 });
  });

  it.each(['log', 'status', 'all'] as const)('propagates %s failures through coedit HTTP and degrades related', async (command) => {
    commit();
    const index = await getCodeIndex(cwd);
    gitFault.command = command;
    await expect(coEditFromGit(cwd, 'core.ts')).rejects.toMatchObject({
      _tag: 'AppError', cause: expect.objectContaining({ code: 42 }),
    });
    const related = await Effect.runPromise(buildRelated(index, { qname: 'target' }));
    expect(related).toMatchObject({ degraded: true, degradedReason: 'coedit-unavailable', coedit: [] });
    // A fully failing executable also prevents requireGitProject. The route
    // must report failure either way instead of returning a successful empty set.
    const response = await GET(new Request(`http://localhost/api/projectGraph/coedit?cwd=${encodeURIComponent(cwd)}&filePath=core.ts`));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ tag: 'AppError' });
  });
});
