import type { Metadata, Viewport } from "next";
import { Inter, Lora, JetBrains_Mono } from "next/font/google";
import { readFileSync } from "fs";
import { join } from "path";
import "./globals.css";
import { BootstrapScripts, Providers } from "@cockpit/feature-workspace";

// BootstrapScripts inserts boot.js into the initial HTML stream so it executes
// before hydration without creating script elements during client renders.
// Read once at module load. After editing public/boot.js in dev, edit/save this file so the
// module re-evaluates and re-reads the script (mtime-only touches don't bust
// Turbopack's cache).
let bootScript = "";
try {
  bootScript = readFileSync(join(process.cwd(), "public", "boot.js"), "utf8");
} catch {
  // Degrade gracefully: if the file can't be read (e.g. server launched from an
  // unexpected cwd), the app still renders — theme/redirect just won't pre-run —
  // instead of crashing the entire root layout.
}

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
  title: "OpenCockpit",
  description: "OpenCockpit is a local-first AI development hub with chat agents, a file explorer, terminals, and browser bubbles in one swipeable workspace. One seat. One AI.",
  // Manifest is served by app/manifest.ts at /manifest.webmanifest and linked
  // automatically by Next — don't point at a stale /manifest.json (404).
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
         * Stamp the build this HTML was served from. After an upgrade the
         * server restarts with a new BUILD_ID, but an already-open tab keeps
         * referencing the previous build's content-hashed chunks — which no
         * longer exist on disk — so the next route change or lazy import 404s.
         * useServerBuildGuard compares this against /api/health on reconnect.
         *
         * COCKPIT_BUILD_ID is set by server.mjs at boot. Absent in dev (no
         * prebuilt BUILD_ID), where the guard simply stays off.
         */}
        {/*
         * COCKPIT_FORCE_UPDATE_BADGE=1 makes the sidebar show the update pill
         * even when already on the latest version, so the whole update flow can
         * be exercised on a real production install. The existing dev-only
         * override cannot be used for that: /api/update refuses to run in dev
         * mode (npm would install the published package over a source tree).
         */}
        <BootstrapScripts
          bootScript={bootScript}
          buildId={process.env.COCKPIT_BUILD_ID ?? null}
          forceUpdate={process.env.COCKPIT_FORCE_UPDATE_BADGE === "1"}
        />
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
