import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { readFileSync, writeFileSync } from 'fs';
import { writeFile, mkdir, readdir, stat, unlink } from 'fs/promises';
import { isAbsolute, join } from 'path';
import { tmpdir } from 'os';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import fg from 'fast-glob';
import type { AgentContext } from './types';

// Async child-process helpers. We must NOT use execSync/execFileSync here:
// this module runs inside the Next.js request handler, and commands like
// `cock browser <action>` issue HTTP calls back to the same server. A
// synchronous child_process call freezes the event loop so the server
// can't answer that HTTP call → self-deadlock until timeout (ETIMEDOUT).
const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/**
 * Directory where full tool outputs are spilled so the LLM can page through
 * them with the existing Read tool. Kept in OS temp to survive within a
 * session and be cleaned up either by the GC below or the OS itself.
 */
const SPILL_DIR = join(tmpdir(), 'cockpit-tool-outputs');
const SPILL_MAX_FILES = 200;

/**
 * Spill a full tool output (pre-truncation) to a temp file and return its
 * absolute path. The LLM can then call Read({ file_path, offset, limit }) to
 * page through the full content. Best-effort: on I/O failure returns
 * undefined and the caller simply skips the "saved to ..." hint.
 *
 * Also opportunistically GCs the spill dir when it grows past SPILL_MAX_FILES,
 * dropping the oldest entries first. This bounds disk usage without needing
 * a background cleaner.
 */
async function spillToFile(text: string, kind: string): Promise<string | undefined> {
  try {
    await mkdir(SPILL_DIR, { recursive: true });

    // Best-effort GC: when the dir is close to full, drop the oldest files.
    try {
      const entries = await readdir(SPILL_DIR);
      if (entries.length >= SPILL_MAX_FILES) {
        const statted = await Promise.all(
          entries.map(async (name) => {
            const p = join(SPILL_DIR, name);
            try {
              return { p, mtime: (await stat(p)).mtimeMs };
            } catch {
              return null;
            }
          })
        );
        const live = statted.filter((x): x is { p: string; mtime: number } => x !== null);
        live.sort((a, b) => a.mtime - b.mtime);
        const toDrop = live.slice(0, Math.max(0, live.length - SPILL_MAX_FILES + 1));
        await Promise.all(toDrop.map(({ p }) => unlink(p).catch(() => undefined)));
      }
    } catch {
      // GC is best-effort; failing to clean up shouldn't stop the spill.
    }

    const stamp = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    const file = join(SPILL_DIR, `${kind}-${stamp}-${rand}.log`);
    await writeFile(file, text, 'utf-8');
    return file;
  } catch {
    return undefined;
  }
}

/**
 * Truncate a long string while keeping both head and tail, snapping to line
 * boundaries, and leaving an explicit marker so the LLM knows that truncation
 * happened, how much was dropped, and that it can re-scope the query.
 *
 * bias:
 *  - 'balanced' (default): ~60% head + ~40% tail. Good for general command
 *    output where the first lines give context and the last lines give the
 *    final state.
 *  - 'tail': ~20% head + ~80% tail. Good for errors / build logs where the
 *    meaningful "first error" or exit message sits at the end of stderr.
 *
 * When `spillPath` is provided the marker becomes actionable: the LLM is
 * told exactly which file to Read to page through the full content, so it
 * doesn't have to re-run the original (possibly expensive or side-effectful)
 * command.
 */
function cap(
  text: string,
  max: number,
  opts: { label?: string; bias?: 'balanced' | 'tail'; spillPath?: string } = {}
): string {
  if (text.length <= max) return text;
  const { label = 'output', bias = 'balanced', spillPath } = opts;
  // Reserve room for BOTH a top banner and the mid-text marker so the user
  // sees truncation both at first glance (banner) and exactly where the
  // dropped middle begins (marker).
  const RESERVE = 520;
  const budget = Math.max(0, max - RESERVE);
  const headRatio = bias === 'tail' ? 0.2 : 0.6;
  const headLen = Math.floor(budget * headRatio);
  const tailLen = budget - headLen;

  // Snap head cut back to the previous newline if one is reasonably close,
  // so the visible tail of the head section is a whole line.
  let headEnd = headLen;
  if (headLen > 0) {
    const nl = text.lastIndexOf('\n', headLen);
    if (nl > headLen * 0.5) headEnd = nl;
  }

  // Snap tail cut forward to the next newline so the tail starts on a whole line.
  let tailStart = text.length - tailLen;
  if (tailLen > 0 && tailStart > 0) {
    const nl = text.indexOf('\n', tailStart);
    if (nl !== -1 && nl < text.length - tailLen * 0.5) tailStart = nl + 1;
  }

  const head = text.slice(0, headEnd);
  const tail = text.slice(tailStart);
  const dropped = text.length - head.length - tail.length;
  const kb = (n: number) => (n / 1024).toFixed(1) + ' KB';
  const hint = spillPath
    ? `full output saved to ${spillPath} — call Read({ file_path: "${spillPath}", offset, limit }) to page through`
    : 'narrow the query, page through (head/tail/sed), or redirect to a file';

  // Top banner: always visible no matter where the reader scrolls. Decorated
  // with ==== so it survives both raw-text mode (PreviewModal 'json' view)
  // AND the colored tree (it breaks JSON, forcing the UI to fall back to
  // raw-text mode — at which point the banner is impossible to miss).
  const banner =
    `==== ${label.toUpperCase()} TRUNCATED ====\n` +
    `Original: ${kb(text.length)} (${text.length} chars) · Kept: head ${kb(head.length)} + tail ${kb(tail.length)} · Dropped: ${kb(dropped)}\n` +
    `${hint}\n` +
    `==========================\n\n`;

  return (
    banner +
    head +
    `\n\n...[${label} truncated here — ${kb(dropped)} dropped; see banner at top for full-output path]\n\n` +
    tail
  );
}

// Shared thought field — forces the model to reflect and reason before every tool call.
const thoughtField = z.string().describe('PREVIOUS result assessment → THIS action reason → EXPECTED outcome');

// Appended to every tool description so the model sees the format requirement in the main description text.
const THOUGHT_HINT = ' The "thought" param MUST follow this format: "PREVIOUS: [last result] → THIS: [action + why] → EXPECT: [expected result]".';

export function createTools(context: AgentContext) {
  const RG_PATH = join(process.cwd(), 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg');

  return {
    Read: tool({
      description:
        'Read a file. Params: { thought, file_path (absolute), offset (1-based line), limit (lines, default 600, max 4000) }. ' +
        'Returns the selected lines as text, followed by a footer like "[read lines X-Y of Z]" so you always know ' +
        'whether the file has more content. When the footer shows more lines remain, call Read again with a higher offset.' + THOUGHT_HINT,
      inputSchema: zodSchema(
        z.object({
          thought: thoughtField,
          file_path: z.string(),
          offset: z.number().int().min(1).default(1),
          limit: z.number().int().min(1).max(4000).default(600),
        })
      ),
      execute: async ({ file_path, offset, limit }: { thought: string; file_path: string; offset: number; limit: number }) => {
        try {
          if (!isAbsolute(file_path)) return 'Error: file_path must be an absolute path.';
          const content = readFileSync(file_path, 'utf-8');
          const lines = content.split('\n');
          const total = lines.length;
          const start = Math.max(0, offset - 1);
          const end = Math.min(total, start + limit);
          const body = lines.slice(start, end).join('\n');
          // Humans number lines 1-based; match that in the footer for clarity.
          const shownFrom = start + 1;
          const shownTo = end;
          const more = total - end;
          const footer =
            more > 0
              ? `\n\n[read lines ${shownFrom}-${shownTo} of ${total} — ${more} more line(s) remain; call Read again with offset=${end + 1}]`
              : `\n\n[read lines ${shownFrom}-${shownTo} of ${total} — end of file]`;
          return body + footer;
        } catch (err) {
          return `Error reading file: ${(err as Error).message}`;
        }
      },
    }),

    Write: tool({
      description:
        'Write a file to disk. Params: { thought, file_path (absolute), content }. Creates or overwrites. ' +
        'Prefer Edit for modifying existing files; use Write for new files or full rewrites. ' +
        'Do NOT create documentation (*.md/README) unless explicitly requested.' + THOUGHT_HINT,
      inputSchema: zodSchema(z.object({ thought: thoughtField, file_path: z.string(), content: z.string() })),
      execute: async ({ file_path, content }: { thought: string; file_path: string; content: string }) => {
        try {
          if (!isAbsolute(file_path)) return 'Error: file_path must be an absolute path.';
          writeFileSync(file_path, content, 'utf-8');
          return `File written: ${file_path}`;
        } catch (err) {
          return `Error writing file: ${(err as Error).message}`;
        }
      },
    }),

    Edit: tool({
      description:
        'Edit a file by exact string replacement. Params: { thought, replace_all, file_path (absolute), old_string, new_string }. ' +
        'If replace_all is false, replaces the first occurrence. old_string must match exactly.' + THOUGHT_HINT,
      inputSchema: zodSchema(
        z.object({
          thought: thoughtField,
          replace_all: z.boolean().default(false),
          file_path: z.string(),
          old_string: z.string(),
          new_string: z.string(),
        })
      ),
      execute: async ({
        replace_all,
        file_path,
        old_string,
        new_string,
      }: {
        thought: string;
        replace_all: boolean;
        file_path: string;
        old_string: string;
        new_string: string;
      }) => {
        try {
          if (!isAbsolute(file_path)) return 'Error: file_path must be an absolute path.';
          const content = readFileSync(file_path, 'utf-8');
          if (!content.includes(old_string)) {
            return `Error: old_string not found in ${file_path}. The file may have changed.`;
          }
          const updated = replace_all ? content.split(old_string).join(new_string) : content.replace(old_string, new_string);
          writeFileSync(file_path, updated, 'utf-8');
          return `File edited: ${file_path}`;
        } catch (err) {
          return `Error editing file: ${(err as Error).message}`;
        }
      },
    }),

    Bash: tool({
      description:
        'Run a shell command. Params: { thought, command, description?, timeout? (ms) }. ' +
        'Output is capped at ~64KB — both head and tail are preserved with an explicit truncation marker. ' +
        'On failure, stderr tail is prioritized (the last lines usually carry the real error). ' +
        'When truncation happens the full output is automatically spilled to a temp file; the marker will include ' +
        'its absolute path — call Read({ file_path, offset, limit }) on that path to page through the complete output ' +
        'WITHOUT re-running the command (critical for expensive or side-effectful commands like builds, installs, or POST requests). ' +
        'IMPORTANT: an EMPTY tool_result is impossible — if the command produced no stdout, the tool returns an explicit ' +
        '"(exit 0 — empty stdout...)" annotation. Do NOT interpret such a result as "output was truncated"; it means the ' +
        'command itself produced nothing (often a bug in the command, e.g. an un-invoked arrow function, a silent failure ' +
        'writing to stderr, or a command that intentionally produces no stdout).' + THOUGHT_HINT,
      inputSchema: zodSchema(
        z.object({
          thought: thoughtField,
          command: z.string(),
          description: z.string().optional(),
          timeout: z.number().int().min(1).max(600000).optional(),
        })
      ),
      execute: async ({ command, timeout }: { thought: string; command: string; description?: string; timeout?: number }) => {
        const BASH_CAP = 64000;
        try {
          // With `encoding: 'utf-8'` promisify(exec) returns stdout/stderr
          // as strings, not Buffers.
          const { stdout, stderr } = await execAsync(command, {
            cwd: context.cwd,
            encoding: 'utf-8',
            timeout: timeout ?? 60000,
            maxBuffer: 10 * 1024 * 1024,
            env: { ...process.env, FORCE_COLOR: '0', CI: '1' },
          });

          // Empty stdout is the #1 source of model confusion — an empty
          // string in tool_result is indistinguishable from "truncated". Be
          // explicit: tell the model exactly what happened, and include any
          // stderr the command wrote (commands often report real problems on
          // stderr while exiting 0).
          if (stdout.length === 0) {
            if (stderr.length === 0) {
              return '(exit 0 — empty stdout and empty stderr. The command produced no output at all; NOT a truncation. Common causes: (a) an arrow function was defined but not invoked — wrap as `(async()=>{...})()`; (b) the command intentionally prints nothing on success; (c) output went to a file instead of stdout.)';
            }
            const stderrCapped = cap(stderr, BASH_CAP - 200, { label: 'stderr', bias: 'tail' });
            return `(exit 0 — empty stdout; stderr below is NOT an error but a side-channel message since exit code was 0)\n\n--- stderr ---\n${stderrCapped}`;
          }

          // Only spill when truncation will actually happen; otherwise we pay
          // disk I/O for nothing.
          const spillPath = stdout.length > BASH_CAP ? await spillToFile(stdout, 'bash') : undefined;
          return cap(stdout, BASH_CAP, { label: 'stdout', spillPath });
        } catch (err) {
          const message = (err as Error).message;
          const stderr = (err as { stderr?: string | Buffer }).stderr?.toString() || '';
          const header = `Error: ${message}\n`;
          const budget = Math.max(0, BASH_CAP - header.length);
          const spillPath = stderr.length > budget ? await spillToFile(stderr, 'bash-stderr') : undefined;
          // Errors are tail-heavy: the final "error: ..." line is what we need.
          return header + cap(stderr, budget, { label: 'stderr', bias: 'tail', spillPath });
        }
      },
    }),

    Glob: tool({
      description:
        'Find files matching a glob pattern (fast-glob style). Params: { thought, pattern }. ' +
        'Runs relative to cwd and returns up to 100 paths (newline-delimited). When more than 100 match, ' +
        'the full list is spilled to a temp file and an explicit "...[N more paths omitted — M total; full list saved to ...]" footer ' +
        'is appended; call Read({ file_path, offset, limit }) on that path to page through the complete list, or tighten the pattern. ' +
        'Supports **, {}, [], *, ?.' + THOUGHT_HINT,
      inputSchema: zodSchema(z.object({ thought: thoughtField, pattern: z.string() })),
      execute: async ({ pattern }: { thought: string; pattern: string }) => {
        try {
          const matches = await fg(pattern, {
            cwd: context.cwd,
            onlyFiles: true,
            unique: true,
            dot: true,
            followSymbolicLinks: true,
            ignore: ['**/node_modules/**', '**/.git/**'],
          });
          if (matches.length === 0) return '(no matches)';
          const GLOB_CAP = 100;
          if (matches.length <= GLOB_CAP) return matches.join('\n');
          const omitted = matches.length - GLOB_CAP;
          const spillPath = await spillToFile(matches.join('\n'), 'glob');
          const hint = spillPath
            ? `full list saved to ${spillPath} — call Read({ file_path: "${spillPath}", offset, limit }) to page through all ${matches.length} paths, or tighten the pattern`
            : `tighten the pattern to see the rest`;
          return (
            matches.slice(0, GLOB_CAP).join('\n') +
            `\n\n...[${omitted} more paths omitted — ${matches.length} total; ${hint}]`
          );
        } catch (err) {
          return `Error: ${(err as Error).message}`;
        }
      },
    }),

    Grep: tool({
      description:
        'Search for a pattern using ripgrep. Params: { thought, pattern, path (absolute, optional), ignore_case (default true), output_mode, "-n" }. ' +
        'ALWAYS use Grep for searching (never run rg/grep via Bash). ' +
        'output_mode: "content" returns matching lines; "files_with_matches" returns file paths; "count" returns counts. ' +
        'Output is capped at ~32KB (head + tail preserved with an explicit truncation marker). ' +
        'ripgrep also caps matches at 1000/file as a safety net. When truncation happens the full results are spilled ' +
        'to a temp file and the marker gives you its path — call Read({ file_path, offset, limit }) to page through, ' +
        'or tighten the pattern / restrict the path for a smaller result.' + THOUGHT_HINT,
      inputSchema: zodSchema(
        z.object({
          thought: thoughtField,
          pattern: z.string(),
          path: z.string().optional(),
          ignore_case: z.boolean().default(true),
          output_mode: z.enum(['content', 'files_with_matches', 'count']).default('content'),
          '-n': z.boolean().optional(),
        })
      ),
      execute: async ({
        pattern,
        path,
        ignore_case,
        output_mode,
        '-n': showLineNumbers,
      }: {
        thought: string;
        pattern: string;
        path?: string;
        ignore_case: boolean;
        output_mode: 'content' | 'files_with_matches' | 'count';
        '-n'?: boolean;
      }) => {
        try {
          if (path && !isAbsolute(path)) return 'Error: path must be an absolute path.';
          const target = path || context.cwd;
          const args: string[] = [
            '--no-heading',
            '--color',
            'never',
            '--max-columns',
            '500',
          ];

          if (ignore_case) {
            args.push('--ignore-case');
          }

          // Safety net to prevent runaway output from a single file blowing
          // past maxBuffer. The real volume control is the JS-side `cap()`
          // below, so we keep this high (was 100 — that silently dropped
          // matches long before the JS cap kicked in).
          const RG_PER_FILE_CAP = '1000';

          if (output_mode === 'files_with_matches') {
            args.push('--files-with-matches');
            args.push('--max-count', RG_PER_FILE_CAP);
          } else if (output_mode === 'count') {
            args.push('--count');
          } else if (showLineNumbers ?? true) {
            args.push('--line-number');
            args.push('--max-count', RG_PER_FILE_CAP);
          }

          args.push('--', pattern, target);

          const { stdout } = await execFileAsync(RG_PATH, args, {
            encoding: 'utf-8',
            timeout: 15000,
            maxBuffer: 10 * 1024 * 1024,
            env: { ...process.env, FORCE_COLOR: '0' },
          });
          const GREP_CAP = 32000;
          const spillPath = stdout.length > GREP_CAP ? await spillToFile(stdout, 'grep') : undefined;
          return cap(stdout, GREP_CAP, { label: 'grep results', spillPath });
        } catch (err) {
          // promisify(execFile) puts the child's exit code on err.code
          // (number on normal exit, string like 'ENOENT' for spawn errors).
          const exitCode = (err as { code?: number | string }).code;
          if (exitCode === 1) {
            return '(no matches)';
          }
          return `Error: ${(err as Error).message}`;
        }
      },
    }),

    TodoWrite: tool({
      description:
        'Plan and track progress. Use this as your FIRST tool call to break down the task into steps, then update after each step completes. ' +
        'Params: { thought, todos: [{ content, status, activeForm? }] }. Replaces the entire list. ' +
        'Statuses: pending | in_progress | completed. Keep at most one in_progress.' + THOUGHT_HINT,
      inputSchema: zodSchema(
        z.object({
          thought: thoughtField,
          todos: z.array(
            z.object({
              content: z.string(),
              status: z.enum(['pending', 'in_progress', 'completed']),
              activeForm: z.string().optional(),
            })
          ),
        })
      ),
      execute: async ({
        todos,
      }: {
        thought: string;
        todos: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string }>;
      }) => {
        context.todos = todos;
        const summary = todos.map(t => `- [${t.status}] ${t.content}`).join('\n');
        return `Todo list updated:\n${summary}`;
      },
    }),
  };
}
