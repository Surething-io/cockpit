/**
 * Impact & gaps + decision check wire types (docs/DECISION_MODE.md §6, §7.2). Pure.
 */
import type { Decision, DerivedDecisionState } from './types';
import type { VerificationState } from './verification';

/** How a symbol changed: its interface (signature / export / added / removed) or only its body. */
export type SymbolChange = 'added' | 'removed' | 'interface' | 'body';

export interface CallSite {
  file: string;
  qname: string;
  lines: number[];
}

/** An interface-changed symbol whose callers this task did not touch. */
export interface CallerGap {
  file: string;
  qname: string;
  change: Exclude<SymbolChange, 'body'>;
  callers: CallSite[];
}

export interface BodyChange {
  file: string;
  qname: string;
  /** Tests that reach this file. */
  tests: string[];
}

export type TestState = VerificationState | 'not-run';

export interface TestCoverage {
  test: string;
  state: TestState;
  /** Tool call of the deciding run, if any. */
  toolId?: string;
}

export type BlindSpotKind = 'index-building' | 'index-truncated' | 'unsupported-language' | 'unresolved-import' | 'parse-failed';

export interface BlindSpot {
  kind: BlindSpotKind;
  files: string[];
}

export interface TouchedDecisionWire {
  decision: Decision;
  state: DerivedDecisionState;
  reason: 'direct' | 'neighbor';
  paths: string[];
}

export interface ImpactResult {
  /** Existing decisions this change touches — every one needs a verdict before accept. */
  touched: TouchedDecisionWire[];
  /** Interface changes with callers outside the task, deleted-but-referenced first. */
  interfaceGaps: CallerGap[];
  /** Tests that reach the changed files, with their verification state. */
  tests: TestCoverage[];
  /** Body-only changes (callers not expanded). */
  bodyOnly: BodyChange[];
  blindSpots: BlindSpot[];
  /** Totals before the top-N cut, so the UI can say "and 12 more". */
  totals: { interfaceGaps: number; tests: number; bodyOnly: number };
}

/** Rows per section before folding (§6). */
export const IMPACT_TOP_N = 10;
