/**
 * HTTP API intercepts — /api/terminal/* and /api/browser/*
 *
 * These endpoints must be intercepted by server.mjs at the HTTP layer rather
 * than served as Next.js API routes: in Next.js dev mode each route is a
 * separate module instance and cannot share the in-process BrowserBridge /
 * Terminal registry that wsServer owns.
 *
 * Extracted from wsServer.ts so that wsServer.ts stays a pure dispatcher and
 * this layer can be migrated to Effect independently.
 */
import { IncomingMessage } from "http"
import { parse } from "url"
import { readFile } from "fs/promises"
import { randomUUID } from "crypto"
import { WebSocket } from "ws"
import { getTerminalHistoryPath } from "@cockpit/shared-utils"
import {
  getTerminalByShortId,
  listTerminals,
  addOutputListener,
  addExitListener,
  registerTerminal,
  unregisterTerminal,
  getRunningCommand,
  registerBrowser,
  unregisterBrowser,
  getBrowserByShortId,
  createPendingRequest,
  sendCommandToBrowser,
  listBrowsers,
} from "@cockpit/feature-console/server"

// Silence unused — kept for symmetry with their use inside the legacy wsServer
void addOutputListener
void addExitListener
void registerBrowser

// ─────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────

/**
 * Look up finished command output from JSONL terminal history.
 */
async function readFinishedOutput(
  projectCwd: string,
  tabId: string,
  commandId: string
): Promise<{ output: string; exitCode: number } | undefined> {
  try {
    const historyPath = getTerminalHistoryPath(projectCwd, tabId)
    const content = await readFile(historyPath, "utf-8")
    for (const line of content.trim().split("\n").reverse()) {
      try {
        const entry = JSON.parse(line)
        if (entry.id === commandId) {
          let output = entry.output || ""
          if (entry.outputFile) {
            try {
              output = await readFile(entry.outputFile, "utf-8")
            } catch {
              /* file missing */
            }
          }
          return { output, exitCode: entry.exitCode ?? 0 }
        }
      } catch {
        /* invalid line */
      }
    }
  } catch {
    /* history file not found */
  }
  return undefined
}

// ─────────────────────────────────────────────────────────
// /api/terminal/<action>
// ─────────────────────────────────────────────────────────

export async function handleTerminalApi(
  req: IncomingMessage,
  res: import("http").ServerResponse
): Promise<boolean> {
  const { pathname } = parse(req.url || "", true)
  const match = pathname?.match(/^\/api\/terminal\/([a-z]+)$/)
  if (!match || req.method !== "POST") return false

  const action = match[1]
  // Only intercept the 3 actions implemented here; everything else
  // (history / aliases / env / bubble-order / ...) passes through to
  // Next.js's App Router.
  if (action !== "list" && action !== "register" && action !== "unregister") {
    return false
  }

  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  let body: {
    id?: string
    data?: string
    tabId?: string
    commandId?: string
    command?: string
    projectCwd?: string
  }
  try {
    body = JSON.parse(Buffer.concat(chunks).toString())
  } catch {
    body = {}
  }

  const sendJson = (status: number, data: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" })
    res.end(JSON.stringify(data))
  }

  if (action === "list") {
    sendJson(200, { ok: true, data: listTerminals(getRunningCommand) })
    return true
  }

  if (action === "register") {
    const { tabId, commandId, command, projectCwd } = body
    if (!tabId || !commandId || !command) {
      sendJson(400, {
        ok: false,
        error: "Missing tabId/commandId/command",
      })
      return true
    }
    const shortId = registerTerminal(tabId, commandId, command, projectCwd)
    sendJson(200, { ok: true, data: { shortId } })
    return true
  }

  if (action === "unregister") {
    const { commandId } = body
    if (!commandId) {
      sendJson(400, { ok: false, error: "Missing commandId" })
      return true
    }
    unregisterTerminal(commandId)
    sendJson(200, { ok: true })
    return true
  }

  const { id } = body
  if (!id) {
    sendJson(400, { ok: false, error: "Missing terminal id" })
    return true
  }

  const entry = getTerminalByShortId(id)
  if (!entry) {
    sendJson(404, { ok: false, error: `Terminal "${id}" not found` })
    return true
  }

  const cmd = getRunningCommand(entry.commandId)

  if (action === "output") {
    if (cmd) {
      const output =
        cmd.outputLines.join("\n") +
        (cmd.outputPartial ? "\n" + cmd.outputPartial : "")
      sendJson(200, {
        ok: true,
        data: {
          output,
          command: entry.command,
          pid: cmd.pid,
          running: true,
        },
      })
    } else {
      if (!entry.projectCwd) {
        sendJson(404, { ok: false, error: "Command projectCwd unknown" })
        return true
      }
      const historyOutput = await readFinishedOutput(
        entry.projectCwd,
        entry.tabId,
        entry.commandId
      )
      if (historyOutput !== undefined) {
        sendJson(200, {
          ok: true,
          data: {
            output: historyOutput.output,
            command: entry.command,
            exitCode: historyOutput.exitCode,
            running: false,
          },
        })
      } else {
        sendJson(404, { ok: false, error: "Command output not available" })
      }
    }
    return true
  }

  if (action === "stdin") {
    if (!cmd) {
      sendJson(404, { ok: false, error: "Command no longer running" })
      return true
    }
    const { data } = body
    if (data === undefined) {
      sendJson(400, { ok: false, error: "Missing data" })
      return true
    }

    if (cmd.usePty && cmd.ptyProcess) {
      try {
        cmd.ptyProcess.write(data)
      } catch {
        /* exited */
      }
    } else if (cmd.process.stdin?.writable) {
      cmd.process.stdin.write(data)
    } else {
      sendJson(500, { ok: false, error: "stdin not writable" })
      return true
    }
    sendJson(200, { ok: true })
    return true
  }

  sendJson(400, { ok: false, error: `Unknown action: ${action}` })
  return true
}

// ─────────────────────────────────────────────────────────
// /api/browser/<action>
// ─────────────────────────────────────────────────────────

export async function handleBrowserApi(
  req: IncomingMessage,
  res: import("http").ServerResponse
): Promise<boolean> {
  const { pathname } = parse(req.url || "", true)
  const match = pathname?.match(/^\/api\/browser\/([a-z][a-z_]*)$/)
  if (!match || req.method !== "POST") return false

  const action = match[1]

  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  let body: {
    id?: string
    params?: Record<string, unknown>
    timeout?: number
  }
  try {
    body = JSON.parse(Buffer.concat(chunks).toString())
  } catch {
    body = {}
  }

  const { id, params: cmdParams = {}, timeout = 10000 } = body

  const sendJson = (status: number, data: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" })
    res.end(JSON.stringify(data))
  }

  if (action === "list") {
    sendJson(200, { ok: true, data: listBrowsers() })
    return true
  }

  if (action === "unregister") {
    if (!id) {
      sendJson(400, { ok: false, error: "Missing browser id" })
      return true
    }
    const browser = getBrowserByShortId(id)
    if (browser) {
      if (browser.ws && browser.ws.readyState === WebSocket.OPEN) {
        browser.ws.close()
      }
      unregisterBrowser(browser.fullId)
    }
    sendJson(200, { ok: true })
    return true
  }

  if (!id) {
    sendJson(400, { ok: false, error: "Missing browser id" })
    return true
  }

  const browser = getBrowserByShortId(id)
  if (!browser) {
    sendJson(404, { ok: false, error: `Browser "${id}" not found` })
    return true
  }
  if (!browser.ws || browser.ws.readyState !== WebSocket.OPEN) {
    sendJson(503, {
      ok: false,
      error: `Browser "${id}" is disconnected`,
    })
    return true
  }

  const reqId = `r-${randomUUID().slice(0, 8)}`
  const sent = sendCommandToBrowser(id, reqId, action, cmdParams)
  if (!sent) {
    sendJson(503, { ok: false, error: "Failed to send command" })
    return true
  }

  try {
    const data = await createPendingRequest(reqId, timeout)
    sendJson(200, { ok: true, data })
  } catch (err) {
    sendJson(504, { ok: false, error: (err as Error).message })
  }
  return true
}
