/**
 * Native Grok Build 1.0.70 context editing. Cockpit's JSONL is a display transcript;
 * Grok resumes chat_history.jsonl and derives prompt indices from updates.jsonl.
 * Edit both stores together, preserving complete tool/reasoning items verbatim.
 */
import { mkdir, readFile, readdir, rename, rm, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Effect } from 'effect';
import { FSError } from '@cockpit/effect-core';
import { rewriteTranscript } from '../server/transcriptWrite';
import { object, type AcpObject } from '../server/engines/grokAcp/client';
import { isHumanTurnStart } from '../shared/transcriptTurns';
import { grokSessionPath } from './grokSessionLive';

type Native = { summary: AcpObject; chat: AcpObject[]; updates: AcpObject[] };
const jsonl = (items: AcpObject[]): string => items.map((item) => JSON.stringify(item)).join('\n') + (items.length ? '\n' : '');
const parseLines = (text: string): AcpObject[] => text.split('\n').filter((line) => line.trim()).map((line) => object(JSON.parse(line)));
const io = <A>(path: string, action: () => Promise<A>): Effect.Effect<A, FSError> => Effect.tryPromise({
  try: action, catch: (cause) => new FSError({ path, op: 'write', cause }),
});

export function grokNativeSessionPath(cwd: string, sessionId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error('Invalid Grok session id');
  const encoded = encodeURIComponent(cwd).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return join(process.env.GROK_HOME || join(homedir(), '.grok'), 'sessions', encoded, sessionId);
}

async function optionalText(path: string): Promise<string | undefined> {
  return readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
}
async function readNative(dir: string): Promise<Native> {
  const summary = object(JSON.parse(await readFile(join(dir, 'summary.json'), 'utf8')));
  if (summary.chat_format_version !== 1) throw new Error('Unsupported Grok chat history format; update the Cockpit adapter before editing this session.');
  return { summary, chat: parseLines(await readFile(join(dir, 'chat_history.jsonl'), 'utf8')),
    updates: parseLines(await optionalText(join(dir, 'updates.jsonl')) ?? '') };
}
const indexOf = (item: AcpObject): number | undefined => typeof item.prompt_index === 'number' ? item.prompt_index : undefined;
function nextIndex(data: Native): number {
  let index = -1;
  for (const entry of data.chat) index = Math.max(index, indexOf(entry) ?? -1);
  for (const entry of data.updates) {
    const update = object(object(entry.params).update);
    const value = object(update._meta).promptIndex;
    if (typeof value === 'number') index = Math.max(index, value);
  }
  return index + 1;
}
function renumber(item: AcpObject, map: Map<number, number>, sessionId: string, updates: boolean): AcpObject {
  const copy = structuredClone(item);
  if (!updates) {
    const index = indexOf(copy);
    if (index !== undefined) copy.prompt_index = map.get(index) ?? index;
  } else {
    const params = object(copy.params);
    params.sessionId = sessionId;
    const update = object(params.update);
    const meta = object(update._meta);
    if (typeof meta.promptIndex === 'number') meta.promptIndex = map.get(meta.promptIndex) ?? meta.promptIndex;
    const outerMeta = object(params._meta);
    if (typeof outerMeta.eventId === 'string') outerMeta.eventId = `${sessionId}-${randomUUID()}`;
  }
  return copy;
}
/** Preserve the CLI preamble, then whole native turns; never split tool calls/results. */
function selectNative(data: Native, keep: Set<number>, sessionId: string): Native {
  const count = nextIndex(data);
  const indices = new Set(data.chat.flatMap((item) => indexOf(item) === undefined ? [] : [indexOf(item)!]));
  // Compaction can replace earlier turns with a summary that still contains their data.
  // Refuse an inexact edit rather than leak excluded turns through that summary.
  if (Array.from({ length: count }, (_, i) => i).some((i) => !indices.has(i))) {
    throw new Error('This Grok session has compacted history. Exact turn editing requires the original native turns. Start a new session or fork the complete session.');
  }
  const map = new Map([...keep].sort((a, b) => a - b).map((value, i) => [value, i]));
  let current = -1;
  const chat = data.chat.filter((item) => {
    current = indexOf(item) ?? current;
    return current === -1 || keep.has(current);
  }).map((item) => renumber(item, map, sessionId, false));
  current = -1;
  const updates = data.updates.filter((item) => {
    const update = object(object(item.params).update);
    const value = object(update._meta).promptIndex;
    if (typeof value === 'number') current = value;
    // Rewind/checkpoint references belong to the old timeline, not the selected turns.
    if (/rewind|compaction/i.test(String(update.sessionUpdate ?? ''))) return false;
    return current >= 0 && keep.has(current);
  }).map((item) => renumber(item, map, sessionId, true));
  return { summary: { ...data.summary, info: { ...object(data.summary.info), id: sessionId },
    num_messages: updates.length, num_chat_messages: chat.length, next_trace_turn: keep.size + 1,
    last_turn_summary: null, last_turn_summary_prompt_id: null, last_recap: null }, chat, updates };
}
function nativeFiles(dir: string, data: Native): Record<string, string> {
  return { [join(dir, 'chat_history.jsonl')]: jsonl(data.chat), [join(dir, 'updates.jsonl')]: jsonl(data.updates),
    [join(dir, 'summary.json')]: JSON.stringify(data.summary, null, 2) };
}
/** Roll back an interrupted multi-file edit before the next native resume. */
async function recoverEdit(dir: string): Promise<void> {
  const journal = join(dir, 'cockpit-edit-backup.json');
  const text = await optionalText(journal);
  if (!text) return;
  const backup = object(JSON.parse(text));
  for (const [path, content] of Object.entries(backup)) {
    if (content === null) await rm(path, { force: true });
    else if (typeof content === 'string') await rewriteTranscript(path, content);
    else throw new Error('Invalid Grok edit recovery journal');
  }
  await rm(journal);
}
async function transaction(dir: string, files: Record<string, string | null>): Promise<void> {
  await recoverEdit(dir);
  const backup: Record<string, string | null> = {};
  for (const path of Object.keys(files)) backup[path] = await optionalText(path) ?? null;
  const journal = join(dir, 'cockpit-edit-backup.json');
  await rewriteTranscript(journal, JSON.stringify(backup));
  try {
    for (const [path, text] of Object.entries(files)) {
      if (text === null) await rm(path, { force: true });
      else await rewriteTranscript(path, text);
    }
    await rm(journal);
  } catch (error) { await recoverEdit(dir); throw error; }
}
async function writeClone(cwd: string, sourceId: string, newId: string, data: Native): Promise<void> {
  const source = grokNativeSessionPath(cwd, sourceId);
  const target = grokNativeSessionPath(cwd, newId);
  const staging = `${target}.${randomUUID()}.tmp`;
  await mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    // Only immutable setup is inherited. Plans, tasks, checkpoints, recaps and file
    // rewinds can refer to excluded turns and are deliberately not copied.
    for (const name of ['system_prompt.txt', 'tool_definitions.json', 'prompt_context.json']) {
      await copyFile(join(source, name), join(staging, name)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    }
    const summary = { ...data.summary, info: { ...object(data.summary.info), id: newId, cwd },
      agent_id: `ag1.${randomUUID().replaceAll('-', '')}`, attempt_id: `at1.${randomUUID().replaceAll('-', '')}`,
      parent_session_id: sourceId, request_id: null, created_at: new Date().toISOString() };
    for (const [path, text] of Object.entries(nativeFiles(staging, { ...data, summary, updates: data.updates.map((item) => renumber(item, new Map(), newId, true)) }))) await rewriteTranscript(path, text);
    await rename(staging, target);
  } finally { await rm(staging, { recursive: true, force: true }); }
}
function displayTurns(entries: AcpObject[]): { byLine: number[]; count: number } {
  let current = -1;
  const byLine = entries.map((entry) => { if (isHumanTurnStart(entry)) current++; return current; });
  return { byLine, count: current + 1 };
}

export const editGrokTurn = (cwd: string, sessionId: string, uuid: string | undefined, scope: 'delete' | 'prefix' | 'single') =>
  io(grokNativeSessionPath(cwd, sessionId), async () => {
    const dir = grokNativeSessionPath(cwd, sessionId);
    await recoverEdit(dir);
    await mergeIndependent(cwd, sessionId);
    const displayPath = grokSessionPath(cwd, sessionId);
    const entries = parseLines(await readFile(displayPath, 'utf8'));
    const turns = displayTurns(entries);
    const targetLine = uuid ? entries.findIndex((entry) => entry.uuid === uuid) : entries.length - 1;
    const target = turns.byLine[targetLine];
    if (target === undefined || target < 0) return undefined;
    const data = await readNative(dir);
    if (turns.count !== nextIndex(data)) throw new Error('Grok native history and display turns differ; refusing to edit the wrong native turn.');
    const keep = new Set(Array.from({ length: turns.count }, (_, i) => i).filter((i) => scope === 'delete' ? i !== target : scope === 'single' ? i === target : i <= target));
    const newId = scope === 'delete' ? sessionId : randomUUID();
    const all = keep.size === turns.count;
    const native = all ? data : selectNative(data, keep, newId);
    const selected = entries.filter((_, i) => turns.byLine[i] === -1 || keep.has(turns.byLine[i]));
    let previous: string | null = null;
    for (const entry of selected) {
      entry.sessionId = newId;
      if (scope !== 'delete') entry.uuid = randomUUID();
      entry.parentUuid = previous;
      if (typeof entry.uuid === 'string') previous = entry.uuid;
    }
    if (scope === 'delete') {
      const files: Record<string, string | null> = nativeFiles(dir, native);
      // Auxiliary native state can itself contain turn content (plans and recaps).
      for (const name of await readdir(dir)) {
        if (/^(plan|signals|announcement_state|goal_mode_state).*\.json$/.test(name)) files[join(dir, name)] = null;
      }
      files[join(dir, 'rewind_points.jsonl')] = '';
      files[join(dir, 'goal', 'state.json')] = null;
      const workflows = await readdir(join(dir, 'workflows'), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      for (const workflow of workflows) {
        if (workflow.isDirectory()) files[join(dir, 'workflows', workflow.name, 'cleared')] = '';
      }
      await transaction(dir, { ...files, [displayPath]: jsonl(selected) });
    } else {
      await writeClone(cwd, sessionId, newId, native);
      try { await rewriteTranscript(grokSessionPath(cwd, newId), jsonl(selected)); }
      catch (error) { await rm(grokNativeSessionPath(cwd, newId), { recursive: true, force: true }); throw error; }
    }
    return { newSessionId: newId, messageCount: selected.length, deletedLineCount: entries.length - selected.length, targetMissed: false };
  });

type Independent = { sessionId: string; offset: number; preambleCount: number };
async function mergeIndependent(cwd: string, sessionId: string): Promise<void> {
  const dir = grokNativeSessionPath(cwd, sessionId);
  await recoverEdit(dir);
  const marker = join(dir, 'cockpit-independent.json');
  const text = await optionalText(marker);
  if (!text) return;
  const branch = JSON.parse(text) as Independent;
  const temporary = grokNativeSessionPath(cwd, branch.sessionId);
  const original = await readNative(dir);
  if (original.summary.cockpit_merged_independent !== branch.sessionId) {
    const turn = await readNative(temporary);
    const map = new Map(Array.from({ length: nextIndex(turn) }, (_, i) => [i, branch.offset + i]));
    const chat = turn.chat.slice(branch.preambleCount)
      .map((item) => renumber(item, map, sessionId, false));
    if (chat.length) {
      const updates = turn.updates.map((item) => renumber(item, map, sessionId, true));
      const merged = { summary: { ...original.summary, num_chat_messages: original.chat.length + chat.length,
        num_messages: original.updates.length + updates.length, next_trace_turn: branch.offset + nextIndex(turn) + 1,
        cockpit_merged_independent: branch.sessionId }, chat: [...original.chat, ...chat], updates: [...original.updates, ...updates] };
      await transaction(dir, nativeFiles(dir, merged));
    }
  }
  await rm(marker, { force: true });
  await rm(temporary, { recursive: true, force: true });
}

/** A separate native branch keeps prior context off the wire, even during a crash. */
export const prepareGrokContext = (cwd: string, sessionId: string, noHistory: boolean) => io(grokNativeSessionPath(cwd, sessionId), async () => {
  const dir = grokNativeSessionPath(cwd, sessionId);
  await recoverEdit(dir);
  await mergeIndependent(cwd, sessionId);
  if (!noHistory) return sessionId;
  const data = await readNative(dir);
  const newId = randomUUID();
  const chat = data.chat.filter((item) => item.type === 'system' || (item.type === 'user' && indexOf(item) === undefined &&
    String(JSON.stringify(item.content)).includes('<user_info>')));
  const empty = { summary: { ...data.summary, num_messages: 0, num_chat_messages: chat.length, next_trace_turn: 1,
    last_turn_summary: null, last_turn_summary_prompt_id: null, last_recap: null }, chat, updates: [] };
  await writeClone(cwd, sessionId, newId, empty);
  await rewriteTranscript(join(dir, 'cockpit-independent.json'), JSON.stringify({ sessionId: newId, offset: nextIndex(data), preambleCount: chat.length } satisfies Independent));
  return newId;
});
export const finishGrokContext = (cwd: string, sessionId: string) => io(grokNativeSessionPath(cwd, sessionId), () => mergeIndependent(cwd, sessionId));
