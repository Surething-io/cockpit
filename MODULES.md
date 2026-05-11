# Cockpit Module Boundaries

> Goal: features can be added, removed, or replaced freely; while AI works on
> a specific feature it only needs to load that feature's package; the code
> inside each feature is cohesive.

## Layout

```
cockpit/
├── src/
│   ├── app/                    Next.js routing (page.tsx + layout.tsx +
│   │                           one-line route.ts shims)
│   └── lib/                    Server bootstrap (wsServer, fileWatcher)
├── packages/
│   ├── shared/<name>/          Cross-feature reusable infrastructure (UI
│   │                           primitives, utils, i18n dictionary)
│   └── feature/<name>/         Self-contained feature (client + server)
├── bin/                        CLI entry points
└── chrome-extension/           Chrome extension (independent sub-project)
```

`src/` is intentionally minimal — only Next.js framework code and server
bootstrap. **All business code lives in `packages/`.**

## Package inventory

| Folder                            | Package name                  | Role |
|-----------------------------------|-------------------------------|------|
| `packages/shared/i18n/`           | `@cockpit/shared-i18n`        | App-wide translation dictionary + i18next instance (singleton, side-effecting init) |
| `packages/shared/ui/`             | `@cockpit/shared-ui`          | UI primitives (Toast, MarkdownRenderer, Tooltip, codeHighlighter, …) + generic React hooks |
| `packages/shared/utils/`          | `@cockpit/shared-utils`       | Pure functions / types (paths, ollamaEnv, platform, shortId) |
| `packages/feature/agent/`         | `@cockpit/feature-agent`      | Chat domain: API + UI + state + scheduled tasks + slash commands |
| `packages/feature/comments/`      | `@cockpit/feature-comments`   | Code annotation API + hooks + list modal |
| `packages/feature/console/`       | `@cockpit/feature-console`    | Terminal + browser bubbles + DB bubbles |
| `packages/feature/explorer/`      | `@cockpit/feature-explorer`   | File browser + code rendering (DiffView, CodeViewer, MarkdownPreview) + git + LSP |
| `packages/feature/review/`        | `@cockpit/feature-review`     | Review pages + identity (ARP MAC) + comment threads |
| `packages/feature/skills/`        | `@cockpit/feature-skills`     | SKILL.md parser + slash autocomplete + cross-frame bus |
| `packages/feature/workspace/`     | `@cockpit/feature-workspace`  | Integrator feature — consumes all other features; mounted by Next.js `src/app/page.tsx`. Contains Workspace + TabManager + Providers + cross-feature modals. There is no `apps/` directory; the integrator lives as a feature package. |

The `shared-` and `feature-` prefixes MUST stay in the package name.
`@cockpit/shared-*` instantly signals "infrastructure, safe to depend on";
`@cockpit/feature-*` instantly signals "domain code".

## Dependency rules (2 layers)

```
src/  ──→  packages/feature/*  ──→  packages/shared/*
                ↘                        ↗
              packages/feature/* (acyclic)
```

- ✅ `src/` may depend on `@cockpit/feature-*` and `@cockpit/shared-*`
- ✅ `packages/feature/*` may depend on `@cockpit/shared-*`
- ✅ `packages/feature/*` may depend on **other** `@cockpit/feature-*` —
   the **supporting subdomain** pattern (e.g. `feature-agent` uses
   `feature-explorer` for code rendering, `feature-explorer` uses
   `feature-comments` for annotation hooks). Cycles are forbidden but ESLint
   currently enforces this only via the natural acyclic shape — there is no
   automated cycle check.
- ✅ `packages/shared/*` may depend on other `packages/shared/*`
- ❌ `packages/shared/*` MUST NOT depend on `@cockpit/feature-*` (ESLint
   enforced — shared is the leaf layer)
- ❌ Nothing depends on `src/`

By convention, `feature-workspace` is the **only** feature that consumes
many other features (it's the integrator). Other features should pull
another feature in only when there's a clear "supporting subdomain"
relationship.

## Current feature dependency graph (acyclic)

```
feature-workspace  ──→  all features
feature-agent      ──→  feature-comments, feature-skills, feature-explorer
feature-explorer   ──→  feature-comments
feature-review     ──→  feature-comments
feature-skills     ──→  (none)
feature-comments   ──→  (none)
feature-console    ──→  (none)
```

When adding a feature → feature dependency, double-check this graph stays
acyclic.

## i18n

`@cockpit/shared-i18n` owns the entire translation dictionary
(`locales/{en,zh}.json`) and the configured `i18next` singleton. Any package
imports it directly:

```ts
import i18n from '@cockpit/shared-i18n';
i18n.t('chat.welcome');
i18n.t('confirm.title', { defaultValue: 'Confirm' });

// React:
import { useTranslation } from 'react-i18next';
const { t } = useTranslation();   // picks up the same global instance
```

The package's `sideEffects: ["./src/index.ts"]` declaration is
**critical** — it prevents the init call from being tree-shaken away.

There is no IoC slot. No translator injection. Any package needing
localized strings imports the shared dictionary directly.

## Adding a feature

1. Create `packages/feature/<new-name>/` mirroring an existing feature's
   `package.json` shape:
   ```json
   {
     "name": "@cockpit/feature-<new-name>",
     "version": "0.0.0",
     "private": true,
     "exports": {
       ".":          "./src/client/index.ts",
       "./server":   "./src/server/index.ts",
       "./server/*": "./src/server/*.ts"
     },
     "sideEffects": false
   }
   ```
2. Add `"@cockpit/feature-<new-name>": "*"` to root `package.json`
   `dependencies` (alphabetical order).
3. `npm install --include=dev` to wire the workspace symlink.
4. Add panel/component imports to `feature-workspace` (or wherever the new
   feature plugs in).
5. For each API route, create a one-line shim at
   `src/app/api/<route>/route.ts`:
   ```ts
   export * from '@cockpit/feature-<new-name>/server/api/<route>';
   ```
   The handler logic lives in
   `packages/feature/<new-name>/src/server/api/<route>.ts`.

## Removing a feature

1. `rm -rf packages/feature/<name>/`
2. `rm -rf src/app/api/<name>/` (if all routes belong to that feature)
3. Remove the dep entry from root `package.json`.
4. Remove imports from `feature-workspace` (or wherever it was plugged in).
5. `npm install` then `tsc --noEmit` — fix any stragglers.

## Route shim convention

Each `src/app/api/**/route.ts` is exactly one line:

```ts
export * from '@cockpit/feature-<x>/server/api/<route>';
```

Special handler-name conventions for Next.js dynamic segments (because
`[param]` cannot appear in package paths):

| Next.js path                                | Package handler file                                    |
|---------------------------------------------|---------------------------------------------------------|
| `api/review/route.ts`                       | `feature-review/server/api/index.ts`                    |
| `api/review/[id]/route.ts`                  | `feature-review/server/api/by-id.ts`                    |
| `api/review/[id]/comments/route.ts`         | `feature-review/server/api/by-id-comments.ts`           |
| `api/review/[id]/replies/route.ts`          | `feature-review/server/api/by-id-replies.ts`            |
| `api/sessions/projects/[encodedPath]/route.ts` | `feature-agent/server/api/sessions/project-encoded.ts` |
| `api/session/[sessionId]/fork/route.ts`     | `feature-agent/server/api/session/fork.ts`              |
| `api/session/[sessionId]/history/route.ts`  | `feature-agent/server/api/session/history.ts`           |

The shim layer exists because Next.js requires `route.ts` files under
`src/app/`.

## Handler API contract

Handler files (`packages/feature/*/src/server/api/*.ts`) use **Web standard
`Request` / `Response`**, not Next.js's `NextRequest` / `NextResponse`. This
keeps handlers framework-agnostic so the same code can mount on Next.js
today and on Hono / Fastify / Bun.serve / Deno / Cloudflare Workers
tomorrow.

```ts
// Required handler shape
export const runtime = 'nodejs';            // Next.js mount metadata
export const dynamic = 'force-dynamic';     // Next.js mount metadata

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const cwd = searchParams.get('cwd');
  if (!cwd) return Response.json({ error: 'missing cwd' }, { status: 400 });
  // ...
  return Response.json({ ok: true });
}
```

For dynamic routes, the second arg is a Next.js context object. **It's
Next-specific**, but the handler still receives a standard `Request` as
the first arg:

```ts
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return Response.json({ id });
}
```

Common patterns to follow:

| ❌ Don't                                       | ✅ Do                                              |
|------------------------------------------------|---------------------------------------------------|
| `import { NextRequest, NextResponse } from 'next/server'` | (no import — `Request` / `Response` are global)   |
| `request.nextUrl.searchParams`                 | `new URL(request.url).searchParams`               |
| `NextResponse.json(data, { status: 400 })`     | `Response.json(data, { status: 400 })`            |
| `new NextResponse(stream, { headers })`        | `new Response(stream, { headers })`               |

The `runtime` / `dynamic` exports are Next.js mount metadata — they
configure how Next.js attaches the handler. They don't affect the handler
function's portability; a future Hono adapter just ignores these exports
and reads `GET` / `POST` / etc. directly.

## Page component convention

Page-level files (`src/app/**/page.tsx`, `layout.tsx`) are real shell
code. They typically import the mounted component from a feature package:

```tsx
// src/app/page.tsx
import { Workspace } from '@cockpit/feature-workspace';
export default function Home() { return <Workspace />; }
```

```tsx
// src/app/review/[id]/page.tsx
import { ReviewPage } from '@cockpit/feature-review';
export default function ReviewRoute({ params }) {
  return <ReviewPage reviewId={params.id} />;
}
```

There is no centralized "app/" intermediary. Each page mounts its feature
directly.

## Shim integrity audit

Run periodically (or in CI) to catch the "handler exists but no shim
mounts it" bug:

```bash
# 1. orphan handlers (no shim points to them)
find packages -path "*/server/api/*.ts" -type f | while read h; do
  case "$h" in *chat/ollama/{model,session,stream,tools,types}.ts) continue ;; esac
  import_path=$(echo "$h" | sed 's|packages/feature/|@cockpit/feature-|; s|/src/server/api/|/server/api/|; s|\.ts$||')
  grep -rq "$import_path" src/app/api 2>/dev/null || echo "ORPHAN: $h"
done

# 2. broken shims (shim points to missing handler)
find src/app/api -name "route.ts" -type f | while read shim; do
  target=$(grep -oE "@cockpit/feature-[a-z-]+/server/api/[a-zA-Z0-9/-]+" "$shim" | head -1)
  [ -z "$target" ] && continue
  file=$(echo "$target" | sed 's|@cockpit/feature-|packages/feature/|; s|/server/api/|/src/server/api/|').ts
  [ -f "$file" ] || echo "BROKEN: $shim → $target"
done
```

This catches issues that tsc/lint don't (a shim placed in the wrong
directory still lints, but Next.js never sees it).

## When to introduce a third level of nesting

- `packages/shared/` exceeds ~10 packages → split by capability type.
- Until then, keep the layout flat.
- `packages/feature/` follows the same rule.
