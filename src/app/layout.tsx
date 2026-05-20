import type { Metadata, Viewport } from "next";
import { Inter, Lora, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "@cockpit/feature-workspace";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const lora = Lora({
  variable: "--font-lora",
  subsets: ["latin"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Cockpit",
  description: "Cockpit is a local-first AI development hub with chat agents, a file explorer, terminals, and browser bubbles in one swipeable workspace. One seat. One AI.",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Cockpit",
  },
  icons: {
    icon: "/icons/icon-192x192.png",
    apple: "/icons/icon-192x192.png",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f9f9fb" },
    { media: "(prefers-color-scheme: dark)", color: "#111113" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning className="overflow-hidden">
      <head>
        {/*
         * boot.js — runs synchronously before React hydrates.
         * Two jobs: apply persisted theme class to avoid FOUC, and clean up
         * leftover Service Workers from the PWA era.
         *
         * Placed in <head> (NOT in <body>) because React 19 warns when scripts
         * are rendered inside the React tree — they would not be re-executed
         * during client hydration. We only need this script to run once on the
         * initial HTML parse, which is exactly what a <head><script> tag does.
         *
         * Must be a synchronous <script> (not next/script) because:
         *   - The theme class has to be applied *before* hydration, otherwise FOUC.
         *   - next/script's `beforeInteractive` is not supported in layout.tsx,
         *     so we use a bare <script> tag.
         * This is why `@next/next/no-sync-scripts` is disabled here.
         */}
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        <script src="/boot.js" />
      </head>
      <body
        className={`${inter.variable} ${lora.variable} ${jetbrainsMono.variable} antialiased overflow-hidden`}
      >
        <Providers>
          {children}
        </Providers>
      </body>
    </html>
  );
}
