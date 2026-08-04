import { Metadata } from 'next';
import { TabManager } from '@cockpit/feature-workspace';

// Disable static pre-rendering; use dynamic rendering (fixes SSR hooks issues)
export const dynamic = 'force-dynamic';

interface ProjectPageProps {
  searchParams: Promise<{ cwd?: string; sessionId?: string; view?: string }>;
}

export async function generateMetadata({ searchParams }: ProjectPageProps): Promise<Metadata> {
  const params = await searchParams;
  const cwd = params.cwd;
  const dirName = cwd?.split('/').filter(Boolean).pop();
  return {
    // Project name only; the installed PWA window already shows the app name
    // from manifest `name` (see Workspace.tsx title update).
    title: dirName || 'Cockpit',
  };
}

export default async function ProjectPage({ searchParams }: ProjectPageProps) {
  const params = await searchParams;
  const { cwd, sessionId, view } = params;
  const initialView = view === 'agent' || view === 'explorer' || view === 'console' ? view : undefined;

  return <TabManager initialCwd={cwd} initialSessionId={sessionId} initialView={initialView} />;
}
