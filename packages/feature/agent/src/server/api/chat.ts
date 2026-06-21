import { query } from '@anthropic-ai/claude-agent-sdk';
import { Effect } from 'effect';
import { updateGlobalState, getSessionTitle } from '../state/globalState';
import { resolveCommandPrompt } from '../lib/slashCommands';
import { CLAUDE2_DIR } from '@cockpit/shared-utils';
import { handler, parseJsonRaw } from '@cockpit/effect-runtime/server';
import { ValidationError } from '@cockpit/effect-core';
import { runClaudeTurn } from '../pty/claudePtyDriver';
import { mapLineToEvents, initEvent, resultEvent } from '../pty/ptySseMapper';
import { randomUUID } from 'crypto';

interface ImageData {
  type: 'base64';
  media_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  data: string;
}

type ContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: {
        type: 'base64';
        media_type: ImageData['media_type'];
        data: string;
      };
    };

export const POST = handler((request) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(request)) as {
      prompt?: unknown;
      sessionId?: string;
      images?: ImageData[];
      cwd?: string;
      language?: string;
      engine?: string;
      mode?: string;
      permissionMode?: string;
      ptyCols?: number;
      ptyRows?: number;
    };
    const {
      prompt: rawPrompt,
      sessionId,
      images,
      cwd,
      language,
      engine,
      mode,
      permissionMode,
      ptyCols,
      ptyRows,
    } = body;

    // Resolve built-in slash commands (/qa, /fx, etc.) based on language
    const prompt =
      typeof rawPrompt === 'string'
        ? resolveCommandPrompt(rawPrompt, language, request)
        : rawPrompt;

    // Allow sending images only (no text)
    const hasContent =
      (prompt && typeof prompt === 'string') ||
      (images && images.length > 0);
    if (!hasContent) {
      return yield* Effect.fail(
        new ValidationError({
          field: 'prompt|images',
          reason: 'Missing prompt or images',
        })
      );
    }

    // Build message content
    const content: ContentBlock[] = [];

    // Add images first (so Claude sees images before text)
    if (images && Array.isArray(images)) {
      for (const img of images as ImageData[]) {
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: img.media_type,
            data: img.data,
          },
        });
      }
    }

    // Add text
    if (prompt && typeof prompt === 'string') {
      content.push({ type: 'text', text: prompt });
    }

    // Create streaming response
    const encoder = new TextEncoder();
    let isClosed = false;

    // Create AbortController for cancelling query
    const queryAbortController = new AbortController();

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

        // Track the actual sessionId (may be obtained from the stream)
        let actualSessionId = sessionId;

        // Immediately mark as loading, also pass user message (avoid reading stale messages before transcript is written)
        const userMessage = typeof prompt === 'string' ? prompt : undefined;
        if (cwd && sessionId) {
          updateGlobalState(cwd, sessionId, 'loading', undefined, userMessage).catch(() => {});
        }

        // ---- PTY mode (subscription billing): driven by the interactive claude CLI, via jsonl → SSE mapping ----
        // Applies only to claude/claude2; an additive branch — when mode!=='pty' the SDK path is completely unchanged.
        if (mode === 'pty' && (!engine || engine === 'claude' || engine === 'claude2')) {
          const isResume = !!sessionId;
          const sid = sessionId || randomUUID();
          const promptText = typeof prompt === 'string' ? prompt : '';
          try {
            safeEnqueue(`data: ${JSON.stringify(initEvent(sid))}\n\n`);
            if (cwd) updateGlobalState(cwd, sid, 'loading', undefined, userMessage).catch(() => {});
            const turn = await runClaudeTurn({
              cwd: cwd || process.cwd(),
              prompt: promptText,
              sessionId: sid,
              resume: isResume,
              ...(images && images.length > 0 && { images: images.map((img) => ({ media_type: img.media_type, data: img.data })) }),
              ...(ptyCols && { cols: ptyCols }),
              ...(ptyRows && { rows: ptyRows }),
              signal: queryAbortController.signal,
              onJsonlLine: (line) => {
                for (const ev of mapLineToEvents(line, sid)) {
                  safeEnqueue(`data: ${JSON.stringify(ev)}\n\n`);
                }
              },
              // floating-window dual-view: raw PTY output is forwarded to the frontend xterm over the same SSE channel
              onPtyData: (data) => {
                safeEnqueue(`data: ${JSON.stringify({ type: 'pty_output', data })}\n\n`);
              },
              // Startup stuck (REPL not ready for a while, likely waiting on a dialog):
              // prompt the user to handle it manually in the terminal. i18n resolved on the client.
              onStuck: () => {
                safeEnqueue(`data: ${JSON.stringify({ type: 'pty_notice', level: 'warning', messageKey: 'chat.ptyStuck' })}\n\n`);
              },
              // AskUserQuestion selector auto-cancelled (ESC) and the turn ended early; the question
              // itself reaches the chat via the jsonl mapping, so a transient notice is enough.
              onQuestionEsc: () => {
                safeEnqueue(`data: ${JSON.stringify({ type: 'pty_notice', level: 'warning', messageKey: 'chat.ptyQuestionEsc' })}\n\n`);
              },
            });
            // claude-code itself crashed (upstream bug, e.g. rendering edit history on resume).
            // Terminal notice → shown as the assistant message content.
            if (turn.crashed) {
              safeEnqueue(`data: ${JSON.stringify({ type: 'pty_notice', level: 'error', terminal: true, messageKey: 'chat.ptyCrash', params: { error: turn.crashError } })}\n\n`);
            }
            // Stuck past the grace window without manual handling → terminated (terminal notice).
            if (turn.timedOut) {
              safeEnqueue(`data: ${JSON.stringify({ type: 'pty_notice', level: 'warning', terminal: true, messageKey: 'chat.ptyTimedOut' })}\n\n`);
            }
            safeEnqueue(`data: ${JSON.stringify(resultEvent(sid))}\n\n`);
            if (cwd) {
              const title = await getSessionTitle(cwd, sid);
              await updateGlobalState(cwd, sid, 'unread', title);
            }
            safeEnqueue('data: [DONE]\n\n');
          } catch (err) {
            if (!queryAbortController.signal.aborted) {
              safeEnqueue(`data: ${JSON.stringify({ type: 'error', error: String(err) })}\n\n`);
            }
          }
          safeClose();
          return;
        }

        try {
          // Choose SDK call method based on whether images are present
          const hasImages = images && images.length > 0;

          // Common options
          const options = {
            // Resume session if sessionId is provided
            ...(sessionId && { resume: sessionId }),
            // Set working directory if cwd is provided
            ...(cwd && { cwd }),
            // Load user and project level settings
            settingSources: ['user', 'project', 'local'] as Array<'user' | 'project' | 'local'>,
            // No allowedTools whitelist: tool availability is decided by the `tools`
            // option (unset here → all built-in tools registered by default, incl. any
            // added by future SDK versions); allowedTools only pre-approves the
            // permission prompt, which bypassPermissions already skips. Caveat: on a
            // bun-compiled native build, Grep/Glob must be listed in `tools`/allowedTools
            // to stay registered — not a concern here since we run via the node CLI.
            // Permission mode: 'plan' (read-only planning, no edits) when the client
            // requests it; otherwise skip all permission checks. Plan mode has no
            // canUseTool wired up — the SDK auto-denies ExitPlanMode and ends the turn
            // cleanly ("plan-only"): the user reads the plan, then unchecks plan mode
            // and resends to implement.
            permissionMode: (permissionMode === 'plan' ? 'plan' : 'bypassPermissions') as
              | 'plan'
              | 'bypassPermissions',
            // allowDangerouslySkipPermissions only applies to bypassPermissions; it must
            // NOT be set in plan mode or it would defeat the read-only enforcement.
            ...(permissionMode !== 'plan' && { allowDangerouslySkipPermissions: true as const }),
            // Enable streaming text blocks
            includePartialMessages: true,
            // Enable 1M token context window (beta) - resolves "Prompt is too long"
            // betas: ['context-1m-2025-08-07'],
            // Pass abortController for cancelling query
            abortController: queryAbortController,
            // For claude2 engine, override config directory to ~/.claude2
            ...(engine === 'claude2' && {
              env: { ...process.env, CLAUDE_CONFIG_DIR: CLAUDE2_DIR },
            }),
          };

          let response;
          if (hasImages) {
            // Use AsyncIterable to pass messages containing images
            const messages = (async function* () {
              yield {
                type: 'user' as const,
                message: {
                  role: 'user' as const,
                  content,
                },
                parent_tool_use_id: null,
                session_id: sessionId || `session-${Date.now()}`,
              };
            })();

            response = query({
              prompt: messages,
              options,
            });
          } else {
            // Plain text message
            response = query({
              prompt: prompt as string,
              options,
            });
          }

          // SDK may perform context compaction mid-stream, ending the async iterable
          // without end_turn. Detect this and re-query to continue streaming.
          const MAX_COMPACTION_RETRIES = 1;
          let currentResponse = response;

          for (let attempt = 0; attempt <= MAX_COMPACTION_RETRIES; attempt++) {
            let receivedResult = false;

            try {
              for await (const message of currentResponse) {
                if (isClosed) break;

                // Capture sessionId (from system init event) and update global state
                const msg = message as { type?: string; subtype?: string; session_id?: string };
                if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
                  actualSessionId = msg.session_id;
                  if (cwd) {
                    updateGlobalState(cwd, actualSessionId, 'loading', undefined, userMessage).catch(() => {});
                  }
                }

                // Detect completion: result message means query finished normally
                // (stop_reason can be 'end_turn', 'tool_use', or null — all mean done)
                if (msg.type === 'result') {
                  receivedResult = true;
                }

                // Send SSE-formatted data
                const data = `data: ${JSON.stringify(message)}\n\n`;
                safeEnqueue(data);
              }
            } catch (streamError) {
              // If user cancelled (abort), stop immediately — do not retry
              if (isClosed || queryAbortController.signal.aborted) break;
              throw streamError;
            }

            // Got result or user cancelled → done
            if (receivedResult || isClosed || queryAbortController.signal.aborted) break;

            // Stream ended without end_turn → likely compaction, re-query to continue
            // Create a fresh AbortController for the retry (old one may be exhausted)
            const retryAbortController = new AbortController();
            // Forward cancel signal from the original controller
            queryAbortController.signal.addEventListener('abort', () => retryAbortController.abort(), { once: true });

            console.log(`[Chat] Stream ended without result message, resuming (attempt ${attempt + 1}/${MAX_COMPACTION_RETRIES})`);
            currentResponse = query({
              prompt: 'continue',
              options: {
                ...options,
                abortController: retryAbortController,
                resume: actualSessionId || sessionId,
              },
            });
          }

          // Update global state: end loading (fetch title)
          if (cwd && actualSessionId) {
            const title = await getSessionTitle(cwd, actualSessionId);
            await updateGlobalState(cwd, actualSessionId, 'unread', title);
          }

          // Send end marker
          safeEnqueue('data: [DONE]\n\n');
          safeClose();
        } catch (error) {
          // Update global state: end loading (on error or cancel)
          if (cwd && actualSessionId) {
            const title = await getSessionTitle(cwd, actualSessionId);
            await updateGlobalState(cwd, actualSessionId, 'unread', title);
          }

          // If error was caused by cancellation, handle silently
          if (queryAbortController.signal.aborted) {
            console.log('Query aborted by user');
            safeClose();
            return;
          }
          console.error('Stream error:', error);
          safeEnqueue(`data: ${JSON.stringify({ type: 'error', error: String(error) })}\n\n`);
          safeClose();
        }
      },
      async cancel() {
        isClosed = true;
        // Cancel query execution
        queryAbortController.abort();
        // Update global state: end loading (user cancelled)
        const actualSessionId = sessionId; // Use the passed-in sessionId on cancel
        if (cwd && actualSessionId) {
          const title = await getSessionTitle(cwd, actualSessionId);
          await updateGlobalState(cwd, actualSessionId, 'unread', title);
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
  })
);
