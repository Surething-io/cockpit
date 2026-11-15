/** Queries derived from the base CodeIndex; no secondary cache. */
export { buildRelated } from './relatedBuilder';
export type { Relation, RelatedHit, RelatedInput, RelatedResponse } from './relatedBuilder';
export { findAffected, isTestFile } from './affected';
export type {
  AffectedInput,
  AffectedResponse,
  AffectedByInput,
  AffectedTestEntry,
  AffectedStats,
} from './affected';
