import { spawn } from 'child_process';
import { sanitizedSpawnEnv } from '@cockpit/shared-utils';
import { randomUUID } from 'crypto';
import { createInterface } from 'readline';
import { readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { EngineSpec, RunCtx } from './types';

// Kimi CLI stream-json → event adapter. Spawns `kimi --print --output-format stream-json` and
// translates JSONL stdout into the same event shapes as the other engines.

interface KimiContent { type?: string; text?: string; think?: string }
interface KimiToolCall { type?: string; id?: string; function?: { name?: string; arguments?: string } }
interface KimiMessage { role?: string; content?: KimiContent[]; tool_calls?: KimiToolCall[]; tool_call_id?: string }

function snapshotKimiSessionIds(): Set<string> {
  const ids = new Set<string>();
  const sessionsDir = join(homedir(), '.kimi', 'sessions');
  try {
    for (const hash of readdirSync(sessionsDir)) {
      try {
        for (const sid of readdirSync(join(sessionsDir, hash))) ids.add(sid);
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return ids;
}

function findNewKimiSessionId(before: Set<string>): string | null {
  const sessionsDir = join(homedir(), '.kimi', 'sessions');
  try {
    for (const hash of readdirSync(sessionsDir)) {
      try {
        for (const sid of readdirSync(join(sessionsDir, hash))) if (!before.has(sid)) return sid;
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return null;
}

export const kimiSpec: EngineSpec = {
  name: 'kimi',
  // Kimi CLI has no image support — require a text prompt (else an images-only message reaches
  // spawn with an undefined positional prompt).
  async preflight(params) {
    return typeof params.prompt === 'string' && params.prompt.trim()
      ? { ok: true }
      : { ok: false, status: 400, error: 'kimi requires a text prompt' };
  },
  runner: {
    run(ctx: RunCtx) {
      const { cwd, sessionId } = ctx;
      const prompt = ctx.prompt as string; // orchestrator validated non-empty

      return new Promise<void>((resolve, reject) => {
        const args = ['--print', '--output-format', 'stream-json'];
        if (sessionId) args.push('-S', sessionId);
        if (cwd) args.push('-w', cwd);
        args.push('-p', prompt);

        // Snapshot existing sessions before spawn so we can detect the new one on close.
        const sessionsBefore = sessionId ? new Set<string>() : snapshotKimiSessionIds();

        const child = spawn('kimi', args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd: cwd || undefined,
          env: sanitizedSpawnEnv(),
        });
        ctx.signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });

        // Resume: we already know the session id → emit init now.
        if (sessionId) {
          ctx.emit({ type: 'system', subtype: 'init', session_id: sessionId });
          ctx.rekey(sessionId);
        }

        const rl = createInterface({ input: child.stdout! });
        rl.on('line', (line) => {
          let msg: KimiMessage;
          try { msg = JSON.parse(line); } catch { return; }

          if (msg.role === 'assistant') {
            for (const block of msg.content ?? []) {
              if (block.type === 'text' && block.text) {
                ctx.emit({ type: 'assistant', message: { content: [{ type: 'text', text: block.text }] } });
              }
              if (block.type === 'think' && block.think) {
                ctx.emit({
                  type: 'assistant',
                  message: { content: [{ type: 'text', text: `<details><summary>Thinking</summary>\n\n${block.think}\n\n</details>` }] },
                });
              }
            }
            for (const tc of msg.tool_calls ?? []) {
              if (tc.function?.name) {
                const toolUseId = tc.id || `tool-${randomUUID()}`;
                let input: Record<string, unknown> = {};
                try { input = JSON.parse(tc.function.arguments || '{}'); } catch { /* ignore */ }
                const name = tc.function.name === 'Shell' ? 'Bash' : tc.function.name; // map to familiar name
                ctx.emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: toolUseId, name, input }] } });
              }
            }
          }

          if (msg.role === 'tool') {
            const toolUseId = msg.tool_call_id;
            if (toolUseId && msg.content) {
              const resultText = msg.content.filter((c) => c.type === 'text' && c.text).map((c) => c.text!).join('\n');
              ctx.emit({ type: 'user', message: { content: [{ tool_use_id: toolUseId, content: resultText }] } });
            }
          }
        });

        child.on('close', () => {
          // New session: detect its id from the filesystem, then rekey + emit init.
          if (!sessionId) {
            const detected = findNewKimiSessionId(sessionsBefore);
            if (detected) {
              ctx.rekey(detected);
              ctx.emit({ type: 'system', subtype: 'init', session_id: detected });
            }
          }
          ctx.emit({
            type: 'result',
            subtype: 'success',
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            total_cost_usd: 0,
          });
          resolve();
        });

        child.stderr?.on('data', () => { /* discard */ });
        child.on('error', (err) => reject(err));
      });
    },
    // No resolveTitle → teardown 'unread' with undefined title (matches original).
  },
};
