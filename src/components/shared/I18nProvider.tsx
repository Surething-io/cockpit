'use client';

import { useEffect } from 'react';
import { I18nextProvider } from 'react-i18next';
import i18n from '@/lib/i18n';

interface I18nProviderProps {
  children: React.ReactNode;
}

/** Broadcast language change to all child iframes */
function broadcastToIframes(lang: string) {
  const iframes = document.querySelectorAll('iframe');
  for (const iframe of iframes) {
    try {
      iframe.contentWindow?.postMessage({ type: 'cockpit:language-change', lang }, '*');
    } catch { /* cross-origin, ignore */ }
  }
}

/** Resolve effective language: 'auto' → browser detection, otherwise use as-is */
function resolveLanguage(setting: string): string {
  if (setting === 'auto' || !setting) {
    return navigator.language.startsWith('zh') ? 'zh' : 'en';
  }
  return setting;
}

export function I18nProvider({ children }: I18nProviderProps) {
  // Fetch language from backend on mount, then apply
  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then(data => {
        const lang = resolveLanguage(data.language || 'auto');
        if (i18n.language !== lang) {
          i18n.changeLanguage(lang);
        }
      })
      .catch(() => {
        // Fallback: use browser language
        const lang = resolveLanguage('auto');
        if (i18n.language !== lang) {
          i18n.changeLanguage(lang);
        }
      });
  }, []);

  // When language changes, broadcast to all iframes
  useEffect(() => {
    const handler = (lang: string) => broadcastToIframes(lang);
    i18n.on('languageChanged', handler);
    return () => { i18n.off('languageChanged', handler); };
  }, []);

  // Listen for language change from parent window (when this page is inside an iframe)
  useEffect(() => {
    if (window === window.parent) return;
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'cockpit:language-change' && e.data.lang) {
        if (i18n.language !== e.data.lang) {
          i18n.changeLanguage(e.data.lang);
        }
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  return (
    <I18nextProvider i18n={i18n}>
      {children}
    </I18nextProvider>
  );
}
