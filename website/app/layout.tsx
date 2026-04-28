import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://cocking.cc'),
  title: {
    default: 'Cockpit — The Cockpit That Drives AI',
    template: '%s | Cockpit',
  },
  description:
    'A unified development cockpit built on Claude Code (Agent SDK) — chat, code, terminal, browser, database all in one interface.',
  icons: {
    icon: '/icons/icon-128x128.png',
    apple: '/icons/icon-128x128.png',
  },
  openGraph: {
    title: 'Cockpit — The Cockpit That Drives AI',
    description: 'One seat. One AI. Everything under control.',
    url: 'https://cocking.cc',
    siteName: 'Cockpit',
    images: ['/icons/icon-128x128.png'],
    locale: 'en_US',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Cockpit — The Cockpit That Drives AI',
    description: 'One seat. One AI. Everything under control.',
    images: ['/icons/icon-128x128.png'],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-background text-foreground antialiased">
        {children}
      </body>
    </html>
  );
}
