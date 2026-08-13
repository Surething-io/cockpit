'use client';

import { sessionNumberClass } from '@cockpit/shared-ui';

interface SessionNumberBadgeProps {
  projectNumber?: number | string;
  sessionNumber?: number | string;
  /** The two numbers as one "1.6" string, which is how every sessionNumbers map
   *  stores them. Takes the place of splitting at each call site — that was the
   *  same three-line IIFE copied into every list. Renders nothing when absent,
   *  so callers can pass a lookup straight through. */
  coordinate?: string;
  className?: string;
}

/** Compact navigation coordinates: square project number + circular session
 *  number. Same two shapes and the same wash as the sidebar / tab bar badges
 *  this coordinate points at — it only works as a pointer if it looks like the
 *  thing it names, so the colours come from the shared `sessionNumberClass`
 *  rather than a second hand-written copy of them.
 *
 *  Always the idle variant: these lists carry their own per-row status marks,
 *  and a running/unread tint here would say it twice. */
export function SessionNumberBadge({ projectNumber, sessionNumber, coordinate, className = '' }: SessionNumberBadgeProps) {
  if (coordinate) {
    const [project, session] = coordinate.split('.');
    projectNumber ??= project;
    sessionNumber ??= session;
  }
  if (projectNumber == null && sessionNumber == null) return null;

  const chipClass = `flex h-4 w-4 items-center justify-center border ${sessionNumberClass('normal', false)}`;

  return (
    <span
      className={`inline-flex items-center gap-1 font-mono text-[9px] font-medium leading-none tabular-nums flex-shrink-0 ${className}`}
      aria-label={[projectNumber, sessionNumber].filter((value) => value != null).join('.')}
    >
      {projectNumber != null && (
        <span className={`${chipClass} rounded-[4px]`}>{projectNumber}</span>
      )}
      {sessionNumber != null && (
        <span className={`${chipClass} rounded-full`}>{sessionNumber}</span>
      )}
    </span>
  );
}
