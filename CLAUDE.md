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

- `/src/app` - Next.js App Router pages and API routes
- `/src/components` - React components
  - `FileBrowserModal.tsx` - Unified file browser with 4 tabs (Directory tree, Recent files, Git changes, Git history)
  - `TabManager.tsx` - Main tab manager component
  - `Chat.tsx` - Chat interface component
  - `ChatInput.tsx` - Chat input component
  - `console/BrowserBubble.tsx` - Browser bubble component (iframe + automation bridge)
- `/src/lib/browser` - Browser automation server-side logic
  - `BrowserBridge.ts` - shortId registry + pending request management
- `/src/hooks/useBrowserBridge.ts` - WS bridge hook for BrowserBubble
- `/chrome-extension` - Chrome extension (Manifest V3)
  - `content.js` - Content script (activated within iframes)
  - `automation.js` - Automation layer (a11y tree, DOM operations, console/network interception)
  - `background.js` - Service Worker (cookie injection, screenshots)
- `/bin` - CLI entry points
  - `cock.mjs` - Main entry (starts server, routes subcommands, --help/--version)
  - `cock-browser.mjs` - `cock browser` subcommand
  - `cock-terminal.mjs` - `cock terminal` subcommand
  - `postinstall.mjs` - Post-install fix for node-pty permissions (macOS)

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

## Project Characteristics

- **Purely local application**: All API request latency is under 10ms
- **No API caching needed**: Local requests are fast enough that caching provides negligible performance gains while introducing data consistency issues

## Claude Code Usage Guidelines

- **Browser testing**: Use `evaluate_script` for DOM manipulation; avoid `take_screenshot` (consumes excessive tokens)
- **Minimize screenshots**: Only take screenshots when visual confirmation is truly needed
- **MCP tools**: Do not use MCP tools unless the user explicitly requests it (e.g., "use xxx")
- **Git commits**: Do not auto-commit code; only commit when the user explicitly says "commit"
