// Native child transcripts belong to the parent session, never the top-level list.
import { mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Effect } from 'effect';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { writeAtomically } from '@cockpit/effect-runtime/server/fs';
import { AppError } from '@cockpit/effect-core';

export interface PiChildMeta {
  id: string;
  toolUseId: string;
  name: string;
  task: string;
  model: string;
  index: number;
  sessionPath: string;
  status: 'running' | 'done' | 'failed' | 'cancelled' | 'truncated' | 'interrupted';
}
const io = <A>(fn: () => Promise<A>): Effect.Effect<A, AppError> => Effect.tryPromise({
  try: fn, catch: (cause) => new AppError({ message: 'Pi subagent history operation failed', cause }),
});
const safeId = (id: string): boolean => /^[A-Za-z0-9_-]+$/.test(id);
export const piChildRoot = (parentPath: string, parentId: string): string => {
  if (!safeId(parentId)) throw new Error('Invalid parent session id');
  return join(dirname(parentPath), parentId, 'subagents');
};

/** Create a native header up front so startup failures and cancellations remain inspectable. */
export const createPiChildSession = (parentPath: string, parentId: string, cwd: string,
  meta: Omit<PiChildMeta, 'sessionPath' | 'status'>, instructions: string,
): Effect.Effect<PiChildMeta, AppError> => io(async () => {
  if (!safeId(meta.id)) throw new Error('Invalid child session id');
  const dir = join(piChildRoot(parentPath, parentId), meta.id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const { SessionManager } = await import('@earendil-works/pi-coding-agent');
  const manager = SessionManager.create(cwd, dir, { id: meta.id, parentSession: parentPath });
  manager.appendCustomEntry('cockpit.subagent-instructions', { text: instructions });
  const path = manager.getSessionFile()!;
  await writeFile(path, [manager.getHeader(), ...manager.getEntries()].map((e) => JSON.stringify(e)).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  const record: PiChildMeta = { ...meta, status: 'running', sessionPath: relative(join(dirname(parentPath), parentId), path) };
  await writeAtomically(join(dir, 'meta.json'), JSON.stringify(record));
  return record;
});

export const finishPiChildSession = (parentPath: string, parentId: string, meta: PiChildMeta,
  status: PiChildMeta['status'],
): Effect.Effect<void, AppError> => io(() => writeAtomically(join(piChildRoot(parentPath, parentId), meta.id, 'meta.json'),
  JSON.stringify({ ...meta, status })));

/** Only the host writes this fallback, after the CLI has actually exited. */
export const retainPiChildPartial = (path: string, output: string): Effect.Effect<void, AppError> => io(async () => {
  if (!output) return;
  const { SessionManager } = await import('@earendil-works/pi-coding-agent');
  const manager = SessionManager.open(path);
  const last = manager.getBranch().findLast((e) => e.type === 'message' && e.message.role === 'assistant');
  if (last?.type === 'message' && last.message.role === 'assistant') {
    const text = last.message.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
    if (text.includes(output)) return;
  }
  manager.appendCustomEntry('cockpit.subagent-interrupted-output', {
    text: `Interrupted child output retained by Cockpit after process exit (incomplete):\n\n${output}`,
  });
});

/** Resolve only real files within the selected child's directory; never accept a client path. */
export const listPiChildren = (parentPath: string, parentId: string, toolUseId?: string): Effect.Effect<PiChildMeta[], AppError> => io(async () => {
  const root = piChildRoot(parentPath, parentId);
  const dirs = await readdir(root, { withFileTypes: true }).catch((cause: NodeJS.ErrnoException) => { if (cause.code === 'ENOENT') return []; throw cause; });
  const children: PiChildMeta[] = [];
  if (!dirs.length) return children;
  const canonicalRoot = join(await realpath(dirname(parentPath)), parentId, 'subagents');
  if (await realpath(root) !== canonicalRoot) throw new Error('Invalid Pi child history root');
  for (const dir of dirs) {
    if (!dir.isDirectory() || !safeId(dir.name)) continue;
    const raw = await readFile(join(root, dir.name, 'meta.json'), 'utf8').catch((cause: NodeJS.ErrnoException) => { if (cause.code === 'ENOENT') return undefined; throw cause; });
    if (!raw) continue; // A child can be between directory creation and its launch receipt.
    const meta = JSON.parse(raw) as PiChildMeta;
    if (meta.id !== dir.name || (toolUseId && meta.toolUseId !== toolUseId)) continue;
    const base = await realpath(join(root, dir.name));
    const path = await realpath(resolve(dirname(root), meta.sessionPath));
    if (!path.startsWith(base + sep) || !path.endsWith('.jsonl')) throw new Error('Invalid Pi child transcript path');
    // Also reject symlinked ancestors outside the parent's artifact directory.
    if (!base.startsWith(canonicalRoot + sep)) throw new Error('Invalid Pi child directory');
    children.push(meta);
  }
  return children.sort((a, b) => a.index - b.index);
});

export const piSubagentCallIds = (entries: SessionEntry[]): Set<string> => new Set(entries.flatMap((entry) =>
  entry.type === 'message' && entry.message.role === 'assistant'
    ? entry.message.content.flatMap((block) => block.type === 'toolCall' && block.name === 'subagent' ? [block.id] : []) : []));

/** Relative references survive copying; each fork owns independent files. */
export const copyPiChildren = (source: string, sourceId: string, destination: string, destinationId: string,
  entries: SessionEntry[],
): Effect.Effect<void, AppError> => Effect.gen(function* () {
  const calls = piSubagentCallIds(entries);
  const children = yield* listPiChildren(source, sourceId);
  for (const child of children) if (calls.has(child.toolUseId)) yield* io(async () => {
    const dest = join(piChildRoot(destination, destinationId), child.id);
    await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
    await mkdir(dest, { mode: 0o700 });
    const path = resolve(dirname(destination), destinationId, child.sessionPath);
    const raw = await readFile(resolve(dirname(source), sourceId, child.sessionPath), 'utf8');
    // An active writer can be between writes. Freeze only complete JSONL records;
    // the cloned directory never owns the source process or its future updates.
    const lines = raw.slice(0, raw.lastIndexOf('\n') + 1).trimEnd().split('\n');
    for (const line of lines) JSON.parse(line);
    lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), parentSession: destination });
    await writeAtomically(path, lines.join('\n') + '\n');
    if (child.status === 'running') {
      const { SessionManager } = await import('@earendil-works/pi-coding-agent');
      SessionManager.open(path).appendCustomEntry('cockpit.subagent-snapshot', {
        text: 'Frozen child history copied while the original task was running. This snapshot has no execution process and will not receive further updates.',
      });
    }
    await writeAtomically(join(dest, 'meta.json'), JSON.stringify({ ...child, status: child.status === 'running' ? 'interrupted' : child.status }));
  });
});

export const prunePiChildren = (parentPath: string, parentId: string, entries: SessionEntry[]): Effect.Effect<void, AppError> => Effect.gen(function* () {
  const calls = piSubagentCallIds(entries);
  const children = yield* listPiChildren(parentPath, parentId);
  for (const child of children) if (!calls.has(child.toolUseId)) yield* io(() => rm(join(piChildRoot(parentPath, parentId), child.id), { recursive: true, force: true }));
});
