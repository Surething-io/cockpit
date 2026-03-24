import { Metadata } from 'next';
import { TabManager } from '@/components/project/TabManager';

// Disable static pre-rendering; use dynamic rendering (fixes SSR hooks issues)
export const dynamic = 'force-dynamic';

interface ProjectPageProps {
  searchParams: Promise<{ cwd?: string; sessionId?: string }>;
}

export async function generateMetadata({ searchParams }: ProjectPageProps): Promise<Metadata> {
  const params = await searchParams;
  const cwd = params.cwd;
  const dirName = cwd?.split('/').filter(Boolean).pop();
  return {
    title: dirName ? `Cockpit - ${dirName}` : 'Cockpit',
  };
}

export default async function ProjectPage({ searchParams }: ProjectPageProps) {
  const params = await searchParams;
  const { cwd, sessionId } = params;

  return <TabManager initialCwd={cwd} initialSessionId={sessionId} />;
}
