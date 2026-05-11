# The Cockpit That Drives AI

## Development

- **Dev Server Port**: 3456 (run `npm run dev`)
- **Tech Stack**: Next.js 16, React, TypeScript, TailwindCSS

## UI Layout

- **Three-panel swipe mode**: Uses `SwipeableViewContainer` (translateX) to place three panels side by side, with left/right swipe to switch:
  - Panel 1 **Agent** (Chat)
  - Panel 2 **Explorer** (File browser)
  - Panel 3 **Console** (Terminal + browser bubbles)
- **All three panels are always rendered simultaneously**; switching panels is just a CSS transform translation — components are never unmounted/remounted
- **UI component considerations**: When building menus, modals, and floating popovers, be mindful of the three-panel layout:
  - Positioning calculations must account for the boundaries of the current panel
  - z-index levels must be managed consistently
  - Prevent components from overflowing into adjacent panels

## Project Structure

Business code lives in `packages/`; `src/` is intentionally minimal
framework boot. See `MODULES.md` for the dependency rules.

- `/src/app/` - Next.js routing only (page.tsx + layout.tsx + one-line
  `route.ts` shims that re-export from feature packages)
- `/src/lib/` - Server bootstrap: `wsServer.ts` (WS server),
  `fileWatcher.ts` (fs watcher)
- `/packages/feature/` - Self-contained domain features:
  - `agent/` - Chat domain (Claude/Ollama/Codex/Kimi/Deepseek), scheduled
    tasks, slash commands, sidebar panels
  - `comments/` - Code annotation API + hooks
  - `console/` - Terminal + browser bubbles + DB bubbles (Postgres / MySQL
    / Redis / Neo4j / MongoDB / Bash / Jupyter)
  - `explorer/` - File browser + code rendering (DiffView, CodeViewer,
    InteractiveMarkdownPreview, PreviewModal) + git + LSP
  - `review/` - Review pages with anchored highlights and threaded comments
  - `skills/` - SKILL.md parser + slash autocomplete + cross-frame bus
  - `workspace/` - Application integrator (Workspace, TabManager,
    Providers, SettingsModal, NoteModal, SessionBrowser)
- `/packages/shared/` - Cross-feature infrastructure:
  - `i18n/` - Translation dictionary + i18next singleton
  - `ui/` - UI primitives (Toast, MarkdownRenderer, Tooltip,
    codeHighlighter, Swipeable*, useViMode, useWebSocket, …)
  - `utils/` - Pure utilities (paths, ollamaEnv, platform, shortId)
- `/chrome-extension/` - Chrome extension (Manifest V3, independent
  sub-project)
- `/bin/` - CLI entry points (`cock.mjs`, `postinstall.mjs`)

## Key Features

- File browser with virtual scrolling and syntax highlighting (Shiki)
- Git status and history integration
- Git blame view
- Code search with Cmd+F (case sensitive / whole word matching)
- ESC key exits blame view first, then closes modal (3s debounce)

## Commands

```bash
npm run dev      # Start dev server on port 3456
npm run build    # Build for production
npm run setup    # Build + npm link
npm run lint     # Run ESLint
cock             # Start production server (port 3457)
cock -v          # Show version
```

## npm Publish

Publishing is done via GitHub Actions — **never publish locally with `npm publish`**.

```bash
npm version patch          # Bump version (patch/minor/major)
git push origin main       # Push commit
git push origin v<version> # Push tag → triggers CI publish
```

The `v*` tag push triggers `.github/workflows/publish.yml` which:
1. Builds the project
2. Publishes to npm (`@surething/cockpit`) with provenance
3. Creates a GitHub Release with auto-generated notes

## Project Characteristics

- **Purely local application**: All API request latency is under 10ms
- **No API caching needed**: Local requests are fast enough that caching provides negligible performance gains while introducing data consistency issues

## Claude Code Usage Guidelines

- **Browser testing**: Use `evaluate_script` for DOM manipulation; avoid `take_screenshot` (consumes excessive tokens)
- **Minimize screenshots**: Only take screenshots when visual confirmation is truly needed
- **MCP tools**: Do not use MCP tools unless the user explicitly requests it (e.g., "use xxx")
- **Git commits**: Do not auto-commit code; only commit when the user explicitly says "commit"
