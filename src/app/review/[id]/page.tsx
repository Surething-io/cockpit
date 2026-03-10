import { Metadata } from 'next';
import { ReviewPage } from '@/components/review/ReviewPage';

export const dynamic = 'force-dynamic';

interface ReviewPageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: ReviewPageProps): Promise<Metadata> {
  const { id } = await params;
  return {
    title: `Review - ${id}`,
  };
}

export default async function ReviewRoute({ params }: ReviewPageProps) {
  const { id } = await params;
  return <ReviewPage reviewId={id} />;
}
