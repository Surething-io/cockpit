'use client';

/**
 * useLatestVersion — surfaces "is there a newer @surething/cockpit on npm?"
 * to UI badges (currently the version pill in the Settings row).
 *
 * Why client-side, not server-side:
 *  - One query per browser session is cheap (npm registry has a global CDN
 *    cache; even 100k clients is trivial).
 *  - No new server endpoint, no WebSocket push, no backend cron — KISS.
 *  - The user's machine is the one that would run `cockpit update`, so the
 *    network reachability check happens on the right side.
 *
 * What it does on mount:
 *  1. Pulls the running server's version from `/api/version` (the same
 *     endpoint SettingsModal uses).
 *  2. Pulls `latest` from `https://registry.npmjs.org/@surething/cockpit/latest`.
 *  3. Compares the two with a simple numeric semver-major.minor.patch
 *     compare. Pre-release tags are intentionally ignored — we only want
 *     to nudge users to stable releases.
 *
 * Failure modes are silent: registry timeouts, offline, npm 5xx → returns
 * `hasUpdate: false`. The badge stays hidden, no error toast — an update
 * nudge is a nice-to-have, not a blocker.
 */

import { useEffect, useState } from 'react';
import { Effect } from 'effect';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { loadCockpitVersion } from './effect/workspaceClient';

const NPM_REGISTRY_URL =
  'https://registry.npmjs.org/@surething/cockpit/latest';

// 3-second timeout — registry is almost always sub-200ms when reachable;
// anything longer is offline / blocked and we'd rather silently bail than
// hold the badge in a "checking…" state.
const FETCH_TIMEOUT_MS = 3000;

export interface LatestVersionInfo {
  /** Version currently running (from `/api/version`). undefined while loading. */
  current?: string;
  /** Latest version on npm. undefined while loading or on failure. */
  latest?: string;
  /** True when `latest > current` by semver-ish numeric compare. */
  hasUpdate: boolean;
}

/** Compare two `1.2.3`-style version strings numerically. Strips a leading
 *  `v`, ignores pre-release suffixes (`-rc.1`, `-beta.2`, …). Returns
 *  positive when `a > b`, negative when `a < b`, 0 when equal. */
function compareVersions(a: string, b: string): number {
  const norm = (s: string) =>
    s.replace(/^v/, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const aParts = norm(a);
  const bParts = norm(b);
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const av = aParts[i] ?? 0;
    const bv = bParts[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

export function useLatestVersion(): LatestVersionInfo {
  const [current, setCurrent] = useState<string | undefined>();
  const [latest, setLatest] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;

    // Current version — reuse the existing Effect helper.
    BrowserRuntime.runPromiseExit(loadCockpitVersion()).then((exit) => {
      if (cancelled) return;
      if (exit._tag === 'Success' && exit.value.version) {
        setCurrent(exit.value.version);
      }
    });

    // Latest version from npm registry. Plain fetch with manual abort —
    // we don't want this in the Effect layer because failure is expected
    // (offline, blocked corporate proxies) and we silently ignore it.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    fetch(NPM_REGISTRY_URL, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        const v = (data as { version?: string } | null)?.version;
        if (typeof v === 'string') setLatest(v);
      })
      .catch(() => {
        /* offline / blocked / timeout — stay quiet, badge will hide */
      })
      .finally(() => clearTimeout(timeoutId));

    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timeoutId);
    };
  }, []);

  // DEV-ONLY OVERRIDE: in non-production builds always pretend an update
  // is available so the version-pill + popover UI can be eyeballed without
  // waiting for a real npm publish. If `latest` is still being fetched,
  // fall back to a clearly-fake placeholder so the pill renders with a
  // visible string. The first real registry response will replace it.
  const isDevPreview = process.env.NODE_ENV !== 'production';
  const realHasUpdate =
    !!current && !!latest && compareVersions(latest, current) > 0;
  const hasUpdate = isDevPreview ? true : realHasUpdate;
  const exposedLatest = isDevPreview ? (latest ?? '999.0.0') : latest;

  return { current, latest: exposedLatest, hasUpdate };
}

// Exported for test use only — not part of the public hook surface.
export { compareVersions as __compareVersionsForTest };
