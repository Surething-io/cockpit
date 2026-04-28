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
            onClick={() => switchTo(l)}
            className={
              l === locale
                ? 'text-foreground font-medium'
                : 'text-muted-foreground hover:text-foreground transition-colors'
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
