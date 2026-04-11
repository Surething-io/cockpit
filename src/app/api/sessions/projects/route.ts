import * as fs from 'fs';
import * as path from 'path';
import { CLAUDE_PROJECTS_DIR, COCKPIT_DIR, COCKPIT_PROJECTS_DIR, GLOBAL_STATE_FILE, encodePath } from '@/lib/paths';

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

// Build a lookup of encodedPath → cwd from the global state file
// This covers projects that may only have ollama/codex/kimi sessions
function buildCwdLookupFromGlobalState(): Map<string, string> {
  const lookup = new Map<string, string>();
  try {
    if (!fs.existsSync(GLOBAL_STATE_FILE)) return lookup;
    const content = fs.readFileSync(GLOBAL_STATE_FILE, 'utf-8');
    const state = JSON.parse(content) as { sessions?: Array<{ cwd?: string }> };
    if (state.sessions) {
      for (const session of state.sessions) {
        if (session.cwd) {
          lookup.set(encodePath(session.cwd), session.cwd);
        }
      }
    }
  } catch { /* ignore */ }
  return lookup;
}

// Resolve the real project path from an encoded directory name using all available sources
function resolveProjectPath(
  encodedDirName: string,
  cwdLookup: Map<string, string>,
  claudeProjectDir?: string,
): string | null {
  // 1. Try Claude's sessions-index.json
  if (claudeProjectDir) {
    const fromIndex = getProjectPathFromIndex(claudeProjectDir);
    if (fromIndex) return fromIndex;

    // 2. Try cwd field from Claude's jsonl files
    const fromJsonl = getProjectPathFromJsonl(claudeProjectDir);
    if (fromJsonl) return fromJsonl;
  }

  // 3. Try global state lookup
  const fromState = cwdLookup.get(encodedDirName);
  if (fromState) return fromState;

  return null;
}

// Count .jsonl session files in a directory (exclude agent- subprocess files)
function countSessionFiles(dir: string): number {
  try {
    if (!fs.existsSync(dir)) return 0;
    return fs.readdirSync(dir)
      .filter(file => file.endsWith('.jsonl') && !file.startsWith('agent-'))
      .length;
  } catch {
    return 0;
  }
}

// Count codex/kimi sessions from cockpit session.json
function countEngineSessionsFromCockpitState(encodedDirName: string): number {
  try {
    const sessionJsonPath = path.join(COCKPIT_PROJECTS_DIR, encodedDirName, 'session.json');
    if (!fs.existsSync(sessionJsonPath)) return 0;
    const content = fs.readFileSync(sessionJsonPath, 'utf-8');
    const state = JSON.parse(content) as {
      sessions?: string[];
      engines?: Record<string, string>;
    };
    if (!state.sessions || !state.engines) return 0;

    // Count sessions whose engine is codex or kimi
    let count = 0;
    for (const sessionId of state.sessions) {
      const engine = state.engines[sessionId];
      if (engine === 'codex' || engine === 'kimi') {
        count++;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

export async function GET() {
  try {
    const cwdLookup = buildCwdLookupFromGlobalState();

    // Collect projects from all sources: Map<encodedPath, { fullPath, sessionCount }>
    const projectMap = new Map<string, { fullPath: string; sessionCount: number }>();

    // --- Source 1: Claude projects dir ---
    if (fs.existsSync(CLAUDE_PROJECTS_DIR)) {
      const projectDirs = fs.readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

      for (const dirName of projectDirs) {
        const claudeDir = path.join(CLAUDE_PROJECTS_DIR, dirName);
        const fullPath = resolveProjectPath(dirName, cwdLookup, claudeDir);
        if (!fullPath) continue;

        const count = countSessionFiles(claudeDir);
        if (count > 0) {
          projectMap.set(dirName, { fullPath, sessionCount: count });
        }
      }
    }

    // --- Source 2: Ollama sessions dir ---
    const ollamaSessionsRoot = path.join(COCKPIT_DIR, 'ollama-sessions');
    if (fs.existsSync(ollamaSessionsRoot)) {
      const ollamaDirs = fs.readdirSync(ollamaSessionsRoot, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

      for (const dirName of ollamaDirs) {
        const ollamaDir = path.join(ollamaSessionsRoot, dirName);
        const count = countSessionFiles(ollamaDir);
        if (count === 0) continue;

        const existing = projectMap.get(dirName);
        if (existing) {
          // Merge: add ollama session count to existing project
          existing.sessionCount += count;
        } else {
          // New project — resolve path using Claude dir (if exists) or global state
          const claudeDir = path.join(CLAUDE_PROJECTS_DIR, dirName);
          const claudeDirExists = fs.existsSync(claudeDir) ? claudeDir : undefined;
          const fullPath = resolveProjectPath(dirName, cwdLookup, claudeDirExists);
          if (!fullPath) continue;

          projectMap.set(dirName, { fullPath, sessionCount: count });
        }
      }
    }

    // --- Source 3: Codex/Kimi sessions via cockpit session.json ---
    if (fs.existsSync(COCKPIT_PROJECTS_DIR)) {
      const cockpitDirs = fs.readdirSync(COCKPIT_PROJECTS_DIR, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

      for (const dirName of cockpitDirs) {
        const engineCount = countEngineSessionsFromCockpitState(dirName);
        if (engineCount === 0) continue;

        const existing = projectMap.get(dirName);
        if (existing) {
          existing.sessionCount += engineCount;
        } else {
          const claudeDir = path.join(CLAUDE_PROJECTS_DIR, dirName);
          const claudeDirExists = fs.existsSync(claudeDir) ? claudeDir : undefined;
          const fullPath = resolveProjectPath(dirName, cwdLookup, claudeDirExists);
          if (!fullPath) continue;

          projectMap.set(dirName, { fullPath, sessionCount: engineCount });
        }
      }
    }

    // Build the final project list
    const projects: ProjectInfo[] = [];
    for (const [encodedPath, { fullPath, sessionCount }] of projectMap) {
      projects.push({
        name: path.basename(fullPath),
        fullPath,
        encodedPath,
        sessionCount,
      });
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
