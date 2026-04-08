import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import type { ModelMessage } from '@ai-sdk/provider-utils';

const SESSIONS_ROOT = join(homedir(), '.cockpit', 'ollama-sessions');

function getCwdHash(cwd: string): string {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 16);
}

function getSessionDir(cwd: string): string {
  return join(SESSIONS_ROOT, getCwdHash(cwd));
}

function getSessionPath(cwd: string, sessionId: string): string {
  return join(getSessionDir(cwd), `${sessionId}.jsonl`);
}

export function readSessionMessages(cwd: string, sessionId: string): ModelMessage[] {
  const path = getSessionPath(cwd, sessionId);
  if (!existsSync(path)) return [];

  const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
  const messages: ModelMessage[] = [];
  for (const line of lines) {
    try {
      messages.push(JSON.parse(line) as ModelMessage);
    } catch {
      // skip corrupted lines
    }
  }
  return messages;
}

export function appendSessionMessage(cwd: string, sessionId: string, message: ModelMessage): void {
  const dir = getSessionDir(cwd);
  mkdirSync(dir, { recursive: true });
  const path = getSessionPath(cwd, sessionId);
  appendFileSync(path, JSON.stringify(message) + '\n', 'utf-8');
}

export function writeSessionMessages(cwd: string, sessionId: string, messages: ModelMessage[]): void {
  const dir = getSessionDir(cwd);
  mkdirSync(dir, { recursive: true });
  const path = getSessionPath(cwd, sessionId);
  const content = messages.map((m) => JSON.stringify(m)).join('\n') + '\n';
  writeFileSync(path, content, 'utf-8');
}
