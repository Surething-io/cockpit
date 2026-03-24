import * as fs from 'fs';
import * as path from 'path';
import { CLAUDE_PROJECTS_DIR } from '@/lib/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ProjectInfo {
  name: string;        // Last path component (used for sorting)
  fullPath: string;    // Full path (used for display)
  encodedPath: string; // Encoded path (used to query sessions)
  sessionCount: number;
}

interface SessionsIndex {
  version: number;
  entries: Array<{
    sessionId: string;
    projectPath: string;
  }>;
  originalPath?: string;
}

// Read the real project path from sessions-index.json
function getProjectPathFromIndex(projectDir: string): string | null {
  const indexPath = path.join(projectDir, 'sessions-index.json');
  if (!fs.existsSync(indexPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(indexPath, 'utf-8');
    const index: SessionsIndex = JSON.parse(content);

    // Prefer originalPath
    if (index.originalPath) {
      return index.originalPath;
    }

    // Otherwise get it from the projectPath of the first entry
    if (index.entries && index.entries.length > 0 && index.entries[0].projectPath) {
      return index.entries[0].projectPath;
    }
  } catch {
    // Parse failed, return null
  }

  return null;
}

// Read the cwd field from jsonl files
function getProjectPathFromJsonl(projectDir: string): string | null {
  try {
    const files = fs.readdirSync(projectDir)
      .filter(file => file.endsWith('.jsonl') && !file.startsWith('agent-'));

    for (const file of files) {
      const filePath = path.join(projectDir, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.cwd) {
            return obj.cwd;
          }
        } catch {
          // Ignore parse errors
        }
      }
    }
  } catch {
    // Ignore read errors
  }

  return null;
}

// Fallback: no longer do a simple replacement of - with / (which incorrectly decodes ai-assistant-sionea as ai/assistant/sionea)
// Rely only on sessions-index.json and the cwd field in jsonl to get the real path
// If neither is available, return null and skip the project
function fallbackDecodeProjectPath(_encodedPath: string): string | null {
  return null;
}

export async function GET() {
  try {
    const projectsDir = CLAUDE_PROJECTS_DIR;

    // Check if the directory exists
    if (!fs.existsSync(projectsDir)) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Read all project directories
    const projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);

    const projects: ProjectInfo[] = [];

    for (const projectDirName of projectDirs) {
      const projectPath = path.join(projectsDir, projectDirName);

      // Prefer getting the real path from sessions-index.json, then from the cwd field in jsonl
      // Do not use fallback decoding (replacing - with / causes incorrect paths)
      const fullPath = getProjectPathFromIndex(projectPath)
        || getProjectPathFromJsonl(projectPath)
        || fallbackDecodeProjectPath(projectDirName);

      // Skip the project when the real path cannot be determined
      if (!fullPath) continue;

      // Get the last path component
      const projectName = path.basename(fullPath);

      // Count sessions (exclude subprocess files starting with agent-)
      const sessionCount = fs.readdirSync(projectPath)
        .filter(file => file.endsWith('.jsonl') && !file.startsWith('agent-'))
        .length;

      if (sessionCount > 0) {
        projects.push({
          name: projectName,
          fullPath,
          encodedPath: projectDirName,
          sessionCount,
        });
      }
    }

    // Sort alphabetically by last path component
    projects.sort((a, b) => a.name.localeCompare(b.name));

    return new Response(JSON.stringify(projects), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Projects API error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
