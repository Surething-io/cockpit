/**
 * Client-side ProjectService — browser-side calls /api/projects via fetch.
 *
 * Decoupled from the ProjectService in server/effect/project.ts:
 * - server reads fs directly (ProjectServiceLive)
 * - client goes over HTTP (this file)
 *
 * A later phase can merge both into a single ProjectService Tag with two Live implementations.
 */
import { Effect } from "effect"
import { AppError } from "@cockpit/effect-core"
import type { ProjectsData } from "../../server/effect/project"

/** Browser fetch wrapper; failures are uniformly mapped to AppError. */
export const fetchProjects: Effect.Effect<ProjectsData, AppError> =
  Effect.tryPromise({
    try: async () => {
      const res = await fetch("/api/projects")
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
      return (await res.json()) as ProjectsData
    },
    catch: (cause) =>
      new AppError({ message: "fetch /api/projects failed", cause }),
  })

export const saveProjects = (
  data: ProjectsData
): Effect.Effect<void, AppError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data),
      })
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
    },
    catch: (cause) =>
      new AppError({ message: "save /api/projects failed", cause }),
  })
