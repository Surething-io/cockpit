import * as fs from 'fs';
import * as path from 'path';
import { CLAUDE_DIR, CLAUDE2_DIR } from '@/lib/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CommandInfo {
  name: string;
  description: string;
  source: 'builtin' | 'global' | 'project';
}

// Built-in commands
// NOTE: Keep this list in sync with COMMAND_CONTENT in src/lib/chat/slashCommands.ts —
// any key with a prompt body there should also appear here so the slash-autocomplete
// menu surfaces it.
const BUILTIN_COMMANDS: CommandInfo[] = [
  { name: '/qa', description: 'Enter requirements clarification mode', source: 'builtin' },
  { name: '/fx', description: 'Enter bug evidence-chain analysis mode', source: 'builtin' },
  { name: '/commit', description: 'Commit code changes', source: 'builtin' },
  { name: '/review', description: 'Code review', source: 'builtin' },
  { name: '/test', description: 'Run tests', source: 'builtin' },
  { name: '/fix', description: 'Fix issues', source: 'builtin' },
  { name: '/explain', description: 'Explain code', source: 'builtin' },
  { name: '/refactor', description: 'Refactor code', source: 'builtin' },
];

// Read description from file (first non-empty, non-heading line)
function getDescriptionFromFile(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        return trimmed.slice(0, 50);
      }
    }
  } catch {
    // Ignore read errors
  }
  return '';
}

// Recursively read command files from directory, supporting subdirs (e.g. git/commit.md -> /git:commit)
function readCommandsFromDir(dir: string, source: 'global' | 'project', prefix: string = ''): CommandInfo[] {
  const commands: CommandInfo[] = [];

  if (!fs.existsSync(dir)) {
    return commands;
  }

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Recursively handle subdirectory, name format: /subdir:command
        const subPrefix = prefix ? `${prefix}:${entry.name}` : entry.name;
        commands.push(...readCommandsFromDir(entryPath, source, subPrefix));
      } else if (entry.name.endsWith('.md')) {
        // Handle .md files
        const baseName = entry.name.replace('.md', '');
        const name = prefix ? `/${prefix}:${baseName}` : `/${baseName}`;
        const description = getDescriptionFromFile(entryPath);

        commands.push({
          name,
          description: description || `Custom command: ${name}`,
          source,
        });
      }
    }
  } catch {
    // Ignore read errors
  }

  return commands;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const cwd = searchParams.get('cwd');

    const commands: CommandInfo[] = [];

    // 1. Built-in commands
    commands.push(...BUILTIN_COMMANDS);

    // 2. User global commands (~/.claude/commands/)
    const globalCommandsDir = path.join(CLAUDE_DIR, 'commands');
    commands.push(...readCommandsFromDir(globalCommandsDir, 'global'));

    // 2b. User global commands from Claude 2 (~/.claude2/commands/)
    const claude2CommandsDir = path.join(CLAUDE2_DIR, 'commands');
    commands.push(...readCommandsFromDir(claude2CommandsDir, 'global'));

    // 3. Current project commands ({cwd}/.claude/commands/)
    if (cwd) {
      const projectCommandsDir = path.join(cwd, '.claude', 'commands');
      commands.push(...readCommandsFromDir(projectCommandsDir, 'project'));



    }

    // Deduplicate by name (priority: project > global > builtin)
    const commandMap = new Map<string, CommandInfo>();
    for (const cmd of commands) {
      const existing = commandMap.get(cmd.name);
      if (!existing) {
        commandMap.set(cmd.name, cmd);
      } else {
        // Priority: project > global > builtin
        const priority = { project: 3, global: 2, builtin: 1 };
        if (priority[cmd.source] > priority[existing.source]) {
          commandMap.set(cmd.name, cmd);
        }
      }
    }

    // Sort by name
    const result = Array.from(commandMap.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    );

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Commands API error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
