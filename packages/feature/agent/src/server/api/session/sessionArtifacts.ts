/**
 * Session-adjacent artifacts, and how they follow a fork.
 *
 * A transcript is not self-contained. The vendor writes several kinds of file into a
 * directory named after the session id, next to the jsonl:
 *
 *   <projectDir>/<sid>.jsonl
 *   <projectDir>/<sid>/subagents/agent-<id>.jsonl        + agent-<id>.meta.json
 *   <projectDir>/<sid>/subagents/workflows/<runId>/agent-<agentId>.jsonl
 *   <projectDir>/<sid>/workflows/<runId>.json
 *   <projectDir>/<sid>/tool-results/<toolUseId>.txt
 *
 * Every drill-in in the UI resolves through that directory (see session-by-path.ts), so a
 * fork that copies only the jsonl produces a transcript whose Task and Workflow entries all
 * open nothing: `<newSid>/` does not exist. Roughly half the sessions on disk carry such a
 * directory, so this is the common case, not an edge one.
 *
 * WHAT GETS COPIED
 * ----------------
 * Only artifacts the kept transcript actually references — an excerpt of one turn must not
 * drag along a session's entire subagent history (observed: median 464 KB, worst case
 * 122 MB). Every artifact kind is addressed by an id that, when live, appears verbatim in
 * the transcript that references it:
 *
 *   subagents     → `toolUseId` in the .meta.json sidecar
 *   tool-results  → the tool_use id IS the filename
 *   workflows     → the run id, which the Workflow tool reports in its result text
 *
 * So the test is uniform: does this artifact's id occur in the lines we kept? That avoids
 * parsing each vendor result format, and a new artifact kind can be added by naming where
 * its id comes from rather than by teaching this module a new grammar.
 *
 * Note the excerpt path re-issues uuids but NOT tool_use ids (see rechainEntries), which is
 * what keeps this matching valid in the forked file.
 */
import * as fs from 'fs';
import { join, basename, extname } from 'path';

/** `<projectDir>/<sid>.jsonl` → `<projectDir>/<sid>` */
function artifactDir(sessionPath: string): string {
  return sessionPath.replace(/\.jsonl$/, '');
}

/**
 * Same content, independent lifetime — a hard link is the honest representation of a
 * forked session's subagent transcript, and it keeps forking a 100 MB session instant
 * instead of duplicating history that is finished and never rewritten. Falls back to a
 * real copy when linking is refused (cross-device, or a filesystem without hard links).
 */
function linkOrCopy(src: string, dst: string): void {
  fs.mkdirSync(join(dst, '..'), { recursive: true });
  if (fs.existsSync(dst)) return;
  try {
    fs.linkSync(src, dst);
  } catch {
    fs.copyFileSync(src, dst);
  }
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Copy a directory tree (used for a workflow's subagent folder). */
function linkTree(srcDir: string, dstDir: string): number {
  let n = 0;
  for (const entry of listDir(srcDir)) {
    const src = join(srcDir, entry);
    const dst = join(dstDir, entry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(src);
    } catch {
      continue;
    }
    if (stat.isDirectory()) n += linkTree(src, dst);
    else {
      linkOrCopy(src, dst);
      n++;
    }
  }
  return n;
}

/**
 * Give the forked session the subagent / workflow / tool-result files its transcript
 * refers to. Returns the number of files linked; 0 when the source session has no
 * artifacts, which is the majority of sessions and not an error.
 *
 * Never throws: a fork whose transcript landed but whose artifacts did not is degraded
 * (some drill-ins open nothing) but usable, and that beats failing the whole operation
 * after the new session file is already on disk.
 */
export function copyReferencedArtifacts(
  sourceSessionPath: string,
  targetSessionPath: string,
  keptLines: readonly string[],
): number {
  const srcDir = artifactDir(sourceSessionPath);
  if (!fs.existsSync(srcDir)) return 0;
  const dstDir = artifactDir(targetSessionPath);
  const kept = keptLines.join('\n');
  const referenced = (id: string) => id.length > 0 && kept.includes(id);
  let copied = 0;

  try {
    // Subagents: the sidecar names the tool call that spawned the agent.
    const subagents = join(srcDir, 'subagents');
    for (const file of listDir(subagents)) {
      if (!file.endsWith('.meta.json')) continue;
      let toolUseId: string | undefined;
      try {
        toolUseId = JSON.parse(fs.readFileSync(join(subagents, file), 'utf-8')).toolUseId;
      } catch {
        continue;
      }
      if (!toolUseId || !referenced(toolUseId)) continue;
      const transcript = file.replace(/\.meta\.json$/, '.jsonl');
      for (const f of [file, transcript]) {
        if (fs.existsSync(join(subagents, f))) {
          linkOrCopy(join(subagents, f), join(dstDir, 'subagents', f));
          copied++;
        }
      }
    }

    // Tool results: the file is named after the tool_use id that produced it.
    const toolResults = join(srcDir, 'tool-results');
    for (const file of listDir(toolResults)) {
      if (!referenced(basename(file, extname(file)))) continue;
      linkOrCopy(join(toolResults, file), join(dstDir, 'tool-results', file));
      copied++;
    }

    // Workflows: the journal plus that run's own subagent folder.
    const workflows = join(srcDir, 'workflows');
    for (const file of listDir(workflows)) {
      const runId = basename(file, extname(file));
      if (!referenced(runId)) continue;
      linkOrCopy(join(workflows, file), join(dstDir, 'workflows', file));
      copied++;
      copied += linkTree(
        join(srcDir, 'subagents', 'workflows', runId),
        join(dstDir, 'subagents', 'workflows', runId),
      );
    }
  } catch {
    // Best effort — see the doc comment.
  }
  return copied;
}
