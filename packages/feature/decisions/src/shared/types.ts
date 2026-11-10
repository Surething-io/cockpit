/**
 * Decision mode — data model shared by server and client (pure, no IO).
 *
 * A decision is stored as an append-only event log (one JSONL file per
 * decision). The current state is a fold over those events, so every edit and
 * every status change stays on record — rationale is never rewritten in place.
 * See docs/DECISION_MODE.md §7 and §10.
 *
 * Only the LIFECYCLE status is stored here (active / superseded / retired).
 * The situational states shown in the UI (applicable, on another branch, not
 * landed, needs review, link lost) are derived from git + CodeGraph at read
 * time and never persisted.
 */

/** Where a decision came from. Determined by the system, never by a model. */
export type DecisionSourceKind =
  /** Quoted from a user message. */
  | 'user'
  /** Quoted from an agent message. */
  | 'agent'
  /** No verbatim quote found — inferred from code / context. */
  | 'inferred'
  /** Typed in by the user directly (review or list). */
  | 'manual';

export interface DecisionSource {
  kind: DecisionSourceKind;
  /** Verbatim excerpt the decision is based on (absent for `manual`). */
  quote?: string;
  sessionId?: string;
  messageId?: string;
}

/** A code location the decision is about. Paths are relative to the git toplevel. */
export interface DecisionLink {
  path: string;
  /** Qualified symbol name when the decision is about a symbol, not the whole file. */
  symbol?: string;
  /** Content fingerprint (git blob hash) of `path` when the decision was accepted. */
  blob?: string;
}

/** The task (review range) a decision was accepted in. */
export interface DecisionOrigin {
  sessionId?: string;
  taskId?: string;
  /** HEAD commit at accept time. */
  head?: string;
}

/** The user-editable text of a decision. */
export interface DecisionContent {
  /** What was chosen. */
  choice: string;
  /** Alternatives that were considered and not taken. */
  alternatives: string[];
  /** Why the choice was worth it. */
  rationale: string;
  /** What cost / limitation was accepted. */
  tradeoffs: string;
  /** Conditions under which the decision should be reconsidered. */
  premises: string[];
}

export type DecisionLifecycle = 'active' | 'superseded' | 'retired';

export interface DecisionCreatedEvent {
  type: 'created';
  at: number;
  content: DecisionContent;
  source: DecisionSource;
  links: DecisionLink[];
  origin?: DecisionOrigin;
  /** Id of the decision this one replaces. */
  supersedes?: string;
}

export interface DecisionEditedEvent {
  type: 'edited';
  at: number;
  /** Only the fields that changed. */
  content?: Partial<DecisionContent>;
  links?: DecisionLink[];
}

export interface DecisionStatusEvent {
  type: 'status';
  at: number;
  status: DecisionLifecycle;
  /** Required for `retired`; optional otherwise. */
  reason?: string;
  /** Set when `status === 'superseded'`. */
  supersededBy?: string;
}

export type DecisionEvent = DecisionCreatedEvent | DecisionEditedEvent | DecisionStatusEvent;

export interface Decision extends DecisionContent {
  id: string;
  source: DecisionSource;
  links: DecisionLink[];
  origin?: DecisionOrigin;
  status: DecisionLifecycle;
  statusReason?: string;
  supersedes?: string;
  supersededBy?: string;
  createdAt: number;
  updatedAt: number;
  /** Number of `edited` events — non-zero shows the "edited" badge. */
  revisions: number;
}

/** Fold an event log into the current state. Returns null for an empty / headless log. */
export function foldDecision(id: string, events: readonly DecisionEvent[]): Decision | null {
  const head = events[0];
  if (!head || head.type !== 'created') return null;
  const d: Decision = {
    id,
    ...head.content,
    alternatives: [...head.content.alternatives],
    premises: [...head.content.premises],
    source: head.source,
    links: head.links,
    origin: head.origin,
    status: 'active',
    supersedes: head.supersedes,
    createdAt: head.at,
    updatedAt: head.at,
    revisions: 0,
  };
  for (const ev of events.slice(1)) {
    if (ev.type === 'edited') {
      if (ev.content) Object.assign(d, ev.content);
      if (ev.links) d.links = ev.links;
      d.revisions += 1;
    } else if (ev.type === 'status') {
      d.status = ev.status;
      d.statusReason = ev.reason;
      d.supersededBy = ev.status === 'superseded' ? ev.supersededBy : undefined;
    } else {
      // A second `created` can only come from a corrupted log; ignore it rather
      // than silently replacing the original rationale.
      continue;
    }
    d.updatedAt = Math.max(d.updatedAt, ev.at);
  }
  return d;
}

/** How a checkout maps to a decision project. */
export type ProjectKind = 'git' | 'path';

export interface DecisionProjectState {
  projectId: string;
  kind: ProjectKind;
  /** Decision mode switch (per project, default off). */
  enabled: boolean;
  /** When the switch was last turned on — default start of the first review range. */
  enabledAt?: number;
  /** Model the user last picked for review extraction in this project (§9). */
  extractionModel?: { engine: string; model: string };
}

/** Another checkout shares this repo's root commit and still exists. */
export interface AmbiguousCandidate {
  projectId: string;
  toplevels: string[];
}

export type DecisionProjectResolution =
  | ({ status: 'resolved' } & DecisionProjectState)
  | { status: 'ambiguous'; rootCommit: string; candidates: AmbiguousCandidate[] };
