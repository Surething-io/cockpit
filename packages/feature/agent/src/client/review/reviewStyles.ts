import type { VerificationState } from '@cockpit/feature-decisions';

/** Colour of a verification state badge. */
export const STATE_STYLE: Record<VerificationState, string> = {
  verified: 'text-green-11',
  failed: 'text-red-11',
  'needs-rerun': 'text-amber-11',
  'no-tests': 'text-amber-11',
  unknown: 'text-muted-foreground',
  running: 'text-muted-foreground',
  unverified: 'text-amber-11',
  claimed: 'text-red-11',
};

