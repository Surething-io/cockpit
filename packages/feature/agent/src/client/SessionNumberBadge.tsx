'use client';

interface SessionNumberBadgeProps {
  projectNumber?: number | string;
  sessionNumber?: number | string;
  className?: string;
}

/** Compact navigation coordinates: square project number + circular session number. */
export function SessionNumberBadge({ projectNumber, sessionNumber, className = '' }: SessionNumberBadgeProps) {
  if (projectNumber == null && sessionNumber == null) return null;

  return (
    <span
      className={`inline-flex items-center gap-1 font-mono text-[9px] font-medium leading-none tabular-nums flex-shrink-0 ${className}`}
      aria-label={[projectNumber, sessionNumber].filter((value) => value != null).join('.')}
    >
      {projectNumber != null && (
        <span className="flex h-4 w-4 items-center justify-center rounded-[4px] border border-muted-foreground/50 bg-muted/20 text-muted-foreground">
          {projectNumber}
        </span>
      )}
      {sessionNumber != null && (
        <span className="flex h-4 w-4 items-center justify-center rounded-full border border-muted-foreground/50 bg-muted/20 text-muted-foreground">
          {sessionNumber}
        </span>
      )}
    </span>
  );
}
