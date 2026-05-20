/**
 * /api/git/commits — P8+ migration
 *
 * List commit history (pagination via offset/limit + custom format).
 */
import { exec } from "child_process"
import { promisify } from "util"
import { Effect } from "effect"
import { handler, ok } from "@cockpit/effect-runtime/server"
import { AppError } from "@cockpit/effect-core"

const execAsync = promisify(exec)

function getRelativeDate(date: Date): string {
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSec = Math.floor(diffMs / 1000)
  const diffMin = Math.floor(diffSec / 60)
  const diffHour = Math.floor(diffMin / 60)
  const diffDay = Math.floor(diffHour / 24)
  const diffWeek = Math.floor(diffDay / 7)
  const diffMonth = Math.floor(diffDay / 30)
  const diffYear = Math.floor(diffDay / 365)
  if (diffSec < 60) return "just now"
  if (diffMin < 60) return `${diffMin}m ago`
  if (diffHour < 24) return `${diffHour}h ago`
  if (diffDay < 7) return `${diffDay}d ago`
  if (diffWeek < 4) return `${diffWeek}w ago`
  if (diffMonth < 12) return `${diffMonth}mo ago`
  return `${diffYear}y ago`
}

export const GET = handler((req) =>
  Effect.gen(function* () {
    const sp = new URL(req.url).searchParams
    const cwd = sp.get("cwd") || process.cwd()
    const branch = sp.get("branch") || "HEAD"
    const limit = parseInt(sp.get("limit") || "50", 10)
    const offset = parseInt(sp.get("offset") || "0", 10)

    const format = "%H%x00%h%x00%an%x00%ae%x00%ci%x00%s%x00%b%x01"
    const skipArg = offset > 0 ? `--skip=${offset}` : ""

    const stdout = yield* Effect.tryPromise({
      try: () =>
        execAsync(
          `git -c core.quotePath=false log ${branch} --format="${format}" -n ${limit} ${skipArg}`,
          { cwd, maxBuffer: 10 * 1024 * 1024 }
        ).then((r) => r.stdout),
      catch: (cause) =>
        new AppError({ message: "git log failed", cause }),
    })

    const commits = stdout
      .split("\x01")
      .filter(Boolean)
      .map((record) => {
        const parts = record.trim().split("\x00")
        const [
          hash,
          shortHash,
          author,
          authorEmail,
          date,
          subject,
          body = "",
        ] = parts
        return {
          hash,
          shortHash,
          author,
          authorEmail,
          date,
          subject,
          body: body.trim(),
          relativeDate: getRelativeDate(new Date(date)),
        }
      })

    return ok({ commits })
  }).pipe(Effect.withSpan("api.git.commits"))
)
