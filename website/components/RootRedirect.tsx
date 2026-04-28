'use client';

import { useEffect } from 'react';

/**
 * Client-side redirect for the root path. Falls back here only when the
 * Cloudflare Pages Function isn't available (local dev, or edge failure).
 */
export function RootRedirect() {
  useEffect(() => {
    // Read remembered preference first
    const cookie = document.cookie
      .split('; ')
      .find((row) => row.startsWith('lang_pref='));
    const pref = cookie?.split('=')[1];

    let target: 'en' | 'zh' = 'en';
    if (pref === 'zh' || pref === 'en') {
      target = pref;
    } else if (typeof navigator !== 'undefined') {
      const lang = (navigator.language || '').toLowerCase();
      if (lang.startsWith('zh')) target = 'zh';
    }

    // Persist for next time
    document.cookie = `lang_pref=${target}; path=/; max-age=31536000; SameSite=Lax`;
    window.location.replace(`/${target}/`);
  }, []);

  return <span className="text-sm">Redirecting…</span>;
}
