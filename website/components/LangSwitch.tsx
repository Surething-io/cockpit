'use client';

import { usePathname, useRouter } from 'next/navigation';
import { locales, type Locale } from '@/lib/i18n';

export function LangSwitch({ locale }: { locale: Locale }) {
  const router = useRouter();
  const pathname = usePathname();

  function switchTo(target: Locale) {
    if (target === locale) return;
    // Persist preference so future visits to / respect this choice
    document.cookie = `lang_pref=${target}; path=/; max-age=31536000; SameSite=Lax`;

    // Swap the leading /<locale>/ segment in the current path
    const segments = pathname.split('/').filter(Boolean);
    if (segments[0] === 'en' || segments[0] === 'zh') {
      segments[0] = target;
    } else {
      segments.unshift(target);
    }
    router.push('/' + segments.join('/') + '/');
  }

  return (
    <div className="flex items-center gap-1 text-xs">
      {locales.map((l, i) => (
        <span key={l} className="flex items-center">
          {i > 0 && <span className="mx-1 text-slate-7">·</span>}
          <button
            type="button"
            onClick={() => switchTo(l)}
            className={
              // px/py rather than a bare text node: at 16x16 these were the
              // smallest targets on the page, below the WCAG 2.5.8 AA minimum.
              'inline-flex items-center px-1.5 py-3 ' +
              (l === locale
                ? 'font-medium text-foreground'
                : 'text-muted-foreground transition-colors hover:text-foreground')
            }
            aria-current={l === locale ? 'true' : 'false'}
          >
            {l === 'en' ? 'EN' : '中文'}
          </button>
        </span>
      ))}
    </div>
  );
}
