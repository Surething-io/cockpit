import { readdir } from 'fs/promises';
import * as path from 'path';
import { Effect } from 'effect';
import { CLAUDE_PROJECTS_DIR, COCKPIT_PROJECTS_DIR, GLOBAL_STATE_FILE, encodePath, getBuiltinSessionRoots, normalizeCodexSessionId } from '@cockpit/shared-utils';
import { handler } from '@cockpit/effect-runtime/server';
import { isJsonObject, readJsonOr } from '@cockpit/effect-runtime/server/fs';
import { TranscriptIndex } from '@cockpit/effect-services';
import { isCodexSubagent } from '../../transcriptViews';

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

type ProjectMap = Map<string, { fullPath: string; sessionCount: number }>;

// A missing, half-written or non-object file reads as null: the caller falls back to
// the next source for the project path, as it always has.
const readJson = <T extends object>(file: string): Effect.Effect<T | null, never> =>
  readJsonOr<T | null>(file, null, isJsonObject<T>);

const listDir = (dir: string): Effect.Effect<string[], never> =>
  Effect.tryPromise(() => readdir(dir)).pipe(Effect.orElseSucceed((): string[] => []));

const listSubdirs = (root: string): Effect.Effect<string[], never> =>
  Effect.tryPromise(() => readdir(root, { withFileTypes: true })).pipe(
    Effect.map((entries) => entries.filter((d) => d.isDirectory()).map((d) => d.name)),
    Effect.orElseSucceed((): string[] => [])
  );

// .jsonl session files in a directory (exclude agent- subprocess files)
const listSessionFiles = (dir: string): Effect.Effect<string[], never> =>
  listDir(dir).pipe(Effect.map((files) => files.filter((f) => f.endsWith('.jsonl') && !f.startsWith('agent-'))));

// Read the real project path from sessions-index.json
const getProjectPathFromIndex = (projectDir: string): Effect.Effect<string | null, never> =>
  readJson<SessionsIndex>(path.join(projectDir, 'sessions-index.json')).pipe(
    Effect.map((index) => {
      const first = Array.isArray(index?.entries) ? index.entries[0]?.projectPath : undefined;
      const found = index?.originalPath || first;
      return typeof found === 'string' && found ? found : null;
    })
  );

// The first cwd field among the project's transcripts, from the transcript index
const getProjectPathFromJsonl = (projectDir: string): Effect.Effect<string | null, never, TranscriptIndex> =>
  Effect.gen(function* () {
    const index = yield* TranscriptIndex;
    for (const file of yield* listSessionFiles(projectDir)) {
      const snap = yield* index.snapshot(path.join(projectDir, file), 'claude');
      if (snap?.cwd) return snap.cwd;
    }
    return null;
  });

// Build a lookup of encodedPath → cwd from the global state file
// This covers projects whose only sessions live in stores that carry no cwd field
// (the Built-in Agent stores) or outside the cwd-encoded layout entirely (codex)
const buildCwdLookupFromGlobalState: Effect.Effect<Map<string, string>, never> =
  readJson<{ sessions?: Array<{ cwd?: string }> }>(GLOBAL_STATE_FILE).pipe(
    Effect.map((state) => {
      const lookup = new Map<string, string>();
      for (const session of Array.isArray(state?.sessions) ? state.sessions : []) {
        if (typeof session?.cwd === 'string' && session.cwd) lookup.set(encodePath(session.cwd), session.cwd);
      }
      return lookup;
    })
  );

// Resolve the real project path from an encoded directory name using all available sources
const resolveProjectPath = (
  encodedDirName: string,
  cwdLookup: Map<string, string>,
  claudeProjectDir: string | undefined,
): Effect.Effect<string | null, never, TranscriptIndex> =>
  Effect.gen(function* () {
    if (claudeProjectDir) {
      // 1. Claude's sessions-index.json
      const fromIndex = yield* getProjectPathFromIndex(claudeProjectDir);
      if (fromIndex) return fromIndex;
      // 2. cwd field from Claude's jsonl files
      const fromJsonl = yield* getProjectPathFromJsonl(claudeProjectDir);
      if (fromJsonl) return fromJsonl;
    }
    // 3. Global state lookup
    return cwdLookup.get(encodedDirName) ?? null;
  });

const claudeDirIfPresent = (dirName: string, claudeDirs: Set<string>): string | undefined =>
  claudeDirs.has(dirName) ? path.join(CLAUDE_PROJECTS_DIR, dirName) : undefined;

/**
 * Merge one session store into the project map. Every store except the primary Claude one
 * goes through here — they share the dir-per-project layout and the merge rule, and differ
 * only in where a project's real cwd can be recovered from.
 *
 * The Built-in Agent stores (ollama-, deepseek-, kimi- and glm-sessions) write no cwd field
 * in their transcripts, so a project's real path is recovered from the Claude projects dir
 * and then the global-state lookup rather than from the store itself.
 *
 * Path resolution runs only for projects not already in the map: an existing entry already
 * has a resolved path, so an unresolvable sibling store must still contribute its count.
 */
const mergeStoreIntoProjects = (
  root: string,
  projectMap: ProjectMap,
  cwdLookup: Map<string, string>,
  claudeDirs: Set<string>,
): Effect.Effect<void, never, TranscriptIndex> =>
  Effect.gen(function* () {
    for (const dirName of yield* listSubdirs(root)) {
      const count = (yield* listSessionFiles(path.join(root, dirName))).length;
      if (count === 0) continue;

      const existing = projectMap.get(dirName);
      if (existing) {
        existing.sessionCount += count;
        continue;
      }

      const fullPath = yield* resolveProjectPath(dirName, cwdLookup, claudeDirIfPresent(dirName, claudeDirs));
      if (!fullPath) continue;
      projectMap.set(dirName, { fullPath, sessionCount: count });
    }
  });

// Read codex sessions from cockpit session.json. Codex is the only engine that needs
// this: its transcripts live outside the cwd-encoded layout, so there is no project dir
// to scan — the session.json engines map is the only record that ties one to a project.
const codexSessionIdsFromCockpitState = (encodedDirName: string): Effect.Effect<string[], never> =>
  readJson<{ sessions?: unknown; engines?: Record<string, unknown> }>(
    path.join(COCKPIT_PROJECTS_DIR, encodedDirName, 'session.json')
  ).pipe(
    Effect.map((state) => {
      if (!Array.isArray(state?.sessions) || !state.engines || typeof state.engines !== 'object') return [];
      const engines = state.engines;
      return state.sessions
        .filter((id): id is string => typeof id === 'string' && engines[id] === 'codex')
        .map(normalizeCodexSessionId);
    })
  );

export const GET = handler(() =>
  Effect.gen(function* () {
    const projects = yield* buildProjectsList;
    return new Response(JSON.stringify(projects), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  })
);

const buildProjectsList: Effect.Effect<ProjectInfo[], never, TranscriptIndex> = Effect.gen(function* () {
  const cwdLookup = yield* buildCwdLookupFromGlobalState;

  // Collect projects from all sources: Map<encodedPath, { fullPath, sessionCount }>
  const projectMap: ProjectMap = new Map();

  // --- Source 1: Claude projects dir ---
  const claudeDirNames = yield* listSubdirs(CLAUDE_PROJECTS_DIR);
  const claudeDirs = new Set(claudeDirNames);
  const resolved = yield* Effect.forEach(
    claudeDirNames,
    (dirName) =>
      Effect.gen(function* () {
        const claudeDir = path.join(CLAUDE_PROJECTS_DIR, dirName);
        const fullPath = yield* resolveProjectPath(dirName, cwdLookup, claudeDir);
        const count = fullPath ? (yield* listSessionFiles(claudeDir)).length : 0;
        return { dirName, fullPath, count };
      }),
    { concurrency: 8 }
  );
  for (const { dirName, fullPath, count } of resolved) {
    if (fullPath && count > 0) projectMap.set(dirName, { fullPath, sessionCount: count });
  }

  // --- Source 2: Built-in Agent stores (ollama, deepseek, kimi, glm) ---
  // ~/.cockpit/<engine>/projects is deliberately NOT scanned: those are transcripts from
  // the removed Claude Agent SDK mode, and no loop remains that can resume them.
  for (const root of getBuiltinSessionRoots()) {
    yield* mergeStoreIntoProjects(root, projectMap, cwdLookup, claudeDirs);
  }

  // --- Source 3: Codex sessions via cockpit session.json + global Codex index ---
  const codexByProject = new Map<string, Set<string>>();
  const codexProjectPaths = new Map<string, string>();
  const cockpitDirs = yield* listSubdirs(COCKPIT_PROJECTS_DIR);
  const codexIds = yield* Effect.forEach(cockpitDirs, codexSessionIdsFromCockpitState, { concurrency: 16 });
  cockpitDirs.forEach((dirName, i) => {
    if (codexIds[i].length > 0) codexByProject.set(dirName, new Set(codexIds[i]));
  });

  const index = yield* TranscriptIndex;
  for (const session of (yield* index.codexSessions).filter((e) => !isCodexSubagent(e))) {
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
      const fullPath =
        codexProjectPaths.get(dirName) ??
        (yield* resolveProjectPath(dirName, cwdLookup, claudeDirIfPresent(dirName, claudeDirs)));
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
});
