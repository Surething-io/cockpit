import type { Metadata, Viewport } from "next";
import { Inter, Lora } from "next/font/google";
import { readFileSync } from "fs";
import { join } from "path";
import { headers } from "next/headers";
import { Effect } from "effect";
import { SETTINGS_FILE, readJsonFile } from "@cockpit/shared-utils";
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

/**
 * The UI language for this render, decided on the server so the first paint is
 * already in it. The client used to start in English and switch only after
 * fetching /api/settings, so every load flashed English before Chinese.
 *
 * Same rule as the client's I18nProvider: an explicit `en` / `zh` setting wins;
 * `auto` (or no setting) follows the browser, read here from Accept-Language,
 * whose first entry is what `navigator.language` reports.
 */
async function resolveInitialLanguage(): Promise<"en" | "zh"> {
  const setting = await Effect.runPromise(
    Effect.tryPromise(() => readJsonFile<{ language?: string }>(SETTINGS_FILE, {})).pipe(
      Effect.map((s) => s.language),
      Effect.orElseSucceed(() => undefined)
    )
  );
  if (setting === "en" || setting === "zh") return setting;
  const accept = (await headers()).get("accept-language") ?? "";
  return accept.trim().toLowerCase().startsWith("zh") ? "zh" : "en";
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const language = await resolveInitialLanguage();
  return (
    <html lang={language === "zh" ? "zh-CN" : "en"} suppressHydrationWarning className="overflow-hidden">
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
        className={`${inter.variable} ${lora.variable} antialiased overflow-hidden`}
      >
        <Providers initialLanguage={language}>
          {children}
        </Providers>
      </body>
    </html>
  );
}
