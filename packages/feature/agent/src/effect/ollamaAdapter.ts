/**
 * OllamaAdapter — wraps the Vercel AI SDK `streamText` (configured via
 * createOllamaModel) into an AgentChunk Stream.
 *
 * Simplifications:
 *  - Does not reproduce the session / tools / state integration from the
 *    original chat/ollama.ts (BACKLOG).
 *  - Plain-text chat only, to validate SDK connectivity.
 */
import { Effect, Stream } from "effect"
import { streamText } from "ai"
import type { ModelMessage } from "@ai-sdk/provider-utils"
import { AgentError } from "@cockpit/effect-core"
import type {
  AgentRequest,
  AgentResponse,
  AgentChunk,
  Message,
} from "@cockpit/effect-services"
import { createOllamaModel } from "../server/api/chat/ollama/model"

const toModelMessages = (messages: ReadonlyArray<Message>): ModelMessage[] =>
  messages.map((m) => ({
    role: m.role as "system" | "user" | "assistant",
    content: m.content,
  })) as ModelMessage[]

// ─────────────────────────────────────────────────────────
// chat (non-stream)
// ─────────────────────────────────────────────────────────

export const ollamaChat = (
  req: AgentRequest
): Effect.Effect<AgentResponse, AgentError> =>
  Effect.gen(function* () {
    const chunks = yield* Stream.runCollect(ollamaStream(req))
    let text = ""
    let usage: AgentResponse["usage"] | undefined
    for (const c of chunks) {
      if (c._tag === "text") text += c.delta
      else if (c._tag === "done") usage = c.usage
    }
    return {
      message: { role: "assistant", content: text },
      usage,
    } satisfies AgentResponse
  }).pipe(Effect.withSpan("agent.chat", { attributes: { provider: "ollama", model: req.model } }))

// ─────────────────────────────────────────────────────────
// stream
// ─────────────────────────────────────────────────────────

export const ollamaStream = (
  req: AgentRequest
): Stream.Stream<AgentChunk, AgentError> =>
  Stream.async<AgentChunk, AgentError>((emit) => {
    const abortController = new AbortController()

    void (async () => {
      try {
        const ollamaModel = createOllamaModel(req.model)
        const result = streamText({
          model: ollamaModel,
          messages: toModelMessages(req.messages),
          temperature: req.temperature ?? 0,
          abortSignal: abortController.signal,
        })

        // Stream text deltas
        for await (const part of result.fullStream) {
          if (part.type === "text-delta") {
            const delta = (part as unknown as { text: string }).text
            if (delta) void emit.single({ _tag: "text", delta })
          } else if (part.type === "finish") {
            const u = (part as unknown as {
              totalUsage?: { inputTokens?: number; outputTokens?: number }
            }).totalUsage
            void emit.single({
              _tag: "done",
              usage: u
                ? { inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0 }
                : undefined,
            })
          }
        }
        void emit.end()
      } catch (cause) {
        void emit.fail(
          new AgentError({ provider: "ollama", kind: "protocol", cause })
        )
      }
    })()

    return Effect.sync(() => abortController.abort())
  })
