import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { NextRequest } from 'next/server';
import { updateGlobalState } from '@/lib/global-state';
import { resolveCommandPrompt } from '@/lib/chat/slashCommands';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Ollama chat route — spawns `claude` CLI directly with env vars
 * matching what `ollama launch claude --model <model>` sets.
 *
 * Uses CLI spawn instead of SDK query() because the SDK's bundled cli.js
 * (v0.2.47) doesn't support ANTHROPIC_DEFAULT_*_MODEL env vars that are
 * needed for Ollama compatibility. The system `claude` CLI does.
 */

export async function POST(request: NextRequest) {
  try {
    const { prompt: rawPrompt, sessionId, cwd, model, language } = await request.json();

    const prompt = typeof rawPrompt === 'string' ? resolveCommandPrompt(rawPrompt, language) : rawPrompt;

    if (!model) {
      return new Response(JSON.stringify({ error: 'Missing model. Select an Ollama model first.' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!prompt || typeof prompt !== 'string') {
      return new Response(JSON.stringify({ error: 'Missing prompt' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }

    const encoder = new TextEncoder();
    let isClosed = false;
    let actualSessionId = sessionId || '';
    const userMessage = prompt.slice(0, 50);
    let childProcess: ReturnType<typeof spawn> | null = null;

    const stream = new ReadableStream({
      async start(controller) {
        const safeEnqueue = (data: string) => {
          if (!isClosed) {
            try { controller.enqueue(encoder.encode(data)); } catch { isClosed = true; }
          }
        };
        const safeClose = () => {
          if (!isClosed) {
            isClosed = true;
            try { controller.close(); } catch { /* ignore */ }
          }
        };

        try {
          // Build claude CLI args — print mode with streaming JSON
          const args: string[] = [
            '-p',
            '--output-format', 'stream-json',
            '--verbose',
            '--model', model,
            '--permission-mode', 'bypassPermissions',
          ];

          // Resume existing session
          if (sessionId) {
            args.push('--resume', sessionId);
          }

          // Env vars matching `ollama launch claude --model <model>`
          const env: Record<string, string> = {
            ...process.env as Record<string, string>,
            ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434',
            ANTHROPIC_API_KEY: 'sk-ant-ollama',
            ANTHROPIC_AUTH_TOKEN: 'ollama',
            ANTHROPIC_DEFAULT_SONNET_MODEL: model,
            ANTHROPIC_DEFAULT_OPUS_MODEL: model,
            ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
            CLAUDE_CODE_SUBAGENT_MODEL: model,
            CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
            CLAUDECODE: '1',
          };

          childProcess = spawn('claude', args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: cwd || undefined,
            env: env as NodeJS.ProcessEnv,
          });

          // Send prompt via stdin, then close
          childProcess!.stdin?.write(prompt);
          childProcess!.stdin?.end();

          let emittedInit = false;

          const rl = createInterface({ input: childProcess.stdout! });

          rl.on('line', (line) => {
            if (isClosed) return;

            let event: Record<string, unknown>;
            try {
              event = JSON.parse(line);
            } catch {
              return;
            }

            const eventType = event.type as string;

            // Capture session_id from init
            if (eventType === 'system' && event.subtype === 'init' && event.session_id) {
              actualSessionId = event.session_id as string;
              emittedInit = true;
              if (cwd) {
                updateGlobalState(cwd, actualSessionId, 'loading', undefined, userMessage).catch(() => {});
              }
            }

            // Synthesize init if needed
            if (!emittedInit && !actualSessionId && (eventType === 'assistant' || eventType === 'stream_event')) {
              actualSessionId = `ollama-${Date.now()}`;
              emittedInit = true;
              safeEnqueue(`data: ${JSON.stringify({
                type: 'system', subtype: 'init', session_id: actualSessionId,
              })}\n\n`);
              if (cwd) {
                updateGlobalState(cwd, actualSessionId, 'loading', undefined, userMessage).catch(() => {});
              }
            }

            // Forward all events as-is
            safeEnqueue(`data: ${JSON.stringify(event)}\n\n`);
          });

          // Handle process exit
          childProcess.on('close', async (code) => {
            if (cwd && actualSessionId) {
              await updateGlobalState(cwd, actualSessionId, 'unread', undefined).catch(() => {});
            }

            if (code !== 0 && stderrBuf.trim()) {
              // Emit error to frontend
              safeEnqueue(`data: ${JSON.stringify({
                type: 'error', error: stderrBuf.trim().slice(0, 500),
              })}\n\n`);
            }

            safeEnqueue('data: [DONE]\n\n');
            safeClose();
          });

          // Capture stderr
          let stderrBuf = '';
          childProcess.stderr?.on('data', (chunk: Buffer) => {
            stderrBuf += chunk.toString();
          });

          childProcess.on('error', (err) => {
            console.error('[Ollama] spawn error:', err.message);
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
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
}
