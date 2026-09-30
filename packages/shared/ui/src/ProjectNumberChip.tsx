'use client';

import { sessionNumberClass, type SessionNumberStatus } from './sessionNumberStyles';

/**
 * ProjectNumberChip — the rounded-square project number (sessions are round).
 *
 * Drawn by the sidebar project row and by boards that group rows by project
 * (running terminals), so a project reads as the same "1" everywhere.
 */
export function ProjectNumberChip({
  number,
  status = 'normal',
  isActive = false,
}: {
  number: number;
  status?: SessionNumberStatus;
  isActive?: boolean;
}) {
  return (
    <span
      className={`flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded-[4px] border font-mono text-[10px] font-medium leading-none tabular-nums transition-colors ${sessionNumberClass(status, isActive)}`}
      aria-hidden="true"
    >
      {number}
    </span>
  );
}
