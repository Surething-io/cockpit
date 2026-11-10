// Browser-safe Pi provider identities, independent of native session paths.
export const PI_ENGINES = ['ollama', 'deepseek', 'kimi', 'glm'] as const;
export type PiEngine = typeof PI_ENGINES[number];

/** Whether a provider uses the embedded Pi runtime. */
export function isPiEngine(engine: string | undefined): engine is PiEngine {
  return PI_ENGINES.some((candidate) => candidate === engine);
}
