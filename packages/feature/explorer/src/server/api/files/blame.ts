/**
 * /api/files/blame — P8+ migration
 *
 * Parses git blame --porcelain output and batch-fetches the full commit messages.
 * Process-level semaphore (max 3 concurrent) prevents large repos from blocking the event loop.
 */
import { exec } from "child_process"
import { promisify } from "util"
import { Effect } from "effect"
import { handler, ok } from "@cockpit/effect-runtime/server"
import { AppError, ValidationError } from "@cockpit/effect-core"

const execAsync = promisify(exec)
const GIT_TIMEOUT_MS = 15000
const MAX_CONCURRENT = 3
let activeCount = 0
const waitQueue: Array<() => void> = []

function acquireSlot(): Promise<void> {
  return new Promise((resolve) => {
    if (activeCount < MAX_CONCURRENT) {
      activeCount++
      resolve()
    } else {
      waitQueue.push(() => {
        activeCount++
        resolve()
      })
    }
  })
}

function releaseSlot(): void {
  activeCount--
  const next = waitQueue.shift()
  if (next) next()
}

interface BlameLine {
  hash: string
  hashFull: string
  author: string
  authorEmail: string
  time: number
  message: string
  line: number
  content: string
}

interface CommitInfo {
  author: string
  authorEmail: string
  time: number
  message: string
}

export const GET = handler((req) =>
  Effect.gen(function* () {
    const sp = new URL(req.url).searchParams
    const cwd = sp.get("cwd")
    const path = sp.get("path")

    if (!cwd || !path) {
      return yield* Effect.fail(
        new ValidationError({
          field: !cwd ? "cwd" : "path",
          reason: "missing",
        })
      )
    }

    const blame = yield* Effect.acquireUseRelease(
      Effect.promise(() => acquireSlot()),
      () =>
        Effect.tryPromise({
          try: async () => {
            const { stdout } = await execAsync(
              `git -c core.quotePath=false blame --porcelain "${path}"`,
              {
                cwd,
                maxBuffer: 10 * 1024 * 1024,
                timeout: GIT_TIMEOUT_MS,
              }
            )

            const lines = stdout.split("\n")
            const commitInfoMap = new Map<string, CommitInfo>()
            let currentHashFull = ""
            let currentAuthor = ""
            let currentAuthorEmail = ""
            let currentTime = 0

            for (const line of lines) {
              if (/^[0-9a-f]{40}/.test(line)) {
                currentHashFull = line.split(" ")[0]
              } else if (line.startsWith("author ")) {
                currentAuthor = line.substring(7)
              } else if (line.startsWith("author-mail ")) {
                const match = line.substring(12).match(/<(.+)>/)
                currentAuthorEmail = match ? match[1] : line.substring(12)
              } else if (line.startsWith("author-time ")) {
                currentTime = parseInt(line.substring(12), 10)
              } else if (
                line.startsWith("\t") &&
                currentHashFull &&
                !commitInfoMap.has(currentHashFull)
              ) {
                commitInfoMap.set(currentHashFull, {
                  author: currentAuthor,
                  authorEmail: currentAuthorEmail,
                  time: currentTime,
                  message: "",
                })
              }
            }

            const ZERO_HASH =
              "0000000000000000000000000000000000000000"
            const uncommittedInfo = commitInfoMap.get(ZERO_HASH)
            if (uncommittedInfo) {
              uncommittedInfo.message = "Not Committed Yet"
            }
            const uniqueHashes = Array.from(commitInfoMap.keys()).filter(
              (h) => h !== ZERO_HASH
            )
            if (uniqueHashes.length > 0) {
              const { stdout: logOutput } = await execAsync(
                `git -c core.quotePath=false log --format="%H%x00%B%x00" --no-walk ${uniqueHashes.join(" ")}`,
                {
                  cwd,
                  maxBuffer: 10 * 1024 * 1024,
                  timeout: GIT_TIMEOUT_MS,
                }
              )
              const logParts = logOutput.split("\0").filter(Boolean)
              for (let i = 0; i < logParts.length; i += 2) {
                const hash = logParts[i]?.trim()
                const message = logParts[i + 1]?.trim() || ""
                if (hash && commitInfoMap.has(hash)) {
                  commitInfoMap.get(hash)!.message = message
                }
              }
            }

            const blameLines: BlameLine[] = []
            currentHashFull = ""
            let lineNumber = 0
            for (const line of lines) {
              if (/^[0-9a-f]{40}/.test(line)) {
                const parts = line.split(" ")
                currentHashFull = parts[0]
                lineNumber = parseInt(parts[2], 10)
              } else if (line.startsWith("\t")) {
                const info = commitInfoMap.get(currentHashFull)
                if (info) {
                  blameLines.push({
                    hash: currentHashFull.substring(0, 7),
                    hashFull: currentHashFull,
                    author: info.author,
                    authorEmail: info.authorEmail,
                    time: info.time,
                    message: info.message,
                    line: lineNumber,
                    content: line.substring(1),
                  })
                }
              }
            }
            return blameLines
          },
          catch: (cause) =>
            new AppError({
              message:
                "Failed to get blame info. File may not be tracked by git.",
              cause,
            }),
        }),
      () => Effect.sync(() => releaseSlot())
    )

    return ok({ blame })
  })
)
