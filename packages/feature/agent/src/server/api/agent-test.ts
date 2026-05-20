/**
 * /api/agent/test — single-turn chat smoke test.
 *
 * Drives AgentService.chat to verify the five provider adapters wire up correctly.
 * The full /api/chat route (sessions, tools, persisted state) keeps its existing
 * implementation; this endpoint is the minimal Effect-shaped probe.
 */
import { Effect } from "effect"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { AgentService, type AgentRequest } from "@cockpit/effect-services"
import { ValidationError } from "@cockpit/effect-core"

interface TestBody {
  readonly provider?: AgentRequest["provider"]
  readonly model?: string
  readonly prompt?: string
}

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as TestBody

    if (!body.provider || !body.model || !body.prompt) {
      return yield* Effect.fail(
        new ValidationError({
          field: !body.provider
            ? "provider"
            : !body.model
              ? "model"
              : "prompt",
          reason: "missing",
        })
      )
    }

    yield* Effect.logInfo("agent.test start").pipe(
      Effect.annotateLogs("provider", body.provider),
      Effect.annotateLogs("model", body.model)
    )

    const agent = yield* AgentService

    const result = yield* agent.chat({
      provider: body.provider,
      model: body.model,
      messages: [{ role: "user", content: body.prompt }],
    })

    yield* Effect.logInfo("agent.test done").pipe(
      Effect.annotateLogs(
        "outputLen",
        result.message.content.length
      )
    )

    return ok({
      provider: body.provider,
      model: body.model,
      response: result.message.content,
      usage: result.usage,
    })
  }).pipe(Effect.withSpan("api.agent.test"))
)
