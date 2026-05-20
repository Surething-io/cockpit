/**
 * /api/jupyter/save — P8+ migration
 */
import { readFile, writeFile } from "fs/promises"
import { join, isAbsolute } from "path"
import { Effect } from "effect"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { FSError, ValidationError } from "@cockpit/effect-core"

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as {
      filePath?: string
      cwd?: string
      cells?: Record<string, unknown>[]
    }
    if (!body.filePath || !body.cells) {
      return yield* Effect.fail(
        new ValidationError({
          field: !body.filePath ? "filePath" : "cells",
          reason: "missing",
        })
      )
    }
    const { filePath, cwd, cells } = body
    const fullPath = isAbsolute(filePath)
      ? filePath
      : join(cwd || process.cwd(), filePath)

    yield* Effect.tryPromise({
      try: async () => {
        let notebook: Record<string, unknown>
        try {
          const content = await readFile(fullPath, "utf-8")
          notebook = JSON.parse(content)
        } catch {
          notebook = {
            nbformat: 4,
            nbformat_minor: 2,
            metadata: {
              kernelspec: {
                display_name: "Python 3",
                language: "python",
                name: "python3",
              },
              language_info: { name: "python" },
            },
            cells: [],
          }
        }

        notebook.cells = cells.map((cell) => {
          const source = (cell.source as string) || ""
          const cellType = cell.cell_type as string
          const base: Record<string, unknown> = {
            cell_type: cellType,
            source: source.split("\n").map((line, i, arr) =>
              i < arr.length - 1 ? line + "\n" : line
            ),
            metadata: cell.metadata || {},
          }
          if (cellType === "code") {
            base.execution_count = cell.execution_count ?? null
            base.outputs = cell.outputs || []
          }
          return base
        })

        await writeFile(
          fullPath,
          JSON.stringify(notebook, null, 1) + "\n",
          "utf-8"
        )
      },
      catch: (cause) =>
        new FSError({ path: fullPath, op: "write", cause }),
    })

    return ok({ ok: true })
  })
)
