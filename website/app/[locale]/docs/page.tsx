import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { isLocale, locales, type Locale } from '@/lib/i18n';
import { getMessages } from '@/content/messages';
import { docsHref, getFirstAvailablePage } from '@/content/docs/sidebar';

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = getMessages(locale);
  const url = `https://opencockpit.dev/${locale}/docs/`;
  return {
    title: t.docs.title,
    description: t.docs.description,
    alternates: {
      canonical: url,
      languages: {
        en: 'https://opencockpit.dev/en/docs/',
        zh: 'https://opencockpit.dev/zh/docs/',
        'x-default': 'https://opencockpit.dev/en/docs/',
      },
    },
    openGraph: {
      title: `${t.docs.title} · OpenCockpit`,
      description: t.docs.description,
      url,
      siteName: 'OpenCockpit',
      type: 'website',
      locale: locale === 'zh' ? 'zh_CN' : 'en_US',
      alternateLocale: locale === 'zh' ? ['en_US'] : ['zh_CN'],
      images: [
        { url: '/og.png', width: 1200, height: 630, alt: `${t.docs.title} · OpenCockpit` },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title: `${t.docs.title} · OpenCockpit`,
      description: t.docs.description,
      images: ['/og.png'],
    },
  };
}

/**
 * `/[locale]/docs/` itself has no content — it redirects to the first available
 * page in the sidebar (currently `get-started/introduction`). The redirect is
 * statically generated as an HTML `<meta http-equiv="refresh">` fallback by
 * Next.js' static export, so this works on Cloudflare Pages too.
 */
export default async function DocsIndex({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const first = getFirstAvailablePage();
  if (!first) notFound();
  redirect(docsHref(locale as Locale, first.slug));
}
