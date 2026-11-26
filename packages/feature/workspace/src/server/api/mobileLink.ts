import { Effect } from 'effect';
import { handler, ok } from '@cockpit/effect-runtime/server';

/**
 * GET /api/mobile-link — the access token a phone needs to open this server.
 *
 * Feeds the top bar's "open on phone" QR code, which encodes `/m?token=…`.
 * Handing the token to the caller discloses nothing new: server.mjs runs the
 * token gate before every route, so a remote caller only gets here by already
 * presenting the token, and loopback callers are exempt from the gate anyway.
 * `null` when token mode is off (`cockpit` started without `--token`).
 */
export const GET = handler(() =>
  Effect.sync(() => ok({ token: process.env.COCKPIT_TOKEN || null })),
);
