import { Metadata } from 'next';
import { Workspace } from '@/components/workspace';

// 禁用静态预渲染，改为动态渲染
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Cockpit',
};

export default function Home() {
  return <Workspace />;
}
