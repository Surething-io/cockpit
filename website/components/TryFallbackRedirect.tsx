'use client';

import { useEffect, useState } from 'react';

/**
 * Used by app/try/page.tsx as a graceful fallback when the Cloudflare
 * Pages Function isn't available (dev mode or edge failure).
 *
 * In production with the Function deployed, this component is never rendered
 * because Cloudflare's _routes.json routes /try to the Function before the
 * static HTML is served.
 */
export function TryFallbackRedirect() {
  const [error, setError] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        window.location.replace('https://e2b-nu.vercel.app/api/try');
      } catch {
        setError(true);
      }
    }, 50);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="text-muted-foreground text-sm">
      {error ? (
        <a href="https://e2b-nu.vercel.app/api/try" className="text-brand underline">
          Continue to demo →
        </a>
      ) : (
        <span>Loading demo…</span>
      )}
    </div>
  );
}
