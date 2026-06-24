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
import { resolve as resolvePath } from "path"
import {
  getTerminalByShortId,
  listTerminals,
  addOutputListener,
  addExitListener,
  registerTerminal,
  unregisterTerminal,
  getRunningCommand,
  flushAllRunningSync,
  getFirstAvailableLine,
  writeStdinToCommand,
  readSince,
  readTail,
  readHead,
  readAround,
  grepOutput,
  stripAnsi as stripAnsiText,
  registerBrowser,
  unregisterBrowser,
  getBrowserByShortId,
  createPendingRequest,
  sendCommandToBrowser,
  listBrowsers,
  getBrowserHealth,
  readBubbleTitles,
} from "@cockpit/feature-console/server"
import type { ReadResult } from "@cockpit/feature-console/server"

// Re-exported so the top-level server (server.mjs) can flush live PTY scrollback
// to disk from its process `exit` hook — same import path in dev and prod.
export { flushAllRunningSync }

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

/**
 * Actions implemented inline below. Anything else (history / aliases / env /
 * bubble-order / ...) passes through to Next.js's App Router.
 *
 * Must stay in sync with the `if (action === ...)` branches in
 * handleTerminalApi — adding a handler without listing it here makes the
 * route 404 (this exact omission of "output" + "stdin" was the bug fixed
 * when this set was introduced).
 */
const HANDLED_TERMINAL_ACTIONS = new Set([
  "list",
  "register",
  "unregister",
  "output",
  "stdin",
  "meta",
  "wait",
])

export async function handleTerminalApi(
  req: IncomingMessage,
  res: import("http").ServerResponse
): Promise<boolean> {
  const { pathname } = parse(req.url || "", true)
  const match = pathname?.match(/^\/api\/terminal\/([a-z]+)$/)
  if (!match || req.method !== "POST") return false

  const action = match[1]
  if (!HANDLED_TERMINAL_ACTIONS.has(action)) {
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
    // ── output (read / filter / context) ────────────────────────────
    since?: number
    tail?: number
    head?: number
    around?: number
    context?: number
    grep?: string
    ignoreCase?: boolean
    noAnsi?: boolean
    collapseCr?: boolean
    maxBytes?: number
    // ── wait ────────────────────────────────────────────────────────
    pattern?: string
    idle?: number
    waitExit?: boolean
    timeout?: number
    printOutput?: boolean
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
      // Both modes default to noAnsi=true + collapseCr=true. Initially this
      // was conditional on pty/pipe, on the assumption that pipe streams
      // would not contain ANSI control sequences. Real-world dev servers
      // (turborepo / make-driven `npm run dev` etc.) emit colourised JSON
      // logs through pipe too, and `\r\r` line endings show up in pipe
      // output as well. The right answer is "AI sees clean lines by
      // default; explicit --keep-ansi/--keep-cr if you want raw bytes."
      const noAnsi = body.noAnsi ?? true
      const collapseCr = body.collapseCr ?? true
      const viewOpts = { stripAnsi: noAnsi, collapseCr }

      // Mode selection: exactly one of since / tail / head / around / grep,
      // else the default = readSince(0) (full buffer).
      let result: ReadResult
      if (typeof body.grep === "string" && body.grep.length > 0) {
        result = grepOutput(cmd, body.grep, {
          ...viewOpts,
          ignoreCase: !!body.ignoreCase,
          since: typeof body.since === "number" ? body.since : 0,
        })
      } else if (typeof body.around === "number") {
        result = readAround(
          cmd,
          body.around,
          typeof body.context === "number" ? body.context : 5,
          viewOpts,
        )
      } else if (typeof body.tail === "number") {
        result = readTail(cmd, body.tail, viewOpts)
      } else if (typeof body.head === "number") {
        result = readHead(cmd, body.head, viewOpts)
      } else {
        result = readSince(
          cmd,
          typeof body.since === "number" ? body.since : 0,
          viewOpts,
        )
      }

      // Honor maxBytes from the tail of the result. We accumulate from the
      // newest line backward so the truncation falls on the oldest material.
      const maxBytes = body.maxBytes ?? 65536
      let acc = 0
      const trimmed: typeof result.matches = []
      for (let i = result.matches.length - 1; i >= 0; i--) {
        const t = result.matches[i].text
        const len = t.length + 1 // +1 for the implied newline
        if (acc + len > maxBytes && trimmed.length > 0) break
        trimmed.unshift(result.matches[i])
        acc += len
      }
      const byteTruncated = trimmed.length < result.matches.length

      sendJson(200, {
        ok: true,
        data: {
          matches: trimmed,
          next: result.next,
          firstAvailable: result.firstAvailable,
          totalLines: result.totalLines,
          truncated: result.truncated || byteTruncated,
          running: true,
          command: entry.command,
          pid: cmd.pid,
        },
      })
    } else {
      // Already-exited command → fall back to JSONL history (legacy behavior).
      // The new line-counter machinery only covers live commands.
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
        const out = body.noAnsi
          ? stripAnsiText(historyOutput.output)
          : historyOutput.output
        sendJson(200, {
          ok: true,
          data: {
            output: out,
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
    // Shared with WS /ws/terminal stdin handler — pipe-mode control chars
    // (\x03 / \x1a / \x04) are decoded into SIGINT / SIGTSTP / EOF here so
    // `cock terminal <id> stdin "$(printf '\x03')"` actually interrupts a
    // pipe-mode child instead of dropping 0x03 into its stdin as data.
    const ok2 = writeStdinToCommand(cmd, data)
    if (!ok2) {
      sendJson(500, { ok: false, error: "stdin not writable" })
      return true
    }
    sendJson(200, { ok: true })
    return true
  }

  if (action === "meta") {
    if (cmd) {
      sendJson(200, {
        ok: true,
        data: {
          shortId: id,
          commandId: cmd.commandId,
          command: cmd.command,
          cwd: cmd.cwd,
          tabId: cmd.tabId,
          pid: cmd.pid,
          usePty: !!cmd.usePty,
          running: true,
          startedAt: cmd.timestamp,
          lastOutputAt: cmd.lastOutputAt
            ? new Date(cmd.lastOutputAt).toISOString()
            : null,
          totalLines: cmd.totalLinesEverWritten,
          firstAvailable: getFirstAvailableLine(cmd),
          exitCode: null,
        },
      })
    } else {
      sendJson(200, {
        ok: true,
        data: {
          shortId: id,
          commandId: entry.commandId,
          command: entry.command,
          tabId: entry.tabId,
          running: false,
          // Exit info / history rebuild left for a future enhancement that
          // reads the JSONL placeholder; meta on a stopped command is mostly
          // useful for confirming "this id existed".
        },
      })
    }
    return true
  }

  if (action === "wait") {
    if (!cmd) {
      sendJson(404, { ok: false, error: "Command no longer running" })
      return true
    }
    const timeoutSec = body.timeout ?? 30
    if (
      !body.pattern &&
      typeof body.idle !== "number" &&
      !body.waitExit
    ) {
      sendJson(400, {
        ok: false,
        error: "wait requires one of: pattern / idle / waitExit",
      })
      return true
    }

    const outcome = await waitForCondition(cmd.commandId, {
      pattern: body.pattern,
      idle: body.idle,
      waitExit: body.waitExit,
      timeoutSec,
      printOutput: !!body.printOutput,
    })
    sendJson(200, { ok: true, data: outcome })
    return true
  }

  sendJson(400, { ok: false, error: `Unknown action: ${action}` })
  return true
}

/**
 * Long-poll wait for one of: pattern match / output idle / process exit /
 * timeout. Subscribes to live listeners and resolves on the first event.
 * All event sources go through the same Promise so cleanup is centralised.
 */
async function waitForCondition(
  commandId: string,
  opts: {
    pattern?: string
    idle?: number
    waitExit?: boolean
    timeoutSec: number
    printOutput: boolean
  },
): Promise<{
  outcome: "pattern" | "idle" | "exit" | "timeout"
  match?: string
  exitCode?: number
  output?: string
}> {
  return new Promise((resolve) => {
    let resolved = false
    let unsubOutput: (() => void) | undefined
    let unsubExit: (() => void) | undefined
    let idleHandle: NodeJS.Timeout | undefined

    // Accumulate output text for the optional `printOutput` echo.
    const buf: string[] = []

    const cleanup = () => {
      if (unsubOutput) unsubOutput()
      if (unsubExit) unsubExit()
      clearTimeout(timeoutHandle)
      if (idleHandle) clearTimeout(idleHandle)
    }
    const finish = (result: {
      outcome: "pattern" | "idle" | "exit" | "timeout"
      match?: string
      exitCode?: number
    }) => {
      if (resolved) return
      resolved = true
      cleanup()
      const output = opts.printOutput ? buf.join("") : undefined
      resolve({ ...result, output })
    }

    let patternRe: RegExp | undefined
    if (opts.pattern) {
      try {
        patternRe = new RegExp(opts.pattern)
      } catch (e) {
        finish({ outcome: "timeout" })
        resolve({
          outcome: "timeout",
          match: `invalid regex: ${(e as Error).message}`,
        })
        return
      }
    }

    const scheduleIdle = () => {
      if (typeof opts.idle !== "number") return
      if (idleHandle) clearTimeout(idleHandle)
      idleHandle = setTimeout(
        () => finish({ outcome: "idle" }),
        opts.idle * 1000,
      )
    }

    if (patternRe || typeof opts.idle === "number" || opts.printOutput) {
      unsubOutput = addOutputListener(commandId, (data: string) => {
        if (opts.printOutput) buf.push(data)
        if (patternRe) {
          // Strip ANSI before matching so patterns don't need to fight
          // colour codes (mirrors the CLI's grep convention).
          const stripped = stripAnsiText(data)
          const lines = stripped.split("\n")
          for (const line of lines) {
            if (patternRe.test(line)) {
              finish({ outcome: "pattern", match: line })
              return
            }
          }
        }
        scheduleIdle()
      })
    }

    if (opts.waitExit) {
      unsubExit = addExitListener(commandId, (code: number) => {
        finish({ outcome: "exit", exitCode: code })
      })
    }

    // Start idle timer immediately so "5s no output ever" still resolves.
    scheduleIdle()

    // Referenced inside cleanup() via closure. The cleanup function is
    // only reachable through finish(), which is only invoked from async
    // callbacks that fire after this line — no TDZ hazard.
    const timeoutHandle: NodeJS.Timeout = setTimeout(
      () => finish({ outcome: "timeout" }),
      opts.timeoutSec * 1000,
    )
  })
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

  // F1.8 — server-side health. Never round-trips to the page; answers from
  // in-process bridge state so it works even when the page is stuck on a
  // long-running evaluate. Use `--deep` to also probe the page itself
  // (routes via the normal WS path as action `health_deep`).
  if (action === "health" && !(cmdParams as { deep?: boolean })?.deep) {
    if (!id) {
      sendJson(400, { ok: false, error: "Missing browser id" })
      return true
    }
    sendJson(200, { ok: true, data: getBrowserHealth(id) })
    return true
  }

  if (!id) {
    sendJson(400, { ok: false, error: "Missing browser id" })
    return true
  }

  const browser = getBrowserByShortId(id)
  if (!browser) {
    const all = listBrowsers().map(b => b.shortId)
    const suggestions = fuzzyTopK(id, all, 3)
    const hint = suggestions.length
      ? `\n  Did you mean: ${suggestions.join(", ")}?`
      : all.length
        ? `\n  Available: ${all.join(", ")}`
        : "\n  No browsers currently connected. Open a browser bubble in the cockpit console."
    sendJson(404, {
      ok: false,
      error: `Browser "${id}" not found.${hint}\n  Run: cockpit browser list`,
    })
    return true
  }
  if (!browser.ws || browser.ws.readyState !== WebSocket.OPEN) {
    sendJson(503, {
      ok: false,
      error:
        `Browser "${id}" is disconnected (WS closed).\n` +
        `  Recover:\n` +
        `    1. Refresh the browser tab to re-register the extension.\n` +
        `    2. Run \`cockpit browser list\` to confirm the shortId.\n` +
        `    3. If the bubble is gone, re-open it from the cockpit console panel.`,
    })
    return true
  }

  // For --deep, rewrite the action so the extension picks up `health_deep`.
  const wsAction = action === "health" ? "health_deep" : action

  const reqId = `r-${randomUUID().slice(0, 8)}`
  const sent = sendCommandToBrowser(id, reqId, wsAction, cmdParams)
  if (!sent) {
    sendJson(503, { ok: false, error: "Failed to send command (WS write failed)" })
    return true
  }

  try {
    const data = await createPendingRequest(reqId, timeout)
    sendJson(200, { ok: true, data })
  } catch (err) {
    // Timeout / browser error. Wrap with diagnostic guidance.
    const msg = (err as Error).message
    if (/timeout/i.test(msg)) {
      const h = getBrowserHealth(id)
      sendJson(504, {
        ok: false,
        error:
          `${msg} (action "${action}").\n` +
          `  Bridge state: ws=${h.ws} pending=${h.pendingCommands}` +
          (h.lastSuccessMs !== null ? ` lastSuccess=${Math.round(h.lastSuccessMs / 1000)}s ago (${h.lastSuccessAction})` : "") +
          `\n` +
          `  Diagnose:\n` +
          `    cockpit browser ${id} health                # cheap server-side probe\n` +
          `    cockpit browser ${id} wait --extension-ready (Phase 2)\n` +
          `  If the bridge state shows fresh activity, the page itself is blocked.\n` +
          `  Consider a service-level test if driven by an async LLM/agent flow.`,
      })
    } else {
      sendJson(504, { ok: false, error: msg })
    }
  }
  return true
}

// Fuzzy ranking — surfaces "evluate" → "evaluate" while filtering
// unrelated candidates. Uses character-bag overlap ratio (multiset
// intersection / max length); substring matches get a bonus. Threshold 0.6.
function fuzzyTopK(input: string, candidates: string[], k: number): string[] {
  if (!input || !candidates.length) return []
  const inputLow = input.toLowerCase()
  const bag = bagCounts(inputLow)
  const scored = candidates.map(c => {
    const cl = c.toLowerCase()
    const cBag = bagCounts(cl)
    let inter = 0
    for (const [ch, n] of bag) inter += Math.min(n, cBag.get(ch) ?? 0)
    const ratio = inter / Math.max(inputLow.length, cl.length)
    const startsWith = cl.startsWith(inputLow) ? 0.5 : 0
    const contains = cl.includes(inputLow) ? 0.3 : 0
    return { c, score: ratio + startsWith + contains }
  })
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, k).filter(s => s.score >= 0.6).map(s => s.c)
}

function bagCounts(s: string): Map<string, number> {
  const m = new Map<string, number>()
  for (const ch of s) m.set(ch, (m.get(ch) ?? 0) + 1)
  return m
}

// ─────────────────────────────────────────────────────────
// /api/connection/list — cross-type bubble enumeration with titles
//
// Aggregates terminals + browsers from the in-process bridges, joins
// user-set titles from per-tab bubble-order JSON files, and filters
// by cwd if requested. Designed for `/cc` slash mode and the
// `cockpit connection list` CLI subcommand.
// ─────────────────────────────────────────────────────────

interface ConnectionListItem {
  type: 'terminal' | 'browser'
  shortId: string
  title?: string
  projectCwd?: string
  tabId?: string
  /** Terminal: the shell command. Browser: empty — use /api/browser/info if needed. */
  command?: string
  /** Terminal: pid running? Browser: WS connected? */
  alive: boolean
}

export async function handleConnectionApi(
  req: IncomingMessage,
  res: import("http").ServerResponse
): Promise<boolean> {
  const { pathname } = parse(req.url || "", true)
  const match = pathname?.match(/^\/api\/connection\/([a-z]+)$/)
  if (!match || req.method !== "POST") return false
  if (match[1] !== "list") return false

  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  let body: { cwd?: string; all?: boolean } = {}
  try {
    body = JSON.parse(Buffer.concat(chunks).toString())
  } catch { /* empty body == list all alive */ }

  const sendJson = (status: number, data: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" })
    res.end(JSON.stringify(data))
  }

  const filterCwd = body.cwd ? resolvePath(body.cwd) : undefined
  const aliveOnly = !body.all

  // Snapshot in-process bridges (cheap, sync).
  const terms = listTerminals(getRunningCommand)
  const browsers = listBrowsers()

  // Resolve `projectCwd` from entries for cwd-match comparison.
  const sameCwd = (entryCwd: string | undefined): boolean =>
    !filterCwd ? true : !!entryCwd && resolvePath(entryCwd) === filterCwd

  // Gather (cwd, tabId) pairs that actually have bubbles, then read titles
  // for each pair exactly once. Most projects have 1 tab → 1 file read.
  // SEP = ASCII Unit Separator (0x1f) — never appears in fs paths or tabIds.
  const SEP = String.fromCharCode(0x1f)
  const cwdTabPairs = new Set<string>()
  for (const t of terms) {
    if (t.projectCwd && t.tabId) cwdTabPairs.add(`${t.projectCwd}${SEP}${t.tabId}`)
  }
  for (const b of browsers) {
    if (b.projectCwd && b.tabId) cwdTabPairs.add(`${b.projectCwd}${SEP}${b.tabId}`)
  }
  const titlesByPair = new Map<string, Record<string, string>>()
  await Promise.all(
    Array.from(cwdTabPairs).map(async (pair) => {
      const [cwd, tabId] = pair.split(SEP)
      titlesByPair.set(pair, await readBubbleTitles(cwd, tabId))
    })
  )
  const titleOf = (cwd: string | undefined, tabId: string | undefined, key: string): string | undefined => {
    if (!cwd || !tabId) return undefined
    const t = titlesByPair.get(`${cwd}${SEP}${tabId}`)?.[key]
    return t || undefined
  }

  const out: ConnectionListItem[] = []

  for (const t of terms) {
    if (!sameCwd(t.projectCwd)) continue
    if (aliveOnly && !t.running) continue
    out.push({
      type: "terminal",
      shortId: t.shortId,
      title: titleOf(t.projectCwd, t.tabId, t.commandId),
      projectCwd: t.projectCwd,
      tabId: t.tabId,
      command: t.command,
      alive: t.running,
    })
  }

  for (const b of browsers) {
    if (!sameCwd(b.projectCwd)) continue
    if (aliveOnly && !b.connected) continue
    out.push({
      type: "browser",
      shortId: b.shortId,
      title: titleOf(b.projectCwd, b.tabId, b.fullId),
      projectCwd: b.projectCwd,
      tabId: b.tabId,
      alive: b.connected,
    })
  }

  sendJson(200, { ok: true, data: out })
  return true
}
