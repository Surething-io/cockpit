/**
 * Topics — cross-iframe message protocol registry.
 *
 * All 20+ hard-coded `window.parent.postMessage({ type: "..." })` call sites
 * converge here. Any topic change is visible at compile time.
 */
import { defineTopic } from "./iframeBus"

// ─────────────────────────────────────────────────────────
// Type definitions (message payload schemas)
// ─────────────────────────────────────────────────────────

export interface SessionChangePayload {
  readonly cwd: string
  readonly sessionId: string
}

export interface ViewChangePayload {
  readonly cwd: string
  readonly view: "agent" | "explorer" | "console"
}

export interface OpenNotePayload {
  readonly cwd: string
}

export interface LangChangePayload {
  readonly lang: string
}

export interface TabAddPayload {
  readonly title: string
  readonly cwd: string
}

export interface TabClosePayload {
  readonly tabId: string
}

export interface SwitchSessionPayload {
  readonly sessionId: string
  readonly cwd: string
}

export interface ProjectChangePayload {
  readonly projectId: string
  readonly cwd: string
}

// ─────────────────────────────────────────────────────────
// Topics for the remaining 12 postMessage call sites.
// ─────────────────────────────────────────────────────────

export interface OpenProjectPayload {
  readonly cwd: string
  readonly sessionId?: string
}

export interface SessionCompletePayload {
  readonly cwd: string
  readonly sessionId: string
  readonly lastUserMessage?: string
}

export interface ScreenshotPreparePayload {
  readonly cwd: string
}

// ─────────────────────────────────────────────────────────
// Topics table — single source of truth; add new protocols here.
// ─────────────────────────────────────────────────────────

export const Topics = {
  SessionChange: defineTopic<SessionChangePayload>("session-change"),
  ViewChange: defineTopic<ViewChangePayload>("view-change"),
  OpenNote: defineTopic<OpenNotePayload>("open-note"),
  LangChange: defineTopic<LangChangePayload>("lang-change"),
  TabAdd: defineTopic<TabAddPayload>("tab-add"),
  TabClose: defineTopic<TabClosePayload>("tab-close"),
  SwitchSession: defineTopic<SwitchSessionPayload>("switch-session"),
  ProjectChange: defineTopic<ProjectChangePayload>("project-change"),

  OpenProject: defineTopic<OpenProjectPayload>("open-project"),
  SessionComplete: defineTopic<SessionCompletePayload>("session-complete"),
  OpenTokenStats: defineTopic<Record<string, never>>("open-token-stats"),
  PinnedSessionsChanged: defineTopic<Record<string, never>>(
    "pinned-sessions-changed"
  ),
  ScheduledTasksChanged: defineTopic<Record<string, never>>(
    "scheduled-tasks-changed"
  ),
  ScreenshotPrepare: defineTopic<ScreenshotPreparePayload>(
    "screenshot-prepare"
  ),
  ScreenshotDone: defineTopic<Record<string, never>>("screenshot-done"),
} as const

export type TopicId = (typeof Topics)[keyof typeof Topics]["id"]
