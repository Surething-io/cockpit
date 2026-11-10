/**
 * Verification wire types (docs/DECISION_MODE.md §5). Pure.
 */
import type { CheckKind } from './checks';

/**
 * - verified      ran against the current code of the task, exit 0
 * - failed        ran, non-zero exit, nothing changed since
 * - needs-rerun   ran, but relevant task code changed afterwards
 * - no-tests      exit 0, yet the output shows no test actually ran
 * - unknown       ran, but the engine gave no exit code (timeout, interrupt, …)
 * - running       still running / backgrounded
 * - unverified    the project defines this kind of check; none ran in the range
 * - claimed       the agent said tests pass, but no test run is on record
 */
export type VerificationState = 'verified' | 'failed' | 'needs-rerun' | 'no-tests' | 'unknown' | 'running' | 'unverified' | 'claimed';

export interface VerificationRunRow {
  toolId: string;
  command: string;
  kind: CheckKind;
  filtered: boolean;
  targets: string[];
  state: VerificationState;
  exitCode?: number;
  /** Task files changed after the run (why it needs a rerun). */
  changedAfter: string[];
  /** Relevance was decided without the code index (it was not built yet). */
  approximate: boolean;
  tail: string;
}

export interface VerificationKindRow {
  kind: CheckKind;
  state: VerificationState;
  /** The run that decides the state (latest of this kind). */
  toolId?: string;
}

export interface VerificationResult {
  kinds: VerificationKindRow[];
  runs: VerificationRunRow[];
  /** Shell commands not counted as checks — the user can promote them. */
  otherCommands: Array<{ toolId: string; command: string }>;
}

/** The runs the client sends (subset of agent's CommandRun, kept structural). */
export interface VerificationRunInput {
  toolId: string;
  command: string;
  outcome: { kind: 'exit'; code: number } | { kind: 'running' } | { kind: 'unknown' };
  order: number;
  at?: string;
  noTestsRan: boolean;
  tail: string;
}
