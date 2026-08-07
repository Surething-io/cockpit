/**
 * Snapshot hook — imperative bridge from the engine event stream (orchestrator)
 * into the Effect-based SnapshotService.
 *
 * The orchestrator's ctx.emit is the ONE point every engine's events flow
 * through (claude, codex, kimi, ollama, deepseek), so hooking here
 * covers all providers without per-engine wiring. Snapshots are fire-and-
 * forget: a failed snapshot logs a warning and never disturbs the run.
 *
 * Flow:
 *   assistant event → cache tool_use blocks (id → name + declared files)
 *   user event with tool_result → the tool finished executing → snapshot
 *   run start → baseline (commit pending external changes so the next tool
 *   commit's parent is exactly the pre-tool state)
 *
 * Every tool_result triggers only a `git status` when nothing changed (the
 * service skips empty snapshots), so no tool whitelist is needed — but the
 * obviously read-only tools are skipped up front to avoid even that.
 */
import { Effect } from 'effect';
import { AppRuntime } from '@cockpit/effect-runtime/server';
import { SnapshotService } from '@cockpit/effect-services';
import type { AppError } from '@cockpit/effect-core';
import { READ_ONLY_TOOLS } from '../../shared/toolMutation';
import { notePendingRecord, settlePendingRecord } from '../../effect/snapshotLive';
import type { RunEvent } from '../engines/types';

interface ToolMeta {
  name: string;
  files: string[];
  provider: string;
  /** Human-readable detail (Bash/Task `description`, else raw `command`). */
  detail?: string;
}

// Pinned to globalThis: a second Next.js module realm must not lose the
// tool_use index cached by the first (same rationale as sessionRunHub).
const g = globalThis as unknown as {
  __cockpitSnapshotToolIndex?: Map<string, ToolMeta>;
};
const toolIndex: Map<string, ToolMeta> =
  g.__cockpitSnapshotToolIndex ?? (g.__cockpitSnapshotToolIndex = new Map());

/** Entries kept for tool calls whose result never arrives (aborted runs). */
const TOOL_INDEX_CAP = 4000;

/** Pull declared file paths out of a tool_use input (best effort). */
function declaredFiles(input: Record<string, unknown> | undefined): string[] {
  if (!input) return [];
  const out: string[] = [];
  if (typeof input.file_path === 'string' && input.file_path) out.push(input.file_path);
  if (typeof input.notebook_path === 'string' && input.notebook_path) out.push(input.notebook_path);
  return out;
}

/**
 * Human-readable detail for tools that declare no files — used as the commit
 * subject so the timeline says what a `[Bash]` call did. Prefers the tool's
 * `description` field (Claude's Bash/Task carry one); falls back to the raw
 * `command` (Codex/Kimi shell calls). Sanitized + truncated service-side.
 */
function toolDetail(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  if (typeof input.description === 'string' && input.description) return input.description;
  if (typeof input.command === 'string' && input.command) return input.command;
  return undefined;
}

function pruneToolIndex(): void {
  if (toolIndex.size <= TOOL_INDEX_CAP) return;
  // Drop the oldest half (Map preserves insertion order).
  let toDrop = Math.floor(toolIndex.size / 2);
  for (const key of toolIndex.keys()) {
    if (toDrop-- <= 0) break;
    toolIndex.delete(key);
  }
}

interface ContentBlock {
  type?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
}

function contentBlocks(event: RunEvent): ContentBlock[] {
  const message = event.message as { content?: unknown } | undefined;
  return Array.isArray(message?.content) ? (message.content as ContentBlock[]) : [];
}

const forkSnapshot = (
  effect: Effect.Effect<unknown, AppError, SnapshotService>,
): void => {
  void AppRuntime.runFork(
    effect.pipe(
      Effect.catchAll((e) => Effect.logWarning(`snapshot failed: ${e.message}`))
    )
  );
};

/** Run start: commit pending external changes as a baseline (fire-and-forget). */
export function snapshotOnRunStart(cwd: string, sessionKey: string, provider: string): void {
  if (!cwd) return;
  forkSnapshot(
    Effect.flatMap(SnapshotService, (svc) => svc.baseline(cwd, sessionKey, provider))
  );
}

/**
 * Engine event: index tool_use blocks; snapshot on tool_result (fire-and-forget).
 * Called from the orchestrator's ctx.emit for every engine event.
 */
export function snapshotOnRunEvent(
  cwd: string,
  sessionKey: string,
  provider: string,
  event: RunEvent,
): void {
  if (!cwd) return;

  if (event.type === 'assistant') {
    for (const b of contentBlocks(event)) {
      if (b.id && b.name) {
        toolIndex.set(b.id, {
          name: b.name,
          files: declaredFiles(b.input),
          provider,
          detail: toolDetail(b.input),
        });
      }
    }
    pruneToolIndex();
    return;
  }

  if (event.type === 'user') {
    for (const b of contentBlocks(event)) {
      if (!b.tool_use_id) continue;
      const meta = toolIndex.get(b.tool_use_id);
      if (meta) toolIndex.delete(b.tool_use_id);
      if (meta && READ_ONLY_TOOLS.has(meta.name)) continue;
      const toolId = b.tool_use_id;
      // Mark the record pending SYNCHRONOUSLY (before the fork runs) so a
      // concurrently-forked baseline for the same cwd yields to it instead
      // of sweeping this tool's changes into an unattributed baseline commit.
      notePendingRecord(cwd);
      forkSnapshot(
        Effect.flatMap(SnapshotService, (svc) =>
          svc.record({
            cwd,
            sessionKey,
            provider,
            toolId,
            toolName: meta?.name ?? 'tool',
            toolFiles: meta?.files ?? [],
            toolDetail: meta?.detail,
          })
        ).pipe(Effect.ensuring(Effect.sync(() => settlePendingRecord(cwd))))
      );
    }
  }
}
