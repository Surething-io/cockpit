#!/usr/bin/env node
/**
 * `cockpit` — full-name alias for the legacy `cock` command.
 *
 * Both binaries point at the same logic: this file just re-imports `cock.mjs`,
 * which executes its top-level CLI on load. Keeping a single source of truth
 * means new subcommands / flags only need to land in cock.mjs.
 *
 * Why we ship both:
 * - `cock` was the original short alias (kept for muscle memory + back-compat).
 * - `cockpit` is the public-facing name we now use in docs, examples, blog
 *   posts, and screenshots — easier to share in chat / Slack / talks.
 */
import './cock.mjs';
