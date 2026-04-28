import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="min-h-[70vh] flex flex-col items-center justify-center text-center px-6">
      <div className="text-6xl font-bold text-brand">404</div>
      <p className="mt-3 text-muted-foreground">This page does not exist.</p>
      <Link
        href="/"
        className="mt-6 rounded-md border border-border bg-card px-4 py-2 text-sm hover:border-brand/50 transition-colors"
      >
        ← Back to home
      </Link>
    </div>
  );
}
