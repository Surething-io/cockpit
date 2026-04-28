'use client';

// Minimal global error boundary for Next.js — must include <html> and <body>.
// Kept hook-free so static export prerender doesn't choke on React context.
export default function GlobalError() {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: 'system-ui, sans-serif',
          padding: '2rem',
          color: '#1e2328',
          background: '#fafafa',
        }}
      >
        <h1 style={{ fontSize: '1.5rem', fontWeight: 600 }}>Something went wrong</h1>
        <p style={{ marginTop: '0.5rem', color: '#666' }}>
          An unexpected error occurred. Please refresh or try again later.
        </p>
        <a
          href="/"
          style={{
            marginTop: '1rem',
            display: 'inline-block',
            color: '#3a7472',
            textDecoration: 'underline',
          }}
        >
          ← Back to home
        </a>
      </body>
    </html>
  );
}
