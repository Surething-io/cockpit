/**
 * AI extraction wire types (docs/DECISION_MODE.md §9). Pure.
 *
 * Only the result summary, the candidate decisions and the task goal come from
 * a model, and every one of them is checked deterministically before it is
 * shown: quotes must appear verbatim in the message they cite, the source is
 * the role of that message (never the model's claim), and every evidence
 * reference must exist in the range.
 */
import type { DecisionContent, DecisionSource } from './types';

/** Engines that can run an extraction (Grok has no one-shot channel yet). */
export type ExtractionEngine = 'claude' | 'codex' | 'deepseek' | 'kimi' | 'glm' | 'ollama';

export interface ExtractionModelChoice {
  engine: ExtractionEngine;
  model: string;
}

/** One conversation message of the range, condensed by the client. */
export interface ExtractionMessage {
  /** Message id (user message id / assistant bubble id). */
  id: string;
  role: 'user' | 'agent';
  text: string;
  /** One line per tool call: "Edit src/a.ts", "Bash `npm test` (exit 0)". */
  tools: string[];
}

export interface EvidenceRef {
  kind: 'message' | 'file' | 'run';
  /** Message id, cwd-relative path, or tool-call id. */
  id: string;
  /** The `[M3]` / `[F1]` / `[R2]` label shown to the model. */
  label: string;
}

export interface SummaryItem {
  text: string;
  /** Empty → shown as "no evidence". */
  evidence: EvidenceRef[];
}

export interface DecisionCandidate {
  /** Stable within one extraction result (checkbox key). */
  key: string;
  content: DecisionContent;
  /** `user` / `agent` only when the quote was found verbatim; otherwise `inferred`. */
  source: DecisionSource;
  /** cwd-relative paths of task files the decision is about. */
  files: string[];
}

export interface ExtractionResult {
  goal: string;
  summary: SummaryItem[];
  candidates: DecisionCandidate[];
  engine: ExtractionEngine;
  model: string;
  /** Input was split into this many model calls to fit the context window. */
  chunks: number;
  cached: boolean;
  /** Where the range came from — lets the candidate inbox trace a kept decision back. */
  cwd?: string;
  sessionId?: string;
}

/** Low-end default per engine (§12.4); engines without a low tier use the session's model. */
export const LOW_END_MODEL: Partial<Record<ExtractionEngine, string>> = {
  claude: 'claude-haiku-5-5',
  codex: 'gpt-6-luna',
  deepseek: 'deepseek-flash',
};

/** Evidence labels (`[M3]`, `[F1]`, `[R2]`) belong in refs; models still write them into prose. */
export const stripEvidenceLabels = (s: string): string => s.replace(/\s*\[(?:M|F|R)\d+\]/g, '').trim();

/** Strip labels from every text field; a premise / alternative that was only a label disappears. */
export function cleanDecisionContent(c: DecisionContent): DecisionContent {
  const list = (xs: string[]) => xs.map(stripEvidenceLabels).filter(Boolean);
  return {
    choice: stripEvidenceLabels(c.choice),
    alternatives: list(c.alternatives),
    rationale: stripEvidenceLabels(c.rationale),
    tradeoffs: stripEvidenceLabels(c.tradeoffs),
    premises: list(c.premises),
  };
}
