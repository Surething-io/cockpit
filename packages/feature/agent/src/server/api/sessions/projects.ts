import * as fs from 'fs';
import * as path from 'path';
import { Effect } from 'effect';
import { CLAUDE_PROJECTS_DIR, CLAUDE2_PROJECTS_DIR, DEEPSEEK_PROJECTS_DIR, KIMI_PROJECTS_DIR, GLM_PROJECTS_DIR, COCKPIT_PROJECTS_DIR, GLOBAL_STATE_FILE, encodePath, getBuiltinSessionsRoot, listCodexSessions, normalizeCodexSessionId } from '@cockpit/shared-utils';
import { handler } from '@cockpit/effect-runtime/server';
import { AppError } from '@cockpit/effect-core';

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
// This covers projects whose only sessions live in stores that carry no cwd field
// (the Built-in Agent stores) or outside the cwd-encoded layout entirely (codex)
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

/**
 * Merge one session store into the project map. Every store except the primary Claude one
 * goes through here — they share the dir-per-project layout and the merge rule, and differ
 * only in where a project's real cwd can be recovered from.
 *
 * `selfDescribing`: the store's own transcripts carry the cwd, so its project dir can resolve
 * the path (Claude-format stores written by the CLI / Agent SDK — claude2, deepseek/kimi/glm
 * SDK). The Built-in Agent stores (ollama-, deepseek-, kimi- and glm-sessions) write no cwd
 * field, so they fall back to the Claude projects dir and then the global-state lookup.
 *
 * Path resolution runs only for projects not already in the map: an existing entry already
 * has a resolved path, so an unresolvable sibling store must still contribute its count.
 */
function mergeStoreIntoProjects(
  root: string,
  projectMap: Map<string, { fullPath: string; sessionCount: number }>,
  cwdLookup: Map<string, string>,
  selfDescribing: boolean,
): void {
  if (!fs.existsSync(root)) return;

  let dirNames: string[];
  try {
    dirNames = fs.readdirSync(root, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);
  } catch {
    return;
  }

  for (const dirName of dirNames) {
    const storeDir = path.join(root, dirName);
    const count = countSessionFiles(storeDir);
    if (count === 0) continue;

    const existing = projectMap.get(dirName);
    if (existing) {
      existing.sessionCount += count;
      continue;
    }

    const claudeDir = path.join(CLAUDE_PROJECTS_DIR, dirName);
    const pathSource = selfDescribing
      ? storeDir
      : (fs.existsSync(claudeDir) ? claudeDir : undefined);
    const fullPath = resolveProjectPath(dirName, cwdLookup, pathSource);
    if (!fullPath) continue;

    projectMap.set(dirName, { fullPath, sessionCount: count });
  }
}

// Read codex sessions from cockpit session.json. Codex is the only engine that needs
// this: its transcripts live outside the cwd-encoded layout, so there is no project dir
// to scan — the session.json engines map is the only record that ties one to a project.
function codexSessionIdsFromCockpitState(encodedDirName: string): string[] {
  try {
    const sessionJsonPath = path.join(COCKPIT_PROJECTS_DIR, encodedDirName, 'session.json');
    if (!fs.existsSync(sessionJsonPath)) return [];
    const content = fs.readFileSync(sessionJsonPath, 'utf-8');
    const state = JSON.parse(content) as {
      sessions?: string[];
      engines?: Record<string, string>;
    };
    if (!state.sessions || !state.engines) return [];

    return state.sessions
      .filter((sessionId) => state.engines![sessionId] === 'codex')
      .map(normalizeCodexSessionId);
  } catch {
    return [];
  }
}

export const GET = handler(() =>
  Effect.gen(function* () {
    const projects = yield* Effect.tryPromise({
      try: () => buildProjectsList(),
      catch: (cause) =>
        new AppError({ message: 'Failed to list projects', cause }),
    });
    return new Response(JSON.stringify(projects), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  })
);

async function buildProjectsList() {
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

    // --- Source 1b: Claude2 projects dir ---
    mergeStoreIntoProjects(CLAUDE2_PROJECTS_DIR, projectMap, cwdLookup, true);

    // --- Source 1c: DeepSeek/Kimi/GLM SDK-mode projects dirs (written by the Claude Agent SDK) ---
    mergeStoreIntoProjects(DEEPSEEK_PROJECTS_DIR, projectMap, cwdLookup, true);
    mergeStoreIntoProjects(KIMI_PROJECTS_DIR, projectMap, cwdLookup, true);
    mergeStoreIntoProjects(GLM_PROJECTS_DIR, projectMap, cwdLookup, true);

    // --- Source 2: Built-in Agent stores (ollama, deepseek/kimi/glm Built-in Agent mode) ---
    mergeStoreIntoProjects(getBuiltinSessionsRoot('ollama'), projectMap, cwdLookup, false);
    mergeStoreIntoProjects(getBuiltinSessionsRoot('deepseek'), projectMap, cwdLookup, false);
    mergeStoreIntoProjects(getBuiltinSessionsRoot('kimi'), projectMap, cwdLookup, false);
    mergeStoreIntoProjects(getBuiltinSessionsRoot('glm'), projectMap, cwdLookup, false);

    // --- Source 3: Codex sessions via cockpit session.json + global Codex index ---
    const codexByProject = new Map<string, Set<string>>();
    const codexProjectPaths = new Map<string, string>();
    if (fs.existsSync(COCKPIT_PROJECTS_DIR)) {
      const cockpitDirs = fs.readdirSync(COCKPIT_PROJECTS_DIR, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

      for (const dirName of cockpitDirs) {
        const ids = codexSessionIdsFromCockpitState(dirName);
        if (ids.length === 0) continue;
        codexByProject.set(dirName, new Set(ids));
      }
    }

    for (const session of listCodexSessions()) {
      const dirName = encodePath(session.cwd);
      const ids = codexByProject.get(dirName) ?? new Set<string>();
      ids.add(session.id);
      codexByProject.set(dirName, ids);
      codexProjectPaths.set(dirName, session.cwd);
    }

    for (const [dirName, ids] of codexByProject) {
      const engineCount = ids.size;
      if (engineCount === 0) continue;

      const existing = projectMap.get(dirName);
      if (existing) {
        existing.sessionCount += engineCount;
      } else {
        const claudeDir = path.join(CLAUDE_PROJECTS_DIR, dirName);
        const claudeDirExists = fs.existsSync(claudeDir) ? claudeDir : undefined;
        const fullPath = codexProjectPaths.get(dirName) ?? resolveProjectPath(dirName, cwdLookup, claudeDirExists);
        if (!fullPath) continue;

        projectMap.set(dirName, { fullPath, sessionCount: engineCount });
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
    return projects;
}
