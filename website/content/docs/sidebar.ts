/**
 * Single source of truth for the docs sidebar.
 *
 * - `slug` is the URL segment under `/[locale]/docs/`. Use `/`-joined paths
 *   like `get-started/quickstart`. Matching Markdown file lives at
 *   `website/content/docs/<slug>.<locale>.md`.
 * - `available: true` means the Markdown file exists and the link is
 *   clickable. `available: false` renders a greyed-out label ("Coming soon")
 *   so the full information architecture is visible without 404ing.
 * - Section keys (`getStarted`, `agent`, ...) match i18n labels in
 *   `website/content/messages.ts` under `docs.sidebar.sections`.
 * - Top-level structure mirrors the product UI: the "workspace shell"
 *   (project sidebar + top bar) is its own section; then the three swipeable
 *   panels (Agent / Explorer / Console); then a reference section for things
 *   that live outside the running app (CLI, Chrome extension, shortcuts, FAQ).
 */

import type { Locale } from '@/lib/i18n';

export interface DocPage {
  slug: string;
  /** Translation key under `docs.sidebar.pages.<key>` */
  labelKey: string;
  /** Whether the Markdown file has been written. Greyed out when false. */
  available: boolean;
}

export interface DocGroup {
  /** Translation key under `docs.sidebar.groups.<key>` */
  key: string;
  pages: DocPage[];
}

export interface DocSection {
  /** Translation key under `docs.sidebar.sections.<key>` */
  key: string;
  /** Pages directly under the section (no sub-group). */
  pages?: DocPage[];
  /** Optional sub-groups, rendered with their own group heading. */
  groups?: DocGroup[];
}

export const docsSidebar: DocSection[] = [
  // ─── 1. Onboarding ─────────────────────────────────────────────────
  {
    key: 'getStarted',
    pages: [
      // Get Started is two pages: a "what is this" intro (introduction)
      // and a "from npm install to a real task" quickstart that absorbs
      // what used to be three separate pages (installation, quickstart,
      // your-first-session). Splitting them just made readers jump around
      // — the install steps and the realistic walkthrough belong together.
      { slug: 'get-started/introduction', labelKey: 'introduction', available: true },
      { slug: 'get-started/quickstart', labelKey: 'quickstart', available: true },
    ],
  },

  // ─── 2. Panel 1: Agent (chat) ─────────────────────────────────────
  // The "workspace shell" section is gone — notes / skills lived there but
  // were really Agent-adjacent (notes pair with a chat tab; skills are
  // slash commands). Folding them in collapsed one extra navigation layer.
  {
    key: 'agent',
    pages: [
      // Order follows the user's discovery path: type a message → realise
      // there are multiple tabs → enrich with slash commands → install
      // Skills → pick an engine → automate → take side notes.
      { slug: 'agent/message-input', labelKey: 'messageInput', available: true },
      { slug: 'agent/sessions', labelKey: 'sessions', available: true },
      // "Slash Commands" and "Skills" are unified — both are Skills now.
      // Five are built in (the AI modes /qa /fx /ex /go /cg); users add more
      // by installing SKILL.md files. Same `/` menu, same docs page.
      { slug: 'agent/skills', labelKey: 'skills', available: true },
      { slug: 'agent/engines', labelKey: 'engines', available: true },
      { slug: 'agent/scheduled-tasks', labelKey: 'scheduledTasks', available: true },
      { slug: 'agent/notes', labelKey: 'notes', available: true },
    ],
  },

  // ─── 4. Panel 2: Explorer (files + code) ──────────────────────────
  // Explorer's 5 modules mirror the actual top-tab structure of the panel:
  // File Tree (the default file browser + per-file viewers + inline comments),
  // Search (Cmd+P + LSP + Code Map + CodeGraph — every "find code" entry),
  // Recent (last-accessed file stack),
  // Changes (Status tab + Diff View),
  // History (commit log + Branches + Worktrees + Blame).
  // Tech-plan Reviews live here too — they're shared/anchored views of
  // Markdown files in the project, which is an Explorer-side surface.
  // Each used to be a `group/` of 2-4 sub-pages; consolidated into one page
  // per module with anchored sections, same pattern as cli / databases /
  // engines / chrome-extension.
  {
    key: 'explorer',
    pages: [
      { slug: 'explorer/file-tree', labelKey: 'fileTree', available: true },
      { slug: 'explorer/search', labelKey: 'search', available: true },
      { slug: 'explorer/recent', labelKey: 'recent', available: true },
      { slug: 'explorer/changes', labelKey: 'changes', available: true },
      { slug: 'explorer/history', labelKey: 'history', available: true },
      { slug: 'explorer/reviews', labelKey: 'reviews', available: true },
    ],
  },

  // ─── 5. Panel 3: Console (terminal + bubbles) ─────────────────────
  // `databases` was a 4-page group (postgresql/mysql/redis/neo4j); collapsed
  // to a single "Database Bubbles" page with each engine becoming an anchored
  // `##` section — same rationale as the CLI / Chrome-extension consolidations.
  // The Chrome extension lives here because it's specifically what turns
  // Browser bubbles into real-Chrome-driving bubbles — Console-adjacent.
  {
    key: 'console',
    pages: [
      { slug: 'console/input-bar', labelKey: 'inputBar', available: true },
      { slug: 'console/terminal', labelKey: 'terminalBubble', available: true },
      { slug: 'console/browser', labelKey: 'browserBubble', available: true },
      { slug: 'console/databases', labelKey: 'databases', available: true },
      { slug: 'console/jupyter', labelKey: 'jupyterBubble', available: true },
      { slug: 'console/aliases-env', labelKey: 'aliasesEnv', available: true },
      { slug: 'console/chrome-extension', labelKey: 'chromeExtension', available: true },
    ],
  },

  // ─── 6. Reference (everything outside the running app) ────────────
  // Three flat reference docs: CLI (the cock/cockpit binary surface),
  // keyboard shortcuts, and the FAQ.
  // `chrome-extension` moved to Console (it's what powers Browser bubbles),
  // and `reviews` moved to Explorer (it's a Markdown-file-anchored surface).
  {
    key: 'reference',
    pages: [
      { slug: 'reference/cli', labelKey: 'cli', available: true },
      { slug: 'reference/keyboard-shortcuts', labelKey: 'keyboardShortcuts', available: true },
      { slug: 'reference/faq', labelKey: 'faq', available: true },
    ],
  },
];

/** Iterate every page in the sidebar, flat. Skips `available: false`. */
export function getAvailablePages(): DocPage[] {
  const out: DocPage[] = [];
  for (const section of docsSidebar) {
    for (const p of section.pages ?? []) if (p.available) out.push(p);
    for (const g of section.groups ?? []) {
      for (const p of g.pages) if (p.available) out.push(p);
    }
  }
  return out;
}

/** The first available page anywhere in the sidebar. Used by `/docs/`
 *  to redirect to a sensible landing spot (currently "Introduction"). */
export function getFirstAvailablePage(): DocPage | undefined {
  return getAvailablePages()[0];
}

/** Look up a page by slug. Returns undefined when the slug is unknown or
 *  the page is marked unavailable. */
export function findPageBySlug(slug: string): DocPage | undefined {
  return getAvailablePages().find((p) => p.slug === slug);
}

/** Adjacent previous/next pages in sidebar order, for the footer pager.
 *  Skips unavailable pages so users never land on a "coming soon" link. */
export function getAdjacentPages(slug: string): {
  prev?: DocPage;
  next?: DocPage;
} {
  const pages = getAvailablePages();
  const idx = pages.findIndex((p) => p.slug === slug);
  if (idx < 0) return {};
  return {
    prev: idx > 0 ? pages[idx - 1] : undefined,
    next: idx < pages.length - 1 ? pages[idx + 1] : undefined,
  };
}

/** Build a localised URL for a docs page. */
export function docsHref(locale: Locale, slug: string): string {
  return `/${locale}/docs/${slug}/`;
}
