/**
 * What a session's next model request would carry, broken down for display.
 *
 * Engines expose very different amounts of this (see the per-engine builders
 * under server/context/). The shape is therefore permissive: every number may
 * be an estimate, and every item may be a name without readable content. The
 * renderer must say which, never pretend.
 */

export type ContextCategoryId =
  | 'system'        // base / system prompt
  | 'instructions'  // developer / harness instructions injected next to it
  | 'memory'        // CLAUDE.md / AGENTS.md style project memory
  | 'tools'         // tool schemas (built-in)
  | 'mcp'           // MCP tool schemas
  | 'skills'        // skill listings
  | 'agents'        // custom sub-agent definitions
  | 'environment'   // cwd / date / permissions blocks
  | 'messages'      // user + assistant conversation turns
  | 'tool_io'       // tool calls and their results
  | 'reasoning'     // persisted reasoning items
  | 'summary'       // compaction summary standing in for older history
  | 'other';

export interface ContextItem {
  id: string;
  /** Short display name: file path, tool name, "user", … */
  label: string;
  /** Token count for this item; `null` when the engine gives nothing to count. */
  tokens: number | null;
  /** `tokens` came from the engine rather than our character estimate. */
  exact?: boolean;
  /** Readable content when the engine exposes it. Absent → name-only item. */
  content?: string;
  /** `content` was cut to keep the response bounded. */
  truncated?: boolean;
  /** Content kind for the viewer. */
  format?: 'markdown' | 'json' | 'text';
  /** Absolute path when the item is a file on disk. */
  path?: string;
}

export interface ContextCategory {
  id: ContextCategoryId;
  /** Engine-native row name when the engine supplies one (Claude); otherwise the client labels by `id`. */
  name?: string;
  tokens: number;
  /** `tokens` came from the engine/provider rather than our character estimate. */
  exact: boolean;
  items: ContextItem[];
}

/** Engine caveats the UI explains in prose (translated client-side). */
export type ContextNote =
  | 'system_prompt_hidden'     // engine renders its system prompt internally and never exposes it
  | 'tool_schemas_hidden'      // tool names/tokens only, schemas are not exposed
  | 'skills_listing_only'      // only skill descriptions sit in context; bodies load on use
  | 'snapshot_from_last_turn'  // captured at the end of the last turn, not live
  | 'no_snapshot_yet'          // no turn has run since capture was added
  | 'reasoning_encrypted'      // reasoning items are opaque; their size is the ciphertext's
  | 'after_compaction'         // history begins at the last compaction summary
  | 'estimated_breakdown'      // per-category numbers are character estimates
  | 'usage_unknown';           // engine reported no context size for this session

export interface ContextSnapshot {
  engine: string;
  model?: string;
  /** Tokens the last request occupied, as reported by the provider; null when unknown. */
  usedTokens: number | null;
  contextWindow: number | null;
  /** ISO time the numbers were recorded (end of last turn), when known. */
  capturedAt?: string;
  categories: ContextCategory[];
  notes: ContextNote[];
}

/** The figures of a ContextSnapshot without its categories (session-context `summary: true`). */
export type ContextSummary = Pick<ContextSnapshot, 'engine' | 'model' | 'usedTokens' | 'contextWindow' | 'capturedAt'>;
