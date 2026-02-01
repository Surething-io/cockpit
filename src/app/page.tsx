import { Metadata } from 'next';
import { TabManager } from '@/components/TabManager';

interface HomeProps {
  searchParams: Promise<{ cwd?: string; sessionId?: string }>;
}

export async function generateMetadata({ searchParams }: HomeProps): Promise<Metadata> {
  const params = await searchParams;
  const cwd = params.cwd;
  const dirName = cwd?.split('/').filter(Boolean).pop();
  return {
    title: dirName ? `Cockpit - ${dirName}` : 'Cockpit',
  };
}

export default async function Home({ searchParams }: HomeProps) {
  const params = await searchParams;
  const { cwd, sessionId } = params;

  return <TabManager initialCwd={cwd} initialSessionId={sessionId} />;
}
