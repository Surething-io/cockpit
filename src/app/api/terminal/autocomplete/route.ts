import { NextRequest } from 'next/server';
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface AutocompleteRequest {
  cwd: string;
  input: string;
  cursorPosition: number;
}

// List of common commands
const COMMON_COMMANDS = [
  'ls', 'cd', 'pwd', 'cat', 'echo', 'mkdir', 'rm', 'cp', 'mv', 'touch',
  'git', 'npm', 'node', 'python', 'python3', 'pip', 'cargo', 'go',
  'docker', 'kubectl', 'curl', 'wget', 'grep', 'find', 'sed', 'awk',
];

export async function POST(request: NextRequest) {
  try {
    const body: AutocompleteRequest = await request.json();
    const { cwd, input, cursorPosition } = body;

    if (!cwd || input === undefined) {
      return new Response(JSON.stringify({ error: 'Missing cwd or input' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Analyze input to find the part that needs completion
    const beforeCursor = input.substring(0, cursorPosition);
    const words = beforeCursor.split(/\s+/);
    const lastWord = words[words.length - 1] || '';

    let suggestions: string[] = [];

    // If it's the first word, complete a command
    if (words.length === 1 && !beforeCursor.includes(' ')) {
      suggestions = COMMON_COMMANDS.filter((cmd) => cmd.startsWith(lastWord));
    } else {
      // Otherwise complete a path
      suggestions = await getPathSuggestions(cwd, lastWord);
    }

    return new Response(
      JSON.stringify({
        suggestions,
        prefix: lastWord,
        replaceStart: cursorPosition - lastWord.length,
        replaceEnd: cursorPosition,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Autocomplete error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// Get path completion suggestions
async function getPathSuggestions(cwd: string, partialPath: string): Promise<string[]> {
  try {
    // Resolve the path
    const isAbsolute = partialPath.startsWith('/');
    const basePath = isAbsolute
      ? path.dirname(partialPath === '/' ? '/' : partialPath)
      : partialPath.includes('/')
      ? path.join(cwd, path.dirname(partialPath))
      : cwd;

    const prefix = path.basename(partialPath);

    // Read the directory
    const entries = await fs.readdir(basePath, { withFileTypes: true });

    // Filter and format suggestions
    const suggestions = entries
      .filter((entry) => entry.name.startsWith(prefix) && !entry.name.startsWith('.'))
      .map((entry) => {
        const name = entry.name;
        // Append a slash for directories
        return entry.isDirectory() ? `${name}/` : name;
      })
      .slice(0, 20); // Limit count

    return suggestions;
  } catch (error) {
    console.error('Path suggestions error:', error);
    return [];
  }
}
