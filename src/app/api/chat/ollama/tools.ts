import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { readFileSync, writeFileSync } from 'fs';
// @ts-expect-error globSync is available in Node 22 but @types/node@20 lacks typings
import { globSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';
import type { AgentContext } from './types';

export function createTools(context: AgentContext) {
  return {
    Read: tool({
      description: 'Read the contents of a file at the given path.',
      inputSchema: zodSchema(z.object({ path: z.string() })),
      execute: async ({ path }: { path: string }) => {
        try {
          const content = readFileSync(resolve(context.cwd, path), 'utf-8');
          return content;
        } catch (err) {
          return `Error reading file: ${(err as Error).message}`;
        }
      },
    }),

    Write: tool({
      description: 'Write content to a file at the given path. Creates or overwrites.',
      inputSchema: zodSchema(z.object({ path: z.string(), content: z.string() })),
      execute: async ({ path, content }: { path: string; content: string }) => {
        try {
          writeFileSync(resolve(context.cwd, path), content, 'utf-8');
          return `File written: ${path}`;
        } catch (err) {
          return `Error writing file: ${(err as Error).message}`;
        }
      },
    }),

    Edit: tool({
      description: 'Make an exact edit to a file. oldString must match exactly.',
      inputSchema: zodSchema(z.object({ path: z.string(), oldString: z.string(), newString: z.string() })),
      execute: async ({ path, oldString, newString }: { path: string; oldString: string; newString: string }) => {
        try {
          const fullPath = resolve(context.cwd, path);
          const content = readFileSync(fullPath, 'utf-8');
          if (!content.includes(oldString)) {
            return `Error: oldString not found in ${path}. The file may have changed.`;
          }
          const updated = content.replace(oldString, newString);
          writeFileSync(fullPath, updated, 'utf-8');
          return `File edited: ${path}`;
        } catch (err) {
          return `Error editing file: ${(err as Error).message}`;
        }
      },
    }),

    Bash: tool({
      description: 'Run a bash command in the workspace root. Timeout is 300 seconds.',
      inputSchema: zodSchema(z.object({ command: z.string() })),
      execute: async ({ command }: { command: string }) => {
        try {
          const output = execSync(command, {
            cwd: context.cwd,
            encoding: 'utf-8',
            timeout: 300000,
            env: { ...process.env, FORCE_COLOR: '0', CI: '1' },
          });
          return output.slice(0, 8000);
        } catch (err) {
          const message = (err as Error).message;
          const stderr = (err as { stderr?: Buffer }).stderr?.toString() || '';
          return `Error: ${message}\n${stderr}`.slice(0, 8000);
        }
      },
    }),

    Glob: tool({
      description: 'Find files matching a glob pattern. Returns up to 50 matches.',
      inputSchema: zodSchema(z.object({ pattern: z.string() })),
      execute: async ({ pattern }: { pattern: string }) => {
        try {
          const matches = globSync(pattern, { cwd: context.cwd, absolute: false }) as string[];
          return matches.slice(0, 50).join('\n') || '(no matches)';
        } catch (err) {
          return `Error: ${(err as Error).message}`;
        }
      },
    }),

    Grep: tool({
      description: 'Search for a regex pattern using ripgrep. Returns up to 50 matches. If path omitted, searches workspace.',
      inputSchema: zodSchema(z.object({ pattern: z.string(), path: z.string().optional() })),
      execute: async ({ pattern, path }: { pattern: string; path?: string }) => {
        try {
          const target = path ? resolve(context.cwd, path) : context.cwd;
          const output = execSync(`rg -n --max-count 50 -- ${JSON.stringify(pattern)} ${JSON.stringify(target)}`, {
            encoding: 'utf-8',
            timeout: 15000,
            env: { ...process.env, FORCE_COLOR: '0' },
          });
          return output.slice(0, 8000);
        } catch (err) {
          if ((err as { status?: number }).status === 1) {
            return '(no matches)';
          }
          return `Error: ${(err as Error).message}`;
        }
      },
    }),

    TodoWrite: tool({
      description: 'Update the todo list. Replaces the entire current list.',
      inputSchema: zodSchema(z.object({
        todos: z.array(z.object({
          id: z.string(),
          content: z.string(),
          status: z.enum(['pending', 'in_progress', 'done']),
        })),
      })),
      execute: async ({ todos }: { todos: Array<{ id: string; content: string; status: 'pending' | 'in_progress' | 'done' }> }) => {
        context.todos = todos;
        const summary = todos.map(t => `- [${t.status}] ${t.content}`).join('\n');
        return `Todo list updated:\n${summary}`;
      },
    }),
  };
}
