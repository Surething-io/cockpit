import { Metadata } from 'next';
import { Workspace } from '@/components/workspace';

// 禁用静态预渲染，改为动态渲染
export const dynamic = 'force-dynamic';

interface HomePageProps {
  searchParams: Promise<{ cwd?: string; sessionId?: string }>;
}

export async function generateMetadata({ searchParams }: HomePageProps): Promise<Metadata> {
  const params = await searchParams;
  const cwd = params.cwd;
  const dirName = cwd?.split('/').filter(Boolean).pop();
  return {
    title: dirName ? `Cockpit - ${dirName}` : 'Cockpit',
  };
}

export default async function Home({ searchParams }: HomePageProps) {
  const params = await searchParams;
  const { cwd, sessionId } = params;

  return <Workspace initialCwd={cwd} initialSessionId={sessionId} />;
}
