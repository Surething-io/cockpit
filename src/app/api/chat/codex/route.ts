import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { NextRequest } from 'next/server';
import { updateGlobalState } from '@/lib/global-state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ============================================
// Codex CLI JSONL → SSE adapter
// ============================================
// Spawns `codex exec --json --full-auto` and translates its JSONL stdout
// into the same SSE event shapes that the Claude chat route emits,
// so the frontend useChatStream.ts works unchanged.

interface ImageData {
  type: 'base64';
  media_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  data: string;
}

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
  type?: string;       // 'agent_message' | 'reasoning' | 'command_execution'
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;     // 'in_progress' | 'completed'
}

interface CodexEvent {
  type: string;        // 'thread.started' | 'turn.started' | 'item.started' | 'item.completed' | 'turn.completed'
  thread_id?: string;
  item?: CodexItem;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cached_input_tokens?: number;
  };
}

export async function POST(request: NextRequest) {
  try {
    const { prompt, sessionId, images, cwd } = await request.json();

    if (!prompt || typeof prompt !== 'string') {
      return new Response(JSON.stringify({ error: 'Missing prompt' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Write base64 images to temp files for codex --image flag
    const imageFiles: string[] = [];
    if (images && Array.isArray(images) && images.length > 0) {
      imageFiles.push(...writeImagesToTemp(images as ImageData[]));
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
          // Build codex exec command args
          const args: string[] = ['exec'];

          if (sessionId) {
            // Resume existing session (resume doesn't accept -C)
            args.push('resume', sessionId, '--json', '--full-auto');
            for (const imgPath of imageFiles) {
              args.push('--image', imgPath);
            }
            args.push(prompt);
          } else {
            // New session
            args.push('--json', '--full-auto');
            if (cwd) {
              args.push('-C', cwd);
            }
            for (const imgPath of imageFiles) {
              args.push('--image', imgPath);
            }
            args.push(prompt);
          }

          childProcess = spawn('codex', args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            cwd: cwd || undefined,
            env: { ...process.env },
          });

          // Track pending tool calls for matching started→completed
          const pendingToolCalls = new Map<string, string>(); // item.id → tool_use_id

          const rl = createInterface({ input: childProcess.stdout! });

          rl.on('line', (line) => {
            if (isClosed) return;

            let event: CodexEvent;
            try {
              event = JSON.parse(line);
            } catch {
              return; // skip non-JSON lines
            }

            switch (event.type) {
              case 'thread.started': {
                actualSessionId = event.thread_id || `codex-${Date.now()}`;
                // Emit system init (same shape as Claude SDK)
                safeEnqueue(`data: ${JSON.stringify({
                  type: 'system',
                  subtype: 'init',
                  session_id: actualSessionId,
                })}\n\n`);

                // Update global state
                if (cwd) {
                  updateGlobalState(cwd, actualSessionId, 'loading', undefined, userMessage).catch(() => {});
                }
                break;
              }

              case 'item.completed': {
                const item = event.item;
                if (!item) break;

                if (item.type === 'agent_message' && item.text) {
                  // Text response → assistant message
                  safeEnqueue(`data: ${JSON.stringify({
                    type: 'assistant',
                    message: {
                      content: [{ type: 'text', text: item.text }],
                    },
                  })}\n\n`);
                }

                if (item.type === 'reasoning' && item.text) {
                  // Thinking/reasoning → assistant message with thinking block
                  safeEnqueue(`data: ${JSON.stringify({
                    type: 'assistant',
                    message: {
                      content: [{ type: 'text', text: `<details><summary>Reasoning</summary>\n\n${item.text}\n\n</details>` }],
                    },
                  })}\n\n`);
                }

                if (item.type === 'command_execution') {
                  const toolUseId = item.id || `tool-${Date.now()}`;

                  // If we haven't seen item.started for this, emit the tool_use first
                  if (!pendingToolCalls.has(toolUseId)) {
                    safeEnqueue(`data: ${JSON.stringify({
                      type: 'assistant',
                      message: {
                        content: [{
                          type: 'tool_use',
                          id: toolUseId,
                          name: 'Bash',
                          input: { command: item.command || '' },
                        }],
                      },
                    })}\n\n`);
                  }

                  // Emit tool result
                  safeEnqueue(`data: ${JSON.stringify({
                    type: 'user',
                    message: {
                      content: [{
                        tool_use_id: toolUseId,
                        content: item.aggregated_output || `(exit code: ${item.exit_code ?? 'unknown'})`,
                      }],
                    },
                  })}\n\n`);

                  pendingToolCalls.delete(toolUseId);
                }
                break;
              }

              case 'item.started': {
                const item = event.item;
                if (!item) break;

                if (item.type === 'command_execution' && item.command) {
                  const toolUseId = item.id || `tool-${Date.now()}`;
                  pendingToolCalls.set(toolUseId, toolUseId);

                  // Emit tool_use (loading state)
                  safeEnqueue(`data: ${JSON.stringify({
                    type: 'assistant',
                    message: {
                      content: [{
                        type: 'tool_use',
                        id: toolUseId,
                        name: 'Bash',
                        input: { command: item.command },
                      }],
                    },
                  })}\n\n`);
                }
                break;
              }

              case 'turn.completed': {
                // Emit result message (completion signal)
                const usage = event.usage || {};
                safeEnqueue(`data: ${JSON.stringify({
                  type: 'result',
                  subtype: 'success',
                  usage: {
                    input_tokens: usage.input_tokens || 0,
                    output_tokens: usage.output_tokens || 0,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: usage.cached_input_tokens || 0,
                  },
                  total_cost_usd: 0,
                })}\n\n`);
                break;
              }

              // 'turn.started' — no action needed
            }
          });

          // Clean up temp image files
          const cleanupImages = () => {
            for (const f of imageFiles) {
              try { unlinkSync(f); } catch { /* ignore */ }
            }
          };

          // Handle process exit
          childProcess.on('close', async () => {
            cleanupImages();

            // Update global state: done
            if (cwd && actualSessionId) {
              await updateGlobalState(cwd, actualSessionId, 'unread', undefined).catch(() => {});
            }

            safeEnqueue('data: [DONE]\n\n');
            safeClose();
          });

          // Capture stderr for errors
          let stderrBuf = '';
          childProcess.stderr?.on('data', (chunk: Buffer) => {
            stderrBuf += chunk.toString();
          });

          childProcess.on('error', (err) => {
            console.error('[Codex] spawn error:', err.message);
            safeEnqueue(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
            safeClose();
          });

          childProcess.on('close', (code) => {
            if (code !== 0 && stderrBuf.trim()) {
              console.error(`[Codex] exited with code ${code}: ${stderrBuf.trim()}`);
            }
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
