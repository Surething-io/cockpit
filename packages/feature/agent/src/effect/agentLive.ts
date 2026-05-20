/**
 * AgentServiceLive — provider routing layer.
 *
 * Dispatches by req.provider to the claudeSdk / ollama adapters.
 *
 * Retry policy: applies agentRetry for AgentError with kind = rate-limit /
 * timeout / unknown. protocol / auth errors are not retried and propagate to
 * the caller.
 */
import { Effect, Layer, Schedule, Stream } from "effect"
import { AgentError, agentRetry } from "@cockpit/effect-core"
import {
  AgentService,
  type AgentRequest,
  type AgentResponse,
  type AgentChunk,
} from "@cockpit/effect-services"
import { claudeChat, claudeStream } from "./claudeSdkAdapter"
import { ollamaChat, ollamaStream } from "./ollamaAdapter"

// Only transient errors are retried
const retryableKinds = new Set<AgentError["kind"]>([
  "rate-limit",
  "timeout",
  "unknown",
])

const isRetryable = (e: AgentError): boolean => retryableKinds.has(e.kind)

// Wrap policy: apply agentRetry when retryable, otherwise fail immediately
const withAgentRetry = <A>(
  effect: Effect.Effect<A, AgentError>
): Effect.Effect<A, AgentError> =>
  effect.pipe(
    Effect.retry({
      schedule: agentRetry as unknown as Schedule.Schedule<unknown, AgentError>,
      while: (e) => isRetryable(e),
    })
  )

const dispatchChat = (
  req: AgentRequest
): Effect.Effect<AgentResponse, AgentError> => {
  switch (req.provider) {
    case "ollama":
      return ollamaChat(req)
    case "claude":
    case "codex":
    case "kimi":
    case "deepseek":
      return claudeChat(req)
  }
}

const dispatchStream = (
  req: AgentRequest
): Stream.Stream<AgentChunk, AgentError> => {
  switch (req.provider) {
    case "ollama":
      return ollamaStream(req)
    case "claude":
    case "codex":
    case "kimi":
    case "deepseek":
      return claudeStream(req)
  }
}

export const AgentServiceLive = Layer.succeed(
  AgentService,
  AgentService.of({
    chat: (req) => withAgentRetry(dispatchChat(req)),
    stream: (req) => dispatchStream(req), // Streaming is excluded from retry (mid-stream retry would drop already-emitted content)
  })
)
