/**
 * FileWatcher Service — file change Stream.
 *
 * Replaces the hand-written watchers in src/lib/fileWatcher.ts and
 * reviewWatcher.
 */
import { Context, Effect, Stream, Scope } from "effect"
import type { FSError } from "@cockpit/effect-core"

export type FileEventKind = "create" | "change" | "delete" | "rename"

export interface FileEvent {
  readonly path: string
  readonly kind: FileEventKind
  readonly timestamp: number
}

export interface FileWatcher {
  /**
   * Watch a single path (directory or file) and return an event stream;
   * stops automatically when the Scope closes.
   */
  readonly watch: (
    path: string,
    options?: { recursive?: boolean }
  ) => Stream.Stream<FileEvent, FSError, Scope.Scope>

  /** One-shot read (wraps fs.promises.readFile, unifies the error type). */
  readonly readFile: (path: string) => Effect.Effect<string, FSError>

  /** One-shot write. */
  readonly writeFile: (
    path: string,
    content: string
  ) => Effect.Effect<void, FSError>
}

export const FileWatcher = Context.GenericTag<FileWatcher>("@cockpit/FileWatcher")
