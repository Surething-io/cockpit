import { spawn } from 'child_process';
import { sanitizedSpawnEnv } from '@cockpit/shared-utils';
import { randomUUID } from 'crypto';
import { createInterface } from 'readline';
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { EngineSpec, ImageData, RunCtx } from './types';

// Codex CLI JSONL → event adapter. Spawns `codex exec --json` and translates its JSONL stdout
// into the same event shapes the other engines emit.

const MEDIA_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

/** Write base64 images to temp files, return file paths. Caller must clean up. */
function writeImagesToTemp(images: ImageData[]): string[] {
  const dir = join(tmpdir(), 'cockpit-codex-images');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return images.map((img, i) => {
    const ext = MEDIA_EXT[img.media_type] || '.png';
    const filePath = join(dir, `img-${Date.now()}-${i}${ext}`);
    writeFileSync(filePath, Buffer.from(img.data, 'base64'));
    return filePath;
  });
}

interface CodexItem {
  id?: string;
  call_id?: string;
  type?: string; // 'agent_message' | 'reasoning' | 'command_execution' | 'error'
  text?: string;
  message?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
}

interface CodexEvent {
  type: string;
  thread_id?: string;
  item?: CodexItem;
  message?: string;
  error?: { message?: string };
  usage?: { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number };
}

export function codexToolUseId(item: CodexItem): string {
  return item.call_id || item.id || `tool-${randomUUID()}`;
}

export const codexSpec: EngineSpec = {
  name: 'codex',
  // Require a text prompt (codex passes it as the positional arg; an images-only message would
  // otherwise spawn with an undefined prompt). Matches the original route's 400 guard.
  async preflight(params) {
    return typeof params.prompt === 'string' && params.prompt.trim()
      ? { ok: true }
      : { ok: false, status: 400, error: 'codex requires a text prompt' };
  },
  runner: {
    run(ctx: RunCtx) {
      const { cwd, sessionId } = ctx;
      const prompt = ctx.prompt as string; // orchestrator validated non-empty
      const imageFiles = ctx.images && ctx.images.length > 0 ? writeImagesToTemp(ctx.images) : [];

      return new Promise<void>((resolve, reject) => {
        let terminated = false;
        let failure: Error | null = null;
        const cleanup = () => {
          for (const f of imageFiles) {
            try { unlinkSync(f); } catch { /* ignore */ }
          }
        };

        // codex-cli >=0.141: --full-auto deprecated; --sandbox workspace-write still blocks writes
        // outside the workspace root, so use --dangerously-bypass-approvals-and-sandbox instead.
        // Cockpit already runs the agent with the user's own privileges. A non-trusted dir needs
        // --skip-git-repo-check. `resume` is exec-only (no -C). Prompt positional.
        const args: string[] = ['exec'];
        if (sessionId) {
          args.push(
            'resume',
            sessionId,
            '--json',
            '--dangerously-bypass-approvals-and-sandbox',
            '--skip-git-repo-check',
          );
          for (const imgPath of imageFiles) args.push('--image', imgPath);
          args.push(prompt);
        } else {
          args.push('--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check');
          if (cwd) args.push('-C', cwd);
          for (const imgPath of imageFiles) args.push('--image', imgPath);
          args.push(prompt);
        }

        const child = spawn('codex', args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd: cwd || undefined,
          env: sanitizedSpawnEnv(),
        });
        ctx.signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });

        const pendingToolCalls = new Map<string, string>(); // item.id → tool_use_id
        const rl = createInterface({ input: child.stdout! });

        rl.on('line', (line) => {
          if (terminated) return;
          let event: CodexEvent;
          try { event = JSON.parse(line); } catch { return; }

          switch (event.type) {
            case 'thread.started': {
              const threadId = event.thread_id || `codex-${randomUUID()}`;
              ctx.rekey(threadId); // rekey provisional runId → codex thread id (+ loading)
              ctx.emit({ type: 'system', subtype: 'init', session_id: threadId });
              break;
            }
            case 'item.completed': {
              const item = event.item;
              if (!item) break;
              if (item.type === 'agent_message' && item.text) {
                ctx.emit({ type: 'assistant', message: { content: [{ type: 'text', text: item.text }] } });
              }
              if (item.type === 'error' && (item.message || item.text)) {
                ctx.emit({ type: 'error', error: item.message || item.text });
              }
              if (item.type === 'reasoning' && item.text) {
                ctx.emit({
                  type: 'assistant',
                  message: { content: [{ type: 'text', text: `<details><summary>Reasoning</summary>\n\n${item.text}\n\n</details>` }] },
                });
              }
              if (item.type === 'command_execution') {
                const toolUseId = codexToolUseId(item);
                if (!pendingToolCalls.has(toolUseId)) {
                  ctx.emit({
                    type: 'assistant',
                    message: { content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: item.command || '' } }] },
                  });
                }
                ctx.emit({
                  type: 'user',
                  message: { content: [{ tool_use_id: toolUseId, content: item.aggregated_output || `(exit code: ${item.exit_code ?? 'unknown'})` }] },
                });
                pendingToolCalls.delete(toolUseId);
              }
              break;
            }
            case 'item.started': {
              const item = event.item;
              if (item?.type === 'command_execution' && item.command) {
                const toolUseId = codexToolUseId(item);
                pendingToolCalls.set(toolUseId, toolUseId);
                ctx.emit({
                  type: 'assistant',
                  message: { content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: item.command } }] },
                });
              }
              break;
            }
            case 'turn.completed': {
              const usage = event.usage || {};
              ctx.emit({
                type: 'result',
                subtype: 'success',
                usage: {
                  input_tokens: usage.input_tokens || 0,
                  output_tokens: usage.output_tokens || 0,
                  cache_creation_input_tokens: 0,
                  cache_read_input_tokens: usage.cached_input_tokens || 0,
                },
                total_cost_usd: 0,
              });
              break;
            }
            case 'turn.failed': {
              // Fail the run so it terminates 'error' (scheduled tasks must not misread as success).
              terminated = true;
              failure = new Error(event.error?.message || 'Codex turn failed');
              break;
            }
            case 'error': {
              terminated = true;
              failure = new Error(event.message || 'Codex error');
              break;
            }
            // 'turn.started' — no action
          }
        });

        let stderrBuf = '';
        child.stderr?.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString(); });
        child.on('error', (err) => { cleanup(); reject(err); });
        child.on('close', (code) => {
          cleanup();
          if (code !== 0 && stderrBuf.trim()) console.error(`[Codex] exited with code ${code}: ${stderrBuf.trim()}`);
          if (failure) reject(failure);
          else resolve();
        });
      });
    },
    // No resolveTitle → teardown 'unread' with undefined title (matches original).
  },
};
