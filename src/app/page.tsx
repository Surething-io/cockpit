import { TabManager } from '@/components/TabManager';

interface HomeProps {
  searchParams: Promise<{ cwd?: string; sessionId?: string }>;
}

export default async function Home({ searchParams }: HomeProps) {
  const params = await searchParams;
  const { cwd, sessionId } = params;

  return <TabManager initialCwd={cwd} initialSessionId={sessionId} />;
}
