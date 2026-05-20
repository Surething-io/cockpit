/**
 * AgentService — unified interface across the five LLM providers.
 *
 * Live implementation lives under packages/feature/agent/src/effect/.
 */
import { Context, Effect, Stream } from "effect"
import type { AgentError, AgentProvider } from "@cockpit/effect-core"

// ─────────────────────────────────────────────────────────
// Messages / tools (provider-neutral)
// ─────────────────────────────────────────────────────────

export type Role = "system" | "user" | "assistant" | "tool"

export interface Message {
  readonly role: Role
  readonly content: string
  readonly toolCalls?: ReadonlyArray<ToolCall>
}

export interface ToolCall {
  readonly id: string
  readonly name: string
  readonly args: Record<string, unknown>
}

export interface Tool {
  readonly name: string
  readonly description: string
  readonly schema: unknown // JSON Schema
}

export interface AgentRequest {
  readonly provider: AgentProvider
  readonly model: string
  readonly messages: ReadonlyArray<Message>
  readonly tools?: ReadonlyArray<Tool>
  readonly maxTokens?: number
  readonly temperature?: number
}

export interface AgentResponse {
  readonly message: Message
  readonly usage?: {
    readonly inputTokens: number
    readonly outputTokens: number
  }
}

export type AgentChunk =
  | { readonly _tag: "text"; readonly delta: string }
  | { readonly _tag: "tool-call-start"; readonly id: string; readonly name: string }
  | { readonly _tag: "tool-call-delta"; readonly id: string; readonly argsDelta: string }
  | { readonly _tag: "tool-call-end"; readonly id: string }
  | { readonly _tag: "done"; readonly usage?: AgentResponse["usage"] }

// ─────────────────────────────────────────────────────────
// Service Tag
// ─────────────────────────────────────────────────────────

export interface AgentService {
  readonly chat: (req: AgentRequest) => Effect.Effect<AgentResponse, AgentError>
  readonly stream: (req: AgentRequest) => Stream.Stream<AgentChunk, AgentError>
}

export const AgentService = Context.GenericTag<AgentService>("@cockpit/AgentService")
