import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { NextRequest } from 'next/server';
import { updateGlobalState } from '@/lib/global-state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ============================================
// Kimi CLI stream-json → SSE adapter
// ============================================
// Spawns `kimi --print --output-format stream-json` and translates JSONL stdout
// into the same SSE event shapes as Claude/Codex routes.
//
// Kimi stream-json format:
//   {"role":"assistant","content":[{"type":"think","think":"..."},{"type":"text","text":"..."}],"tool_calls":[...]}
//   {"role":"tool","content":[{"type":"text","text":"..."}],"tool_call_id":"..."}

interface KimiContent {
  type?: string;  // 'text' | 'think'
  text?: string;
  think?: string;
}

interface KimiToolCall {
  type?: string;
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface KimiMessage {
  role?: string;  // 'assistant' | 'tool'
  content?: KimiContent[];
  tool_calls?: KimiToolCall[];
  tool_call_id?: string;
}

/**
 * Snapshot all existing Kimi session IDs across all cwd hashes.
 */
function snapshotKimiSessionIds(): Set<string> {
  const ids = new Set<string>();
  const sessionsDir = join(homedir(), '.kimi', 'sessions');
  try {
    for (const hash of readdirSync(sessionsDir)) {
      const hashDir = join(sessionsDir, hash);
      try {
        for (const sid of readdirSync(hashDir)) {
          ids.add(sid);
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return ids;
}

/**
 * Find a newly created Kimi session ID by comparing before/after snapshots.
 */
function findNewKimiSessionId(before: Set<string>): string | null {
  const sessionsDir = join(homedir(), '.kimi', 'sessions');
  try {
    for (const hash of readdirSync(sessionsDir)) {
      const hashDir = join(sessionsDir, hash);
      try {
        for (const sid of readdirSync(hashDir)) {
          if (!before.has(sid)) return sid;
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return null;
}

export async function POST(request: NextRequest) {
  try {
    const { prompt, sessionId, cwd } = await request.json();

    if (!prompt || typeof prompt !== 'string') {
      return new Response(JSON.stringify({ error: 'Missing prompt' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const encoder = new TextEncoder();
    let isClosed = false;
    let actualSessionId = sessionId || '';
    const userMessage = typeof prompt === 'string' ? prompt.slice(0, 50) : '';
    let childProcess: ReturnType<typeof spawn> | null = null;

    const stream = new ReadableStream({
      async start(controller) {
        const safeEnqueue = (data: string) => {
          if (!isClosed) {
            try {
              controller.enqueue(encoder.encode(data));
            } catch {
              isClosed = true;
            }
          }
        };

        const safeClose = () => {
          if (!isClosed) {
            isClosed = true;
            try {
              controller.close();
            } catch {
              // ignore
            }
          }
        };

        try {
          // Build kimi command args
          const args: string[] = [
            '--print',
            '--output-format', 'stream-json',
          ];

          if (sessionId) {
            args.push('-S', sessionId);
          }

          if (cwd) {
            args.push('-w', cwd);
          }

          args.push('-p', prompt);

          // Snapshot existing sessions before spawn so we can detect the new one
          const sessionsBefore = sessionId ? new Set<string>() : snapshotKimiSessionIds();

          childProcess = spawn('kimi', args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            cwd: cwd || undefined,
            env: { ...process.env },
          });

          // Emit system init with session ID if we already have one (resume)
          if (actualSessionId) {
            safeEnqueue(`data: ${JSON.stringify({
              type: 'system',
              subtype: 'init',
              session_id: actualSessionId,
            })}\n\n`);
            if (cwd) {
              updateGlobalState(cwd, actualSessionId, 'loading', undefined, userMessage).catch(() => {});
            }
          }

          const rl = createInterface({ input: childProcess.stdout! });

          rl.on('line', (line) => {
            if (isClosed) return;

            let msg: KimiMessage;
            try {
              msg = JSON.parse(line);
            } catch {
              return; // skip non-JSON lines
            }

            if (msg.role === 'assistant') {
              // Extract text and thinking content
              if (msg.content) {
                for (const block of msg.content) {
                  if (block.type === 'text' && block.text) {
                    safeEnqueue(`data: ${JSON.stringify({
                      type: 'assistant',
                      message: {
                        content: [{ type: 'text', text: block.text }],
                      },
                    })}\n\n`);
                  }
                  if (block.type === 'think' && block.think) {
                    safeEnqueue(`data: ${JSON.stringify({
                      type: 'assistant',
                      message: {
                        content: [{ type: 'text', text: `<details><summary>Thinking</summary>\n\n${block.think}\n\n</details>` }],
                      },
                    })}\n\n`);
                  }
                }
              }

              // Extract tool calls
              if (msg.tool_calls) {
                for (const tc of msg.tool_calls) {
                  if (tc.function?.name) {
                    const toolUseId = tc.id || `tool-${Date.now()}`;
                    let input: Record<string, unknown> = {};
                    try { input = JSON.parse(tc.function.arguments || '{}'); } catch { /* */ }

                    // Map Kimi tool names to familiar names
                    const name = tc.function.name === 'Shell' ? 'Bash' : tc.function.name;

                    safeEnqueue(`data: ${JSON.stringify({
                      type: 'assistant',
                      message: {
                        content: [{
                          type: 'tool_use',
                          id: toolUseId,
                          name,
                          input,
                        }],
                      },
                    })}\n\n`);
                  }
                }
              }
            }

            if (msg.role === 'tool') {
              // Tool result
              const toolUseId = msg.tool_call_id;
              if (toolUseId && msg.content) {
                const resultText = msg.content
                  .filter(c => c.type === 'text' && c.text)
                  .map(c => c.text!)
                  .join('\n');

                safeEnqueue(`data: ${JSON.stringify({
                  type: 'user',
                  message: {
                    content: [{
                      tool_use_id: toolUseId,
                      content: resultText,
                    }],
                  },
                })}\n\n`);
              }
            }
          });

          // Handle process exit
          childProcess.on('close', async () => {
            // Detect new session ID from filesystem (before emitting result)
            if (!actualSessionId) {
              const detected = findNewKimiSessionId(sessionsBefore);
              if (detected) {
                actualSessionId = detected;
                safeEnqueue(`data: ${JSON.stringify({
                  type: 'system',
                  subtype: 'init',
                  session_id: actualSessionId,
                })}\n\n`);
                if (cwd) {
                  updateGlobalState(cwd, actualSessionId, 'loading', undefined, userMessage).catch(() => {});
                }
              }
            }

            // Emit result
            safeEnqueue(`data: ${JSON.stringify({
              type: 'result',
              subtype: 'success',
              usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
              total_cost_usd: 0,
            })}\n\n`);

            // Update global state: done
            if (cwd && actualSessionId) {
              await updateGlobalState(cwd, actualSessionId, 'unread', undefined).catch(() => {});
            }

            safeEnqueue('data: [DONE]\n\n');
            safeClose();
          });

          // Capture stderr
          childProcess.stderr?.on('data', () => { /* discard */ });

          childProcess.on('error', (err) => {
            console.error('[Kimi] spawn error:', err.message);
            safeEnqueue(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
            safeClose();
          });
        } catch (error) {
          safeEnqueue(`data: ${JSON.stringify({ type: 'error', error: String(error) })}\n\n`);
          safeClose();
        }
      },
      cancel() {
        isClosed = true;
        if (childProcess) {
          childProcess.kill('SIGTERM');
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
