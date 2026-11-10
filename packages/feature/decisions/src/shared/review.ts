/**
 * Task review wire types — shared by server and client (pure, no IO).
 * See docs/DECISION_MODE.md §3–§4.
 */
import type { SnapshotFileDiff } from '@cockpit/effect-services';

/**
 * Who changed a file inside the review range (§4.3):
 * - task          declared by one of this task's own tool calls
 * - task-maybe    changed during one of this task's Bash-like calls (declares nothing)
 * - mixed         changed by this task AND by another session — not separable
 * - non-agent     changed outside any declared tool target (editor, build, formatter)
 * - other-session changed only by other sessions — excluded from the review by default
 */
export type FileCategory = 'task' | 'task-maybe' | 'mixed' | 'non-agent' | 'other-session';

export interface FileAttribution {
  category: FileCategory;
  /** Session keys of the other sessions that touched the file (mixed / other-session). */
  otherSessions: string[];
}

export type ReviewFile = SnapshotFileDiff & FileAttribution;

export type ReviewResult =
  | { empty: true }
  | {
      empty: false;
      /** Snapshot revision before the range (null = empty tree). */
      base: string | null;
      /** Last snapshot commit of the range. */
      head: string;
      /** Unix seconds of `head`. */
      headAt: number;
      files: ReviewFile[];
      truncated: boolean;
      /** Snapshot commits of this task's own tool calls. */
      ownCommits: number;
      /** All commits in the window, any session. */
      windowCommits: number;
    };

/** One user turn of the conversation, as the client knows it. */
export interface ReviewTurn {
  /** User message id. */
  id: string;
  /** ISO timestamp of the user message, when known. */
  at?: string;
  /** First line of the user's message, for the turn list. */
  text: string;
  /** Tool-call ids of every assistant message in the turn. */
  toolIds: string[];
}

export interface AcceptedTaskFile {
  /** Relative to the git toplevel (the cwd for non-git projects). */
  path: string;
  category: Exclude<FileCategory, 'other-session'>;
  status: SnapshotFileDiff['status'];
  /** Git blob id at the accepted snapshot; absent for deletions. */
  blob?: string;
}

/** An accepted review — written once, never modified (§3, §4.4). */
export interface AcceptedTask {
  id: string;
  sessionId: string;
  cwd: string;
  acceptedAt: number;
  goal: string;
  turns: Array<Pick<ReviewTurn, 'id' | 'at' | 'text'>>;
  toolIds: string[];
  snapshot: { base: string | null; head: string };
  /** HEAD of the project's own repo at accept time (git projects only). */
  projectHead?: string;
  files: AcceptedTaskFile[];
  /** Paths changed only by other sessions in the window — recorded, not frozen. */
  otherSessionFiles: string[];
}

export type AcceptedTaskSummary = Pick<AcceptedTask, 'id' | 'acceptedAt' | 'goal' | 'toolIds' | 'turns'> & { fileCount: number };
