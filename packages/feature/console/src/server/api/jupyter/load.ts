/**
 * /api/jupyter/load — P8+ migration
 */
import { readFile, writeFile, access } from "fs/promises"
import { join, isAbsolute } from "path"
import { Effect } from "effect"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { FSError, ValidationError } from "@cockpit/effect-core"

function emptyNotebook() {
  return {
    nbformat: 4,
    nbformat_minor: 2,
    metadata: {
      kernelspec: {
        display_name: "Python 3",
        language: "python",
        name: "python3",
      },
      language_info: { name: "python", version: "3.x" },
    },
    cells: [] as Record<string, unknown>[],
  }
}

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as {
      filePath?: string
      cwd?: string
    }
    if (!body.filePath) {
      return yield* Effect.fail(
        new ValidationError({ field: "filePath", reason: "missing" })
      )
    }
    const { filePath, cwd } = body
    const fullPath = isAbsolute(filePath)
      ? filePath
      : join(cwd || process.cwd(), filePath)

    const result = yield* Effect.tryPromise({
      try: async () => {
        let notebook: Record<string, unknown>
        let created = false
        try {
          await access(fullPath)
          const content = await readFile(fullPath, "utf-8")
          const trimmed = content.trim()
          if (!trimmed) {
            notebook = emptyNotebook()
            await writeFile(
              fullPath,
              JSON.stringify(notebook, null, 1) + "\n",
              "utf-8"
            )
            created = true
          } else {
            notebook = JSON.parse(trimmed)
          }
        } catch (err) {
          if (
            err instanceof Error &&
            "code" in err &&
            (err as NodeJS.ErrnoException).code === "ENOENT"
          ) {
            notebook = emptyNotebook()
            await writeFile(
              fullPath,
              JSON.stringify(notebook, null, 1) + "\n",
              "utf-8"
            )
            created = true
          } else if (err instanceof SyntaxError) {
            notebook = emptyNotebook()
            await writeFile(
              fullPath,
              JSON.stringify(notebook, null, 1) + "\n",
              "utf-8"
            )
            created = true
          } else {
            throw err
          }
        }
        const nbformat = (notebook.nbformat as number) || 4
        const metadata =
          (notebook.metadata as Record<string, unknown>) || {}
        const kernelspec =
          (metadata.kernelspec as Record<string, unknown>) || {}
        const cells = (
          (notebook.cells as Record<string, unknown>[]) || []
        ).map((cell, idx) => ({
          index: idx,
          cell_type: cell.cell_type as string,
          source: Array.isArray(cell.source)
            ? (cell.source as string[]).join("")
            : ((cell.source as string) || ""),
          outputs: cell.outputs || [],
          execution_count: cell.execution_count ?? null,
          metadata: cell.metadata || {},
        }))
        return {
          nbformat,
          metadata,
          kernelspec,
          cells,
          filePath: fullPath,
          created,
        }
      },
      catch: (cause) =>
        new FSError({ path: fullPath, op: "read", cause }),
    })

    return ok(result)
  })
)
