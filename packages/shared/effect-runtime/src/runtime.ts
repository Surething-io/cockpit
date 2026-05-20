/**
 * Runtime composition — browser-safe entry.
 *
 * Contains only browser-safe Layers/Runtimes.
 * The server-side AppRuntime lives in ./server/runtime.ts (server-only, pulls
 * in ioredis/pg, etc.).
 *
 * Business code:
 *  - Browser components: `import { BrowserRuntime } from "@cockpit/effect-runtime"`
 *  - Server code: `import { AppRuntime } from "@cockpit/effect-runtime/server"`
 *
 * For backward compatibility with existing handler templates
 * (`@cockpit/effect-runtime` exports `AppRuntime`), this file also re-exports
 * AppRuntime/AppLayer as a server-only convenience. In practice the Next.js
 * client bundle never walks this path (handlers are imported only on the
 * server side).
 */
import { Effect, Layer, ManagedRuntime } from "effect"
import {
  LoggerLivePretty,
  TracerLivePretty,
  ConfigLive,
} from "@cockpit/effect-core"
import { IframeBusLive } from "./browser/iframeBusLive"

// ─────────────────────────────────────────────────────────
// Browser base Layer
// ─────────────────────────────────────────────────────────

const BrowserBaseLayer = Layer.mergeAll(
  LoggerLivePretty,
  TracerLivePretty,
  ConfigLive
)

export const BrowserLayer = Layer.mergeAll(BrowserBaseLayer, IframeBusLive)

export type BrowserContext = Layer.Layer.Success<typeof BrowserLayer>

export const BrowserRuntime = ManagedRuntime.make(BrowserLayer)

// ─────────────────────────────────────────────────────────
// Server-side re-exports
// ─────────────────────────────────────────────────────────
//
// These are reached through dynamic import in a server context so turbopack
// does not pull server-only dependencies (pg/ioredis/neo4j-driver) into the
// client bundle.
//
// Handler / API route files are server-only, so such a dynamic import never
// appears in their import chain. The actual server entry point should
// `import "@cockpit/effect-runtime/server"` directly.
// ─────────────────────────────────────────────────────────

export type { AppContext } from "./server/runtime"

// Instantiation is server-only — the Next.js client bundle never executes
// server-only files, but type-only imports are safe. Code that actually uses
// AppRuntime (handlers / API routes) should import it from ./server.

// ─────────────────────────────────────────────────────────
// Process shutdown helpers
// ─────────────────────────────────────────────────────────

export const disposeBrowserRuntime = async (): Promise<void> => {
  await BrowserRuntime.dispose()
}

// Reference Effect so TS does not flag the import as unused.
const _keepEffectImport = Effect.void
void _keepEffectImport
