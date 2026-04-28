'use client';

import { useEffect } from 'react';
import type { Locale } from '@/lib/i18n';

/**
 * Syncs <html lang> with the current locale on the client.
 * The static HTML always ships with lang="en"; this updates it for /zh/* pages
 * for accessibility and screen readers.
 */
export function LocaleSync({ locale }: { locale: Locale }) {
  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
  }, [locale]);
  return null;
}
