import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { Effect, Either } from 'effect';
import { AppError, FSError, ValidationError } from '@cockpit/effect-core';
import type { ProjectContextFiles } from '../handlers/types';
import { getAllExtensions } from '../handlers/registry';

const exec = promisify(execFile);
export const INDEX_FILE_LIMIT = 100_000;
export const INDEX_SOURCE_LIMIT_BYTES = 2 * 1024 * 1024;

export interface ExcludedIndexFile {
  filePath: string;
  reason: 'source-too-large';
  sizeBytes: number;
  limitBytes: number;
}

/** Keep tagged failures intact across the existing Promise-based index API. */
async function run<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const result = await Effect.runPromise(Effect.either(effect));
  if (Either.isLeft(result)) throw result.left;
  return result.right;
}

async function git(cwd: string, args: string[]): Promise<string> {
  return run(Effect.tryPromise({
    try: () => exec('git', args, { cwd, maxBuffer: 50 * 1024 * 1024 }).then((r) => r.stdout),
    catch: (cause) => new AppError({ message: 'Code index Git command failed', cause }),
  }));
}

export function isIndexPath(filePath: string): boolean {
  return !filePath.split('/').some((p) => p === 'node_modules' || p === '.git');
}

export function isIndexSource(filePath: string): boolean {
  return isIndexPath(filePath) && getAllExtensions().includes(path.posix.extname(filePath).toLowerCase());
}

export async function requireGitProject(cwd: string): Promise<string> {
  return run(Effect.tryPromise({
    try: async () => {
      const result = await exec('git', ['rev-parse', '--is-inside-work-tree', '--absolute-git-dir'], { cwd });
      const [inside, ...dir] = result.stdout.trimEnd().split('\n');
      if (inside !== 'true') throw new Error('Not a Git working tree');
      return dir.join('\n');
    },
    catch: (cause) => /not a git repository/i.test((cause as { stderr?: string }).stderr ?? '') || (cause as Error).message === 'Not a Git working tree'
      ? new ValidationError({ field: 'cwd', reason: 'Non-Git projects are not supported' })
      : new AppError({ message: 'Unable to inspect Git project', cause }),
  }));
}

export async function listIndexPaths(cwd: string): Promise<string[]> {
  await requireGitProject(cwd);
  const output = await git(cwd, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  return [...new Set(output.split('\0').filter((p) => p && isIndexPath(p)))].sort();
}

async function optional<A>(task: () => Promise<A>): Promise<A | null> {
  return run(Effect.tryPromise({ try: task, catch: (cause) => cause }).pipe(
    Effect.catchAll((cause) => (cause as NodeJS.ErrnoException).code === 'ENOENT'
      ? Effect.succeed(null)
      : Effect.fail(new FSError({ path: 'code-index scan', op: 'read', cause }))),
  ));
}

export interface GitIndexState { head: string; busy: boolean; commonDir: string }

export async function readGitIndexState(cwd: string): Promise<GitIndexState> {
  const dir = await requireGitProject(cwd);
  const commonPath = (await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trimEnd();
  const commonDir = await run(Effect.tryPromise({
    try: () => fs.realpath(commonPath),
    catch: (cause) => new FSError({ path: commonPath, op: 'read', cause }),
  }));
  const markers = await Promise.all(['index.lock', 'rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']
    .map((name) => optional(() => fs.stat(path.join(dir, name)))));
  // An unborn branch has no HEAD object. Other command failures must propagate.
  const head = await run(Effect.tryPromise({
    try: () => exec('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd }).then((r) => r.stdout.trim()),
    catch: (cause) => cause,
  }).pipe(Effect.catchAll((cause) => (cause as { code?: number }).code === 1
    ? Effect.succeed('unborn')
    : Effect.fail(new AppError({ message: 'Unable to read Git HEAD', cause })))));
  const unmerged = await git(cwd, ['ls-files', '--unmerged', '-z']);
  return { head, busy: markers.some(Boolean) || unmerged.length > 0, commonDir };
}

export interface SourceContent { source: string; hash: string; mtime: number; sizeBytes: number }
export interface IndexScan {
  sources: Map<string, SourceContent>;
  hashes: Map<string, string>;
  configHash: string;
  truncated: boolean;
  git: GitIndexState;
  contextFiles: ProjectContextFiles;
}

export const contentHash = (content: string | Buffer): string => createHash('sha256').update(content).digest('hex');

export async function readIndexSource(cwd: string, relPath: string): Promise<SourceContent | null> {
  const abs = path.join(cwd, relPath);
  return optional(async () => {
    const [bytes, stat] = await Promise.all([fs.readFile(abs), fs.stat(abs)]);
    return { source: bytes.toString('utf8'), hash: contentHash(bytes), mtime: stat.mtimeMs, sizeBytes: bytes.length };
  });
}

function isConfig(p: string): boolean {
  return /(^|\/)(tsconfig[^/]*\.json|package\.json|pnpm-workspace\.yaml|go\.mod|\.gitignore)$/.test(p);
}

export async function scanIndexFiles(cwd: string, allowBusy = false): Promise<IndexScan> {
  const state = await readGitIndexState(cwd);
  if (state.busy && !allowBusy) throw new AppError({ message: 'Workspace is changing: finish the Git operation or explicitly rebuild the index' });
  const paths = await listIndexPaths(cwd);
  const candidates = paths.filter(isIndexSource);
  const selected = candidates.slice(0, INDEX_FILE_LIMIT);
  const sources = new Map<string, SourceContent>();
  const hashes = new Map<string, string>();
  let cursor = 0;
  let failed = false;
  const outcomes = await Promise.allSettled(Array.from({ length: Math.min(8, selected.length) }, async () => {
    while (!failed && cursor < selected.length) {
      const p = selected[cursor++];
      const content = await readIndexSource(cwd, p).catch((cause: unknown) => { failed = true; throw cause; });
      // Tracked paths can remain in ls-files after deletion from disk.
      if (content) { sources.set(p, content); hashes.set(p, content.hash); }
    }
  }));
  // Drain sibling reads before the project owner can release this failed task.
  const failure = outcomes.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  // Paths outside the admission limit are known members, not observed deletions.
  // Their content is deliberately unknown until they enter the admitted prefix.
  for (const p of candidates.slice(INDEX_FILE_LIMIT)) hashes.set(p, 'not-scanned');
  const configs = new Map<string, string>();
  const configContents = new Map<string, string>();
  // Root configuration may be ignored but is still read by a language handler.
  const configPaths = new Set([...paths.filter(isConfig), 'tsconfig.json', 'package.json', 'pnpm-workspace.yaml', 'go.mod']);
  for (const p of [...configPaths].sort()) {
    // Keep the nullable result at the Promise callback boundary. Turbopack
    // incorrectly folds the post-await null guard to true for optional configs.
    await readIndexSource(cwd, p).then((content) => {
      if (content) { configs.set(p, content.hash); configContents.set(p, content.source); }
    });
  }
  const configHash = contentHash(JSON.stringify([...configs]));
  const contextFiles: ProjectContextFiles = {
    paths: [...new Set([...paths, ...configContents.keys()])],
    readFile: async (p) => {
      const source = sources.get(p)?.source ?? configContents.get(p);
      if (source !== undefined) return source;
      // Preserve readFile's missing-file semantics for optional config fallbacks.
      throw new FSError({ path: p, op: 'read', cause: Object.assign(new Error(`File not captured: ${p}`), { code: 'ENOENT' }) });
    },
  };
  return { sources, hashes, configHash, truncated: candidates.length > INDEX_FILE_LIMIT, git: state, contextFiles };
}

export function diffIndexFiles(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>) {
  const added: string[] = [], changed: string[] = [], deleted: string[] = [];
  for (const [p, hash] of after) {
    if (!before.has(p)) added.push(p);
    else if (before.get(p) !== hash) changed.push(p);
  }
  for (const p of before.keys()) if (!after.has(p)) deleted.push(p);
  const count = added.length + changed.length + deleted.length;
  const size = Math.max(before.size, after.size);
  return { added, changed, deleted, count, rebuild: count >= 500 || (count >= 20 && count / size >= 0.2) };
}

export function indexQueryError(cause: unknown, message: string) {
  if (cause instanceof AppError || cause instanceof FSError || cause instanceof ValidationError) return cause;
  return new AppError({ message, cause });
}
