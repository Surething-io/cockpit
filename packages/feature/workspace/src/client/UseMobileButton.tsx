'use client';

import React, { useEffect, useState } from 'react';
import { Smartphone } from 'lucide-react';
import { useTranslation } from 'react-i18next';

// Same breakpoint boot.js uses to send narrow viewports to /m.
const NARROW_QUERY = '(max-width: 767px)';

/**
 * Way back to the mobile route for a narrow window showing the desktop
 * workspace — reached through /m's "Desktop" action, which also stops boot.js
 * from redirecting here. Landing on /m clears that choice (see boot.js).
 * The current query carries cwd + sessionId, which /m opens directly.
 */
export function UseMobileButton() {
  const { t } = useTranslation();
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(NARROW_QUERY);
    const sync = () => setNarrow(mql.matches);
    sync();
    mql.addEventListener('change', sync);
    return () => mql.removeEventListener('change', sync);
  }, []);

  if (!narrow) return null;

  return (
    <button
      type="button"
      onClick={() => window.location.assign('/m' + window.location.search)}
      className="fixed bottom-4 right-4 z-40 flex items-center gap-1.5 rounded-full border border-border bg-popover px-3 py-2 text-sm text-foreground shadow-lv2 active:bg-active"
    >
      <Smartphone className="h-4 w-4" />
      {t('mobile.useMobile')}
    </button>
  );
}
