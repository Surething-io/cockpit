import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Effect } from 'effect';
import { FSError } from '@cockpit/effect-core';
import { GrokEventAdapter, grokTranscriptEvent } from '../server/engines/grokAcp/events';
import { object, type AcpObject } from '../server/engines/grokAcp/client';
import { parseTranscriptFile } from '../server/api/session/transcriptParsers';
import { grokNativeSessionPath } from './grokNativeSessionLive';

const validId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id);

async function optionalText(path: string): Promise<string | undefined> {
  return readFile(path, 'utf8').catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === 'ENOENT') return undefined;
    throw cause;
  });
}

// A live writer may have appended only part of the last JSONL record.
function records(text: string): AcpObject[] {
  const lines = text.split('\n');
  return lines.flatMap((line, index) => {
    if (!line.trim()) return [];
    try { return [object(JSON.parse(line))]; }
    catch (cause) { if (index === lines.length - 1) return []; throw cause; }
  });
}

function linkedChild(updates: AcpObject[], toolUseId: string): string | undefined {
  for (const entry of updates) {
    const update = object(object(entry.params).update);
    if (update.toolCallId !== toolUseId) continue;
    const output = object(update.rawOutput);
    const id = output.child_session_id ?? output.subagent_id
      ?? (typeof output.text === 'string' ? output.text.match(/^subagent_id:\s*([A-Za-z0-9_-]+)\s*$/m)?.[1] : undefined);
    if (validId(id)) return id;
  }
}

/** Native children have their own ACP replay logs, including history lost to compaction. */
export const readGrokSubagentTranscript = (cwd: string, sessionId: string, toolUseId: string, ifFingerprint?: string) =>
  Effect.tryPromise({
    try: async () => {
      // Nested drill-ins keep the root session coordinates. Walk only its registered children.
      const pending = [sessionId];
      const visited = new Set<string>();
      while (pending.length) {
        const parentId = pending.shift()!;
        if (visited.has(parentId)) continue;
        visited.add(parentId);
        const parentDir = grokNativeSessionPath(cwd, parentId);
        const updates = records(await optionalText(join(parentDir, 'updates.jsonl')) ?? '');
        const childId = linkedChild(updates, toolUseId);
        if (!childId) {
          const children = await readdir(join(parentDir, 'subagents')).catch((cause: NodeJS.ErrnoException) => {
            if (cause.code === 'ENOENT') return [];
            throw cause;
          });
          pending.push(...children.filter(validId));
          continue;
        }
        const metaText = await optionalText(join(parentDir, 'subagents', childId, 'meta.json'));
        if (!metaText) return null;
        const meta = object(JSON.parse(metaText));
        if (meta.parent_session_id !== parentId) return null;
        const childDir = grokNativeSessionPath(cwd, childId);
        const replay = await optionalText(join(childDir, 'updates.jsonl')) ?? '';
        const outputText = await optionalText(join(parentDir, 'subagents', childId, 'output.json')) ?? '';
        const fingerprint = createHash('sha256').update(JSON.stringify([childId, metaText, replay, outputText])).digest('hex');
        if (fingerprint === ifFingerprint) return { notModified: true as const, fingerprint };

        let sequence = 0;
        const adapter = new GrokEventAdapter(() => `${childId}-${sequence++}`);
        const transcript: AcpObject[] = [];
        const append = (record: AcpObject, timestamp?: string) => transcript.push({
          ...record, uuid: `${childId}-${sequence++}`, timestamp,
        });
        let hasPrompt = false;
        for (const entry of records(replay)) {
          const params = object(entry.params);
          if (params.sessionId !== childId) continue;
          const update = object(params.update);
          const timestamp = typeof entry.timestamp === 'number' ? new Date(entry.timestamp * 1000).toISOString() : undefined;
          if (update.sessionUpdate === 'user_message_chunk') {
            append({ type: 'user', message: { role: 'user', content: [update.content] } }, timestamp);
            hasPrompt = true;
            continue;
          }
          for (const event of adapter.update(update)) {
            const record = grokTranscriptEvent(event);
            if (record) append(record, timestamp);
          }
        }
        if (!hasPrompt && typeof meta.prompt === 'string') {
          transcript.unshift({ type: 'user', uuid: `${childId}-prompt`, timestamp: meta.started_at,
            message: { role: 'user', content: meta.prompt } });
        }
        // A retained result remains useful even if the child's replay log was removed.
        if (!replay.trim() && outputText) {
          const output = object(JSON.parse(outputText));
          if (typeof output.output === 'string') append({ type: 'assistant', message: {
            role: 'assistant', content: [{ type: 'text', text: output.output }],
          } }, typeof meta.completed_at === 'string' ? meta.completed_at : undefined);
        }
        const parsed = await parseTranscriptFile({ text: transcript.map((entry) => JSON.stringify(entry)).join('\n') });
        return { messages: parsed.messages, fingerprint,
          subagent: { agentType: meta.subagent_type, description: meta.description } };
      }
      return null;
    },
    catch: (cause) => new FSError({ path: grokNativeSessionPath(cwd, sessionId), op: 'read', cause }),
  }).pipe(Effect.withSpan('agent.grok.subagentTranscript'));
