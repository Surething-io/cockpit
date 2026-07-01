import { runClaudeTurn } from '../../pty/claudePtyDriver';
import { mapLineToEvents, initEvent, resultEvent } from '../../pty/ptySseMapper';
import type { RunCtx } from '../types';

/**
 * Claude/Claude2 PTY turn (subscription billing): driven by the interactive claude CLI via
 * jsonl → event mapping. claude-only; used when params.mode === 'pty'.
 *
 * Lifecycle (markRunIdle / 'unread' teardown) is owned by the orchestrator: this only emits
 * events and returns on success, or throws on failure (orchestrator maps abort→idle, else error).
 * PTY uses the runKey AS the claude session id (no mid-stream rekey), so it reports that id via
 * ctx.rekey to set the sessionId the orchestrator returns.
 */
export async function runPtyTurn(ctx: RunCtx): Promise<void> {
  const sid = ctx.currentKey(); // PTY uses the runKey as the claude session id
  const isResume = !!ctx.sessionId;
  const promptText = ctx.prompt ?? '';

  ctx.emit(initEvent(sid) as { type: string; [k: string]: unknown });
  ctx.rekey(sid); // sets actualSessionId = sid (+ 'loading' global state)

  const turn = await runClaudeTurn({
    cwd: ctx.cwd || process.cwd(),
    prompt: promptText,
    sessionId: sid,
    resume: isResume,
    ...(ctx.images && ctx.images.length > 0 && {
      images: ctx.images.map((img) => ({ media_type: img.media_type, data: img.data })),
    }),
    ...(ctx.params.ptyCols && { cols: ctx.params.ptyCols }),
    ...(ctx.params.ptyRows && { rows: ctx.params.ptyRows }),
    signal: ctx.signal,
    onJsonlLine: (line) => {
      for (const ev of mapLineToEvents(line, sid)) {
        ctx.emit(ev as { type: string; [k: string]: unknown });
      }
    },
    // Background-task persistence: the driver stays resident across a background task and signals
    // synthetic turn boundaries. Map them to the SAME init/result events a normal turn emits, so the
    // follow-up (auto-run) turn renders in its own bubble and the completion notification's event row
    // shows (the client keys the row off a turn having ended).
    onTurnBoundary: (kind) =>
      ctx.emit((kind === 'init' ? initEvent(sid) : resultEvent(sid)) as { type: string; [k: string]: unknown }),
    // floating-window dual-view: raw PTY output forwarded to the frontend xterm.
    onPtyData: (data) => ctx.emit({ type: 'pty_output', data }),
    // Startup stuck (REPL not ready, likely a dialog) → ask the user to handle it in the terminal.
    onStuck: () => ctx.emit({ type: 'pty_notice', level: 'warning', messageKey: 'chat.ptyStuck' }),
    // AskUserQuestion selector auto-cancelled (ESC), turn ended early.
    onQuestionEsc: () =>
      ctx.emit({ type: 'pty_notice', level: 'warning', messageKey: 'chat.ptyQuestionEsc' }),
  });

  // claude-code itself crashed (upstream bug) — terminal notice shown as the assistant message.
  if (turn.crashed) {
    ctx.emit({
      type: 'pty_notice',
      level: 'error',
      terminal: true,
      messageKey: 'chat.ptyCrash',
      params: { error: turn.crashError },
    });
  }
  if (turn.timedOut) {
    ctx.emit({ type: 'pty_notice', level: 'warning', terminal: true, messageKey: 'chat.ptyTimedOut' });
  }
  ctx.emit(resultEvent(sid) as { type: string; [k: string]: unknown });
}
