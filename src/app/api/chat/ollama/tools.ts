import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { readFileSync, writeFileSync } from 'fs';
import { isAbsolute, join } from 'path';
import { execFileSync, execSync } from 'child_process';
import fg from 'fast-glob';
import type { AgentContext } from './types';

// Shared thought field — forces the model to reflect and reason before every tool call.
const thoughtField = z.string().describe('PREVIOUS result assessment → THIS action reason → EXPECTED outcome');

// Appended to every tool description so the model sees the format requirement in the main description text.
const THOUGHT_HINT = ' The "thought" param MUST follow this format: "PREVIOUS: [last result] → THIS: [action + why] → EXPECT: [expected result]".';

export function createTools(context: AgentContext) {
  const RG_PATH = join(process.cwd(), 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg');

  return {
    Read: tool({
      description:
        'Read a file. Params: { thought, file_path (absolute), offset (1-based line), limit (lines) }. Returns the selected lines as text.' + THOUGHT_HINT,
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
          const start = Math.max(0, offset - 1);
          const end = Math.min(lines.length, start + limit);
          return lines.slice(start, end).join('\n');
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
        'Run a shell command. Params: { thought, command, description?, timeout? (ms) }. Returns stdout/stderr (truncated).' + THOUGHT_HINT,
      inputSchema: zodSchema(
        z.object({
          thought: thoughtField,
          command: z.string(),
          description: z.string().optional(),
          timeout: z.number().int().min(1).max(600000).optional(),
        })
      ),
      execute: async ({ command, timeout }: { thought: string; command: string; description?: string; timeout?: number }) => {
        try {
          const output = execSync(command, {
            cwd: context.cwd,
            encoding: 'utf-8',
            timeout: timeout ?? 60000,
            env: { ...process.env, FORCE_COLOR: '0', CI: '1' },
          });
          return output.slice(0, 16000);
        } catch (err) {
          const message = (err as Error).message;
          const stderr = (err as { stderr?: Buffer }).stderr?.toString() || '';
          return `Error: ${message}\n${stderr}`.slice(0, 16000);
        }
      },
    }),

    Glob: tool({
      description:
        'Find files matching a glob pattern (fast-glob style). Params: { thought, pattern }. Runs relative to cwd and returns up to 100 paths (newline-delimited). Supports **, {}, [], *, ?.' + THOUGHT_HINT,
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
          return matches.slice(0, 100).join('\n') || '(no matches)';
        } catch (err) {
          return `Error: ${(err as Error).message}`;
        }
      },
    }),

    Grep: tool({
      description:
        'Search for a pattern using ripgrep. Params: { thought, pattern, path (absolute, optional), ignore_case (default true), output_mode, "-n" }. ' +
        'ALWAYS use Grep for searching (never run rg/grep via Bash). ' +
        'output_mode: "content" returns matching lines; "files_with_matches" returns file paths; "count" returns counts.' + THOUGHT_HINT,
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

          if (output_mode === 'files_with_matches') {
            args.push('--files-with-matches');
            args.push('--max-count', '100');
          } else if (output_mode === 'count') {
            args.push('--count');
          } else if (showLineNumbers ?? true) {
            args.push('--line-number');
            args.push('--max-count', '100');
          }

          args.push('--', pattern, target);

          const output = execFileSync(RG_PATH, args, {
            encoding: 'utf-8',
            timeout: 15000,
            env: { ...process.env, FORCE_COLOR: '0' },
          });
          return output.slice(0, 8000);
        } catch (err) {
          const status = (err as { status?: number }).status;
          if (status === 1) {
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
