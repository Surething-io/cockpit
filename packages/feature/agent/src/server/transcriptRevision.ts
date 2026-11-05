// Shared across the server and route module realms; no dependency on the file index.
const shared = globalThis as unknown as { __cockpitTranscriptGenerations?: Map<string, number> };
const generations = shared.__cockpitTranscriptGenerations ?? (shared.__cockpitTranscriptGenerations = new Map());
export const transcriptGeneration = (path: string): number => generations.get(path) ?? 0;
export const advanceTranscriptGeneration = (path: string): void => { generations.set(path, transcriptGeneration(path) + 1); };
