/**
 * Shared stdin-write semantics for running commands.
 *
 * Consumed by:
 *   - src/lib/effect/terminalHandler.ts  (WS /ws/terminal `stdin` message)
 *   - src/lib/httpApi.ts                  (HTTP POST /api/terminal/stdin)
 *
 * Behavior:
 *   - PTY mode: write raw to the PTY. The kernel line discipline translates
 *     control characters (^C / ^Z / ^D) into signals naturally.
 *   - Pipe mode: the child has no controlling TTY, so control characters would
 *     be delivered as data bytes. Decode them explicitly:
 *       \x03 (Ctrl-C) → SIGINT to the process group (fallback: pid only)
 *       \x1a (Ctrl-Z) → SIGTSTP
 *       \x04 (Ctrl-D) → close stdin (EOF)
 *       other         → write to child stdin
 *
 * Returns false only when pipe-mode stdin is no longer writable AND the data
 * isn't a control character that maps to a signal. Callers may translate
 * that into a 500-class error; everything else (incl. write-after-exit) is
 * swallowed and reported as success because the command has already gone
 * away.
 *
 * Keep this file as the single source of truth — the previous duplicate
 * inline implementations diverged: the WS handler decoded control chars
 * but the HTTP handler wrote them as data, so `cock terminal <id> stdin
 * "$(printf '\\x03')"` could not interrupt a pipe-mode process.
 */
import type { RunningCommand } from './RunningCommandRegistry';

export function writeStdinToCommand(
  cmd: RunningCommand,
  data: string,
): boolean {
  if (cmd.usePty && cmd.ptyProcess) {
    try {
      cmd.ptyProcess.write(data);
    } catch {
      /* pty exited */
    }
    return true;
  }

  // Pipe mode — decode signal-bearing control characters before the data
  // would reach the child's stdin, where they would be inert.
  if (data === '\x03' && cmd.pid) {
    try {
      process.kill(-cmd.pid, 'SIGINT');
    } catch {
      try {
        process.kill(cmd.pid, 'SIGINT');
      } catch {
        /* exited */
      }
    }
    return true;
  }

  if (data === '\x1a' && cmd.pid) {
    try {
      process.kill(cmd.pid, 'SIGTSTP');
    } catch {
      /* exited */
    }
    return true;
  }

  if (data === '\x04') {
    try {
      cmd.process?.stdin?.end();
    } catch {
      /* closed */
    }
    return true;
  }

  if (cmd.process?.stdin?.writable) {
    cmd.process.stdin.write(data);
    return true;
  }

  return false;
}
