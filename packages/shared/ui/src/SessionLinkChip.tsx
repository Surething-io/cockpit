import type { MouseEventHandler } from 'react';
import type { SessionLinkTarget } from '@cockpit/shared-utils/sessionLink';

/**
 * A Cockpit session link shown as a chip with the short session id; the full
 * cwd + id live in the tooltip. The raw URL is three lines of percent-encoding.
 * Icon is lucide's message-square as inline SVG: MarkdownRenderer renders this
 * and is also bundled into the standalone /html-lib/markdown.js.
 */
export function SessionLinkChip({
  href,
  target,
  onClick,
  newTab = false,
}: {
  href: string;
  target: SessionLinkTarget;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  /** Fall back to a new tab when the host does not consume the click. */
  newTab?: boolean;
}) {
  return (
    <a
      href={href}
      title={`${target.cwd}\n${target.sessionId}`}
      className="inline-flex items-center gap-1 px-1.5 rounded bg-brand/10 hover:bg-brand/20 text-brand font-mono text-[0.9em] align-baseline whitespace-nowrap no-underline"
      onClick={onClick}
      {...(newTab ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
    >
      <svg
        className="w-3 h-3 shrink-0"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      {target.sessionId.slice(0, 8)}
    </a>
  );
}
