/**
 * /api/ollama/models — P8+ migration
 *
 * Ollama: prefer /api/tags, fall back to OpenAI-compatible /v1/models on failure.
 */
import { Effect } from "effect"
import { getOllamaBaseURL } from "@cockpit/shared-utils"
import { handler, ok } from "@cockpit/effect-runtime/server"
import { AgentError } from "@cockpit/effect-core"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface OllamaModel {
  name: string
  size: number
  modified_at: string
  details?: { family?: string; parameter_size?: string }
}

interface OpenAIModel {
  id: string
  created?: number
  owned_by?: string
}

async function fetchModels() {
  const base = getOllamaBaseURL()

  // Try Ollama /api/tags
  try {
    const res = await fetch(`${base}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    })
    if (res.ok) {
      const data = await res.json()
      const models = Array.isArray(data.models) ? data.models : []
      if (models.length > 0) {
        return (models as OllamaModel[]).map((m) => ({
          name: m.name,
          size: m.size,
          modified_at: m.modified_at,
          family: m.details?.family,
          parameter_size: m.details?.parameter_size,
        }))
      }
    }
  } catch {
    /* fall through */
  }

  // OpenAI-compatible /v1/models
  const res = await fetch(`${base}/v1/models`, {
    signal: AbortSignal.timeout(3000),
  })
  if (!res.ok) throw new Error(`Server returned ${res.status}`)
  const data = await res.json()
  return ((data.data || []) as OpenAIModel[]).map((m) => ({
    name: m.id,
    size: 0,
    modified_at: m.created ? new Date(m.created * 1000).toISOString() : "",
    family: m.owned_by || undefined,
    parameter_size: undefined,
  }))
}

export const GET = handler(() =>
  Effect.gen(function* () {
    const models = yield* Effect.tryPromise({
      try: () => fetchModels(),
      catch: (cause) => {
        const msg = cause instanceof Error ? cause.message : String(cause)
        const kind =
          msg.includes("ECONNREFUSED") ||
          msg.includes("fetch failed") ||
          msg.includes("abort")
            ? "timeout"
            : "protocol"
        return new AgentError({
          provider: "ollama",
          kind,
          cause,
        })
      },
    })
    return ok({ models })
  })
)
