import { Metadata } from 'next';
import MobileClient from './MobileClient';

// Disable static pre-rendering; use dynamic rendering (mirrors the root page).
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Cockpit',
};

interface MobilePageProps {
  searchParams: Promise<{ cwd?: string; sessionId?: string }>;
}

export default async function MobilePage({ searchParams }: MobilePageProps) {
  const { cwd, sessionId } = await searchParams;
  return <MobileClient initialCwd={cwd} initialSessionId={sessionId} />;
}
