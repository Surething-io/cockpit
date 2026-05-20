/**
 * ClaudeSdkAdapter — wraps the @anthropic-ai/claude-agent-sdk `query()`
 * AsyncIterable into a provider-neutral AgentChunk Stream.
 *
 * Supports 4 providers (Claude / Codex / Kimi / DeepSeek) by switching
 * baseURL/apiKey through env:
 *   - claude: no env override (defaults to anthropic.com)
 *   - codex:    ANTHROPIC_BASE_URL=https://api.openai.com/v1 + ANTHROPIC_API_KEY=<key>
 *   - kimi:     ANTHROPIC_BASE_URL=https://api.moonshot.cn/anthropic + ANTHROPIC_API_KEY=<key>
 *   - deepseek: ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic + ANTHROPIC_API_KEY=<key>
 *
 * Note: the session / tool / global-state integration from the original
 * chat.ts is out of scope here (BACKLOG). This adapter only validates
 * "SDK connectivity + Stream wrapping".
 */
import { Effect, Stream } from "effect"
import { query, type Options } from "@anthropic-ai/claude-agent-sdk"
import { AgentError, type AgentProvider } from "@cockpit/effect-core"
import type {
  AgentRequest,
  AgentResponse,
  AgentChunk,
} from "@cockpit/effect-services"

// ─────────────────────────────────────────────────────────
// Provider -> env mapping
// ─────────────────────────────────────────────────────────

interface ProviderEnv {
  readonly baseUrl?: string
  readonly apiKey?: string
}

const providerEnvFor = (
  provider: AgentProvider,
  apiKeyOverride?: string
): ProviderEnv => {
  switch (provider) {
    case "claude":
      return apiKeyOverride ? { apiKey: apiKeyOverride } : {}
    case "codex":
      return {
        baseUrl: "https://api.openai.com/v1",
        apiKey: apiKeyOverride,
      }
    case "kimi":
      return {
        baseUrl: "https://api.moonshot.cn/anthropic",
        apiKey: apiKeyOverride,
      }
    case "deepseek":
      return {
        baseUrl: "https://api.deepseek.com/anthropic",
        apiKey: apiKeyOverride,
      }
    case "ollama":
      // Ollama uses its own adapter; this function should not be reached for ollama.
      return {}
  }
}

// ─────────────────────────────────────────────────────────
// AgentRequest -> claude-agent-sdk Options
// ─────────────────────────────────────────────────────────

const buildOptions = (
  req: AgentRequest,
  apiKeyOverride?: string
): Options => {
  const env = providerEnvFor(req.provider, apiKeyOverride)
  return {
    model: req.model,
    env: {
      ...process.env,
      ...(env.baseUrl ? { ANTHROPIC_BASE_URL: env.baseUrl } : {}),
      ...(env.apiKey ? { ANTHROPIC_API_KEY: env.apiKey } : {}),
    } as Record<string, string>,
  } as Options
}

const messagesToPrompt = (req: AgentRequest): string => {
  // Simplification: take the last user message as the prompt.
  // (The original chat.ts had richer multi-turn encoding; not reproduced here.)
  const last = [...req.messages].reverse().find((m) => m.role === "user")
  return last?.content ?? ""
}

// ─────────────────────────────────────────────────────────
// chat (non-stream) — internally collects all chunks from the stream
// ─────────────────────────────────────────────────────────

export const claudeChat = (
  req: AgentRequest,
  apiKeyOverride?: string
): Effect.Effect<AgentResponse, AgentError> =>
  Effect.gen(function* () {
    const chunks = yield* Stream.runCollect(claudeStream(req, apiKeyOverride))
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
  }).pipe(Effect.withSpan("agent.chat", { attributes: { provider: req.provider, model: req.model } }))

// ─────────────────────────────────────────────────────────
// stream — AsyncIterable -> Stream<AgentChunk>
// ─────────────────────────────────────────────────────────

export const claudeStream = (
  req: AgentRequest,
  apiKeyOverride?: string
): Stream.Stream<AgentChunk, AgentError> =>
  Stream.async<AgentChunk, AgentError>((emit) => {
    const provider = req.provider
    const options = buildOptions(req, apiKeyOverride)
    const prompt = messagesToPrompt(req)

    let cancelled = false

    void (async () => {
      try {
        const response = query({ prompt, options })
        for await (const message of response) {
          if (cancelled) break

          const msg = message as {
            type?: string
            subtype?: string
            session_id?: string
            message?: { content?: Array<{ type: string; text?: string }> }
            usage?: { input_tokens?: number; output_tokens?: number }
          }

          // text delta
          if (msg.type === "assistant" && msg.message?.content) {
            for (const block of msg.message.content) {
              if (block.type === "text" && block.text) {
                void emit.single({ _tag: "text", delta: block.text })
              }
            }
          }

          // final result
          if (msg.type === "result") {
            void emit.single({
              _tag: "done",
              usage: msg.usage
                ? {
                    inputTokens: msg.usage.input_tokens ?? 0,
                    outputTokens: msg.usage.output_tokens ?? 0,
                  }
                : undefined,
            })
          }
        }
        void emit.end()
      } catch (cause) {
        void emit.fail(
          new AgentError({
            provider,
            kind: "protocol",
            cause,
          })
        )
      }
    })()

    return Effect.sync(() => {
      cancelled = true
    })
  })
