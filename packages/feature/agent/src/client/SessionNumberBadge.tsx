'use client';

import { sessionNumberClass, type SessionNumberStatus } from '@cockpit/shared-ui';

interface SessionNumberBadgeProps {
  projectNumber?: number | string;
  sessionNumber?: number | string;
  /** The two numbers as one "1.6" string, which is how every sessionNumbers map
   *  stores them. Takes the place of splitting at each call site — that was the
   *  same three-line IIFE copied into every list. Renders nothing when absent,
   *  so callers can pass a lookup straight through. */
  coordinate?: string;
  /** Session state, carried by the round chip only (see the note below). */
  status?: SessionNumberStatus;
  /** Translated name of that state, exposed as the chip's tooltip/aria text —
   *  the colour is the whole label now, so the words have to live somewhere. */
  statusLabel?: string;
  className?: string;
}

/** Narrow the free-form `session.status` string the session lists carry down to
 *  the three states the badge knows about. */
export function badgeStatus(status: string | undefined): SessionNumberStatus {
  return status === 'loading' || status === 'unread' ? status : 'normal';
}

/** Compact navigation coordinates: square project number + circular session
 *  number. Same two shapes and the same wash as the sidebar / tab bar badges
 *  this coordinate points at — it only works as a pointer if it looks like the
 *  thing it names, so the colours come from the shared `sessionNumberClass`
 *  rather than a second hand-written copy of them.
 *
 *  `status` tints the ROUND chip only. Running/unread is a property of the
 *  session, not of the project it sits in, and pulsing both chips together turns
 *  a two-glyph coordinate into one blinking blob you can no longer read as
 *  "project 5, session 1". The square chip therefore always stays idle. */
export function SessionNumberBadge({ projectNumber, sessionNumber, coordinate, status = 'normal', statusLabel, className = '' }: SessionNumberBadgeProps) {
  if (coordinate) {
    const [project, session] = coordinate.split('.');
    projectNumber ??= project;
    sessionNumber ??= session;
  }
  if (projectNumber == null && sessionNumber == null) return null;

  const chipClass = 'flex h-4 w-4 items-center justify-center border';
  const coordinateLabel = [projectNumber, sessionNumber].filter((value) => value != null).join('.');

  return (
    <span
      className={`inline-flex items-center gap-1 font-mono text-[9px] font-medium leading-none tabular-nums flex-shrink-0 ${className}`}
      aria-label={statusLabel ? `${coordinateLabel} · ${statusLabel}` : coordinateLabel}
    >
      {projectNumber != null && (
        <span className={`${chipClass} rounded-[4px] ${sessionNumberClass('normal', false)}`}>{projectNumber}</span>
      )}
      {sessionNumber != null && (
        <span
          className={`${chipClass} rounded-full ${sessionNumberClass(status, false)}`}
          title={statusLabel}
        >
          {sessionNumber}
        </span>
      )}
    </span>
  );
}
