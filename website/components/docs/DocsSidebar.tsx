'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { getMessages } from '@/content/messages';
import type { Locale } from '@/lib/i18n';
import {
  docsSidebar,
  docsHref,
  type DocPage,
  type DocSection,
  type DocGroup,
} from '@/content/docs/sidebar';

interface DocsSidebarProps {
  locale: Locale;
}

/**
 * Left navigation for the docs site. Rendered by `app/[locale]/docs/layout.tsx`
 * (not by individual page routes) so its `<nav>` DOM node persists across
 * page-to-page navigation — that's what lets the browser keep the sidebar's
 * `scrollTop` when the reader clicks a link near the bottom of the list.
 *
 * Client component so we can:
 *  - Read the active slug from `usePathname()` instead of plumbing it through
 *    the layout (App Router layouts don't see child page params).
 *  - On first mount, scroll the active link into view so deep-link visits
 *    don't land with the highlighted item off-screen.
 *
 * Section shape (driven by `docsSidebar` in `content/docs/sidebar.ts`):
 *  - `pages`: flat list of leaf pages directly under the section heading.
 *  - `groups`: named sub-clusters (`engines`, `git`, `databases`, ...) each
 *    with their own smaller heading. Used inside Agent/Explorer/Console/
 *    Reference where a flat list of ~10 items would be too noisy.
 *
 * Unavailable pages (Markdown file not yet written) render as muted,
 * non-clickable spans with a "Coming soon" badge — surfaces the planned IA
 * without 404ing and doubles as a writer checklist.
 */
export function DocsSidebar({ locale }: DocsSidebarProps) {
  const t = getMessages(locale);
  const pathname = usePathname();

  // pathname is the canonical URL including locale + trailing slash, e.g.
  // "/en/docs/explorer/git/blame/". Strip the leading "/{locale}/docs/" and
  // any trailing slash to reduce it to the bare sidebar slug.
  // When undefined (no router context, edge case), no item is highlighted.
  const currentSlug = pathname
    ? pathname.replace(/^\/[a-z]{2}\/docs\/?/, '').replace(/\/$/, '')
    : undefined;

  // Scroll the active link into view on first mount (and whenever the slug
  // changes due to direct navigation). `block: 'nearest'` avoids scrolling
  // when the item is already visible — a noop if the persisted scrollTop
  // already shows the item, which is the common case for in-app navigation.
  const activeRef = useRef<HTMLAnchorElement | null>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [currentSlug]);

  return (
    <nav
      aria-label={t.docs.title}
      className="docs-sidebar scrollbar-hide w-64 shrink-0 border-r border-border bg-background/40 lg:sticky lg:top-14 lg:h-[calc(100vh-3.5rem)] lg:overflow-y-auto"
    >
      <div className="px-6 py-8 space-y-7">
        {docsSidebar.map((section) => (
          <Section
            key={section.key}
            section={section}
            locale={locale}
            currentSlug={currentSlug}
            activeRef={activeRef}
            comingSoonLabel={t.docs.comingSoon}
            sectionLabel={
              t.docs.sidebar.sections[
                section.key as keyof typeof t.docs.sidebar.sections
              ]
            }
            groupLabels={t.docs.sidebar.groups}
            pageLabels={t.docs.sidebar.pages}
          />
        ))}
      </div>
    </nav>
  );
}

interface SectionProps {
  section: DocSection;
  locale: Locale;
  currentSlug?: string;
  activeRef: React.MutableRefObject<HTMLAnchorElement | null>;
  comingSoonLabel: string;
  sectionLabel: string;
  groupLabels: Record<string, string>;
  pageLabels: Record<string, string>;
}

function Section({
  section,
  locale,
  currentSlug,
  activeRef,
  comingSoonLabel,
  sectionLabel,
  groupLabels,
  pageLabels,
}: SectionProps) {
  return (
    <div>
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
        {sectionLabel}
      </h3>
      {section.pages && section.pages.length > 0 && (
        <ul className="space-y-0.5">
          {section.pages.map((page) => (
            <li key={page.slug}>
              <PageLink
                page={page}
                locale={locale}
                currentSlug={currentSlug}
                activeRef={activeRef}
                comingSoonLabel={comingSoonLabel}
                label={pageLabels[page.labelKey] ?? page.labelKey}
              />
            </li>
          ))}
        </ul>
      )}
      {section.groups?.map((group) => (
        <Group
          key={group.key}
          group={group}
          locale={locale}
          currentSlug={currentSlug}
          activeRef={activeRef}
          comingSoonLabel={comingSoonLabel}
          groupLabel={groupLabels[group.key] ?? group.key}
          pageLabels={pageLabels}
          /* If the section has any flat pages above, the first group gets a
             top margin so it visually detaches from them. Otherwise it sits
             flush under the section heading. */
          spaced={Boolean(section.pages?.length)}
        />
      ))}
    </div>
  );
}

interface GroupProps {
  group: DocGroup;
  locale: Locale;
  currentSlug?: string;
  activeRef: React.MutableRefObject<HTMLAnchorElement | null>;
  comingSoonLabel: string;
  groupLabel: string;
  pageLabels: Record<string, string>;
  spaced: boolean;
}

function Group({
  group,
  locale,
  currentSlug,
  activeRef,
  comingSoonLabel,
  groupLabel,
  pageLabels,
  spaced,
}: GroupProps) {
  return (
    <div className={spaced ? 'mt-4' : ''}>
      <h4 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70 mb-1.5 mt-2 first:mt-0">
        {groupLabel}
      </h4>
      <ul className="space-y-0.5">
        {group.pages.map((page) => (
          <li key={page.slug}>
            <PageLink
              page={page}
              locale={locale}
              currentSlug={currentSlug}
              activeRef={activeRef}
              comingSoonLabel={comingSoonLabel}
              label={pageLabels[page.labelKey] ?? page.labelKey}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

interface PageLinkProps {
  page: DocPage;
  locale: Locale;
  currentSlug?: string;
  activeRef: React.MutableRefObject<HTMLAnchorElement | null>;
  comingSoonLabel: string;
  label: string;
}

function PageLink({
  page,
  locale,
  currentSlug,
  activeRef,
  comingSoonLabel,
  label,
}: PageLinkProps) {
  // Unwritten page — render disabled with a tiny "Coming soon" badge so the
  // sidebar still communicates the planned scope without 404ing.
  if (!page.available) {
    return (
      <span className="flex items-center justify-between rounded px-2 py-1 text-sm text-muted-foreground/60 cursor-not-allowed">
        <span className="truncate">{label}</span>
        <span className="ml-2 shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
          {comingSoonLabel}
        </span>
      </span>
    );
  }

  const isCurrent = currentSlug === page.slug;
  return (
    <Link
      ref={isCurrent ? activeRef : undefined}
      href={docsHref(locale, page.slug)}
      aria-current={isCurrent ? 'page' : undefined}
      className={
        'block rounded px-2 py-1 text-sm transition-colors ' +
        (isCurrent
          ? 'bg-brand/10 text-brand font-medium'
          : 'text-muted-foreground hover:text-foreground hover:bg-accent/40')
      }
    >
      {label}
    </Link>
  );
}
