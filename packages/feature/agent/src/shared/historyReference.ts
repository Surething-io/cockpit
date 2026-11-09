/** A source reference survives appends; native IDs also survive prefix edits. */
export interface HistoryReference {
  id: string;
  sourceId?: string;
  prefix: string;
}
export interface HistoryCoordinates {
  beforeProof?: string;
  replacesWindow?: boolean;
}
